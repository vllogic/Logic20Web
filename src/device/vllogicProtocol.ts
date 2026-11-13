// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VLLogic driver authors
// Copyright (C) 2026 vllogic.com
/**
 * VLLogic "Logic20" UHSIF v2.2 wire protocol.
 *
 * This module is deliberately free of WebUSB, DOM and UI types: the parser and the
 * command builders are exercised by the offline self-test with synthetic streams, and
 * the device layer only adds the transport. The protocol matches the libsigrok driver
 * in `libsigrok/src/hardware/vllogic-logic/` (protocol.c / uhsif_rx.c).
 *
 * Upstream frame:
 *
 *   16-byte block header (4 x u32 LE)
 *     W0 = crc16 << 16 | 0x6CC6
 *     W1 = channel mask (20 bits)
 *     W2 = pwm1 | div << 15 | drop << 22 | capturing << 23 | lut_check << 24
 *     W3 = pwm0 | vco << 8 | mode << 10 | payload_len << 12 | seq << 24
 *   payload_len 32-bit payload words, in [120, 4092] (a block body is 4 x that many bytes)
 *
 * Payload words are **channel-major**: one word per enabled physical lane, in
 * ascending physical-lane order. Each word holds 32 consecutive samples of that lane
 * (bit 0 = first sample). One complete snapshot is `nchan` words = 32 sample instants.
 */

/** USB identity. The Logic20 is bcdDevice 0x0820; the older Sniffer2 is 0x0602. */
export const VLLOGIC_VID = 0x1209;
export const VLLOGIC_PID = 0x6688;
export const VLLOGIC_BCD_LOGIC20 = 0x0820;
export const VLLOGIC_PRODUCT = 'Logic20';
export const VLLOGIC_IFACE = 0;
/** Descriptor endpoint addresses (include the direction bit). */
export const VLLOGIC_EP_OUT_ADDR = 0x01;
export const VLLOGIC_EP_IN_ADDR = 0x81;
/**
 * WebUSB transferIn()/transferOut() take the endpoint NUMBER, not the address. Both
 * pipes are endpoint 1; only the direction bit differs.
 */
export const VLLOGIC_EP_OUT = 1;
export const VLLOGIC_EP_IN = 1;

export const VLLOGIC_NUM_CHANNELS = 20;
/** ISERDES sample clock. Output rate is CLOCK_HZ / div. */
export const VLLOGIC_CLOCK_HZ = 2_400_000_000;
export const VLLOGIC_DIV_MIN = 2;
export const VLLOGIC_DIV_MAX = 120;

/** UHSIF command frame / block header sizes. */
export const UHSIF_CMD_SIZE = 16;
export const UHSIF_HDR_SIZE = 16;
/** The payload length field counts 32-bit words, not bytes (uhsif.v, uhsif_rx.c). */
export const UHSIF_CMD_MAGIC16 = 0xC7F3;
export const UHSIF_BLK_MAGIC16 = 0x6CC6;
export const UHSIF_PAY_MIN = 120;
export const UHSIF_PAY_MAX = 4092;
export const UHSIF_DEFAULT_PAYLOAD = 4092;

/** Downstream command numbers (word 1 of a command frame). */
export const enum UhsifCmd {
  Ping = 0x00,
  Start = 0x01,
  Stop = 0x02,
  Flush = 0x03,
  ModeNormal = 0x04,
  ModeWave = 0x05,
  ModeCounter = 0x06,
  ChannelMask = 0x10,
  IserdesDiv = 0x20,
  Vco = 0x21,
  MaxPayload = 0x22,
  VbiasPwm0 = 0x30,
  VbiasPwm1 = 0x31,
  Lut0 = 0x40,
}

/**
 * Logical connector channel -> physical ISERDES lane. Pairs 0..15 are swapped; the
 * four high lanes are straight through. Source: la_recv.c CHANNEL_PERM.
 */
export const VLLOGIC_CHANNEL_PERM: readonly number[] = [
  1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10, 13, 12, 15, 14, 16, 17, 18, 19,
];

/**
 * The rates the driver offers without host-side decimation. The lower entries
 * (2.5/5/10 MHz) use div 120 plus a PC decimation factor; the browser path starts
 * with the div-only table and can add decimation later without changing the wire
 * protocol.
 */
export interface VllogicRate {
  readonly rate: number;
  readonly div: number;
}

export const VLLOGIC_RATES: readonly VllogicRate[] = [
  { rate: 20_000_000, div: 120 },
  { rate: 40_000_000, div: 60 },
  { rate: 80_000_000, div: 30 },
  // 100 MHz is not in the libsigrok table (which jumps 80 -> 160), but div 24 is a
  // legal ISERDES divider and the 250 MB/s it needs at 20 lanes is a useful half-way
  // point between the 20-lane 160 MHz ceiling and the 80 MHz default.
  { rate: 100_000_000, div: 24 },
  { rate: 160_000_000, div: 15 },
  { rate: 200_000_000, div: 12 },
  { rate: 400_000_000, div: 6 },
  { rate: 800_000_000, div: 3 },
  { rate: 1_200_000_000, div: 2 },
];

/**
 * Comparator presets shown in the UI. The comparator accepts the measured -2.5..+5.0 V
 * interval; these are the common logic-family points plus the measured endpoints.
 */
export const VLLOGIC_THRESHOLD_PRESETS: readonly number[] = [
  -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.2, 1.65, 2, 2.5, 3.3, 5,
];

/** Applies the device's own per-rate channel ceiling (see vllogic_max_channels()). */
export function vllogicMaxChannels(rate: number): number {
  if (rate > 800_000_000) return 2;
  if (rate > 400_000_000) return 4;
  if (rate > 200_000_000) return 8;
  if (rate > 160_000_000) return 16;
  return VLLOGIC_NUM_CHANNELS;
}

/** The exact div entry for a rate, or null when the table does not offer it. */
export function vllogicDivForRate(rate: number): number | null {
  const entry = VLLOGIC_RATES.find((candidate) => candidate.rate === rate);
  return entry ? entry.div : null;
}

/** The table's exact rate for a div, or null. */
export function vllogicRateForDiv(div: number): number | null {
  const entry = VLLOGIC_RATES.find((candidate) => candidate.div === div);
  return entry ? entry.rate : null;
}

/** CRC-16/CCITT-FALSE over W1..W3's 12 on-wire bytes (poly 0x1021, init 0xFFFF). */
export function vllogicCrc16(w1: number, w2: number, w3: number): number {
  const words = [w1, w2, w3];
  let crc = 0xFFFF;
  for (let i = 0; i < 12; i++) {
    const byte = (words[i >> 2]! >>> ((i & 3) * 8)) & 0xFF;
    crc ^= byte << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

/** Build one 16-byte downstream command frame. */
export function vllogicBuildCommand(cmd: UhsifCmd, param: number): Uint8Array {
  const w0 = ((vllogicCrc16(cmd, param, 0) << 16) | UHSIF_CMD_MAGIC16) >>> 0;
  const out = new Uint8Array(UHSIF_CMD_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, w0, true);
  view.setUint32(4, cmd >>> 0, true);
  view.setUint32(8, param >>> 0, true);
  view.setUint32(12, 0, true);
  return out;
}

/**
 * Build the 32 x 5-bit "next enabled physical lane" ring. The FPGA resets the LUT to
 * all zeroes, so a non-ascending ring would repeat lane 0 in every snapshot.
 */
export function vllogicBuildLut(mask: number): Uint32Array {
  const raw = new Uint8Array(20);
  const next = new Uint8Array(32);
  const enabled: number[] = [];
  for (let ch = 0; ch < VLLOGIC_NUM_CHANNELS; ch++) {
    if (mask & (1 << ch)) enabled.push(ch);
  }
  if (enabled.length === 0) return new Uint32Array(5);
  for (let i = 0; i + 1 < enabled.length; i++) next[enabled[i]!] = enabled[i + 1]!;
  next[enabled[enabled.length - 1]!] = enabled[0]!;

  for (let entry = 0; entry < 32; entry++) {
    const value = next[entry]! & 0x1F;
    const bitPos = entry * 5;
    const byteIdx = bitPos >> 3;
    const bitOff = bitPos & 7;
    raw[byteIdx] = raw[byteIdx]! | ((value << bitOff) & 0xFF);
    if (bitOff > 3 && byteIdx + 1 < 20) {
      raw[byteIdx + 1] = raw[byteIdx + 1]! | (value >>> (8 - bitOff));
    }
  }
  const out = new Uint32Array(5);
  const view = new DataView(raw.buffer);
  for (let i = 0; i < 5; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

/** One frame's channel mapping: logical channel -> ascending physical lane order. */
export interface VllogicChannelMap {
  /** Physical lane bitmask sent in CHANNEL_MASK and checked in every block header. */
  readonly mask: number;
  /** Logical channels in the order the caller enabled them. */
  readonly logical: readonly number[];
  /** Ascending physical lanes; payload word i belongs to physList[i]. */
  readonly physList: readonly number[];
  /** Physical lane -> logical channel, -1 for a lane not in this capture. */
  readonly phys2log: Int8Array;
  /** Number of words per snapshot. */
  readonly nchan: number;
  /** Bytes per interleaved sample (ceil(maxLogical / 8)), for `.sr`/trigger buffers. */
  readonly unitsize: number;
}

/**
 * Map enabled logical channels onto physical lanes. The payload order is ascending
 * physical lane, not the caller's order, which is why physList/phys2log are explicit.
 */
export function vllogicMapBuild(logical: readonly number[]): VllogicChannelMap {
  if (logical.length === 0 || logical.length > VLLOGIC_NUM_CHANNELS) {
    throw new Error(`a VLLogic capture needs 1..${VLLOGIC_NUM_CHANNELS} channels, got ${logical.length}`);
  }
  const phys2log = new Int8Array(VLLOGIC_NUM_CHANNELS).fill(-1);
  let mask = 0;
  let maxLogical = -1;
  for (const ch of logical) {
    if (!Number.isInteger(ch) || ch < 0 || ch >= VLLOGIC_NUM_CHANNELS) {
      throw new Error(`logical channel ${ch} is outside 0..${VLLOGIC_NUM_CHANNELS - 1}`);
    }
    const phys = VLLOGIC_CHANNEL_PERM[ch]!;
    if (mask & (1 << phys)) throw new Error(`logical channel ${ch} duplicates a physical lane`);
    mask |= 1 << phys;
    if (ch > maxLogical) maxLogical = ch;
  }
  const physList: number[] = [];
  for (let phys = 0; phys < VLLOGIC_NUM_CHANNELS; phys++) {
    if (!(mask & (1 << phys))) continue;
    physList.push(phys);
    phys2log[phys] = logical.find((ch) => VLLOGIC_CHANNEL_PERM[ch] === phys) ?? -1;
    if (phys2log[phys]! < 0) throw new Error(`physical lane ${phys} has no logical channel`);
  }
  return {
    mask,
    logical: [...logical],
    physList,
    phys2log,
    nchan: physList.length,
    unitsize: Math.floor(maxLogical / 8) + 1,
  };
}

/**
 * Measured comparator threshold model (calibrated 2026-10):
 *   Vth = 2.405 - 0.0402 * pwm0 + 0.0216 * pwm1  [V]
 * The inverse follows the driver, including the sign/feasibility fallback.
 */
export function vllogicThresholdToPwm(vth: number): { pwm0: number; pwm1: number } | null {
  const a = (2.405 - vth) / 0.0402;
  const b = (vth - 2.405) / 0.0216;
  const va = pwmRound(a);
  const vb = pwmRound(b);
  let primary: number | null;
  let fallback: number | null;
  let useA: boolean;
  if (vth >= 0) {
    primary = va;
    fallback = vb;
    useA = true;
  } else {
    primary = vb;
    fallback = va;
    useA = false;
  }
  if (primary === null) {
    if (fallback === null) return null;
    primary = fallback;
    useA = !useA;
  }
  return useA ? { pwm0: primary, pwm1: 0 } : { pwm0: 0, pwm1: primary };
}

function pwmRound(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < -0.5 || value >= 255.5) return null;
  return Math.floor(value + 0.5);
}

/** The nominal voltage the two PWM values produce, for read-back in diagnostics. */
export function vllogicPwmToThreshold(pwm0: number, pwm1: number): number {
  return 2.405 - 0.0402 * pwm0 + 0.0216 * pwm1;
}

/** Statistics a capture can surface without parsing the stream again. */
export interface VllogicParserStats {
  blocks: number;
  acks: number;
  dataBlocks: number;
  crcFail: number;
  badLen: number;
  maskMismatch: number;
  payloadWords: number;
  snapshots: number;
  junkBytes: number;
  dropBlocks: number;
}

/**
 * Incremental UHSIF decoder. Feed it arbitrary WebUSB transfer chunks; it carries a
 * partial header and a partial word across calls and delivers complete snapshots in
 * batches. One snapshot is `nchan` words, and one word is 32 samples; a full 4092-word
 * payload is 204 snapshots at 20 lanes. Delivering a batch instead of one callback per
 * snapshot is what keeps the JS sink-call count in the thousands per second rather than
 * the millions. The `words` array is snapshot-major and reused between calls, so the
 * callback must consume it synchronously.
 *
 * `onBatch(words, snapshots)`: `words[s * nchan + lane]` is the word for snapshot `s`
 * and physical lane `lane`.
 */
export class VllogicParser {
  readonly stats: VllogicParserStats = {
    blocks: 0, acks: 0, dataBlocks: 0, crcFail: 0, badLen: 0,
    maskMismatch: 0, payloadWords: 0, snapshots: 0, junkBytes: 0, dropBlocks: 0,
  };

  private state: 0 | 1 | 2 = 0;
  private readonly hdr = new Uint8Array(UHSIF_HDR_SIZE);
  private hdrLen = 0;
  private payRem = 0;
  private readonly batch: Uint32Array;
  private batchWords = 0;
  private batchSnapshots = 0;
  private carry = new Uint8Array(0);
  private dropActive = false;

  constructor(
    private readonly map: VllogicChannelMap,
    private readonly onBatch: (words: Uint32Array, snapshots: number) => void,
  ) {
    const perPayload = Math.floor(UHSIF_PAY_MAX / map.nchan) * map.nchan;
    this.batch = new Uint32Array(Math.max(map.nchan, perPayload));
  }

  /** Number of 32-sample snapshots delivered so far. */
  get snapshots(): number {
    return this.stats.snapshots;
  }

  feed(chunk: Uint8Array): void {
    let data = chunk;
    if (this.carry.length > 0 && chunk.length > 0) {
      const joined = new Uint8Array(this.carry.length + chunk.length);
      joined.set(this.carry, 0);
      joined.set(chunk, this.carry.length);
      data = joined;
      this.carry = new Uint8Array(0);
    }
    let off = 0;
    while (off < data.length) {
      if (this.state === 2) {
        const remaining = data.length - off;
        // `payRem` counts payload dwords, not bytes: the firmware's header field is
        // `tx_payload_len` in words (uhsif.v) and libsigrok decrements it once per
        // u32 (uhsif_rx.c:928-933).
        const wholeWords = Math.min(this.payRem, Math.floor(remaining / 4));
        const end = off + wholeWords * 4;
        while (off + 4 <= end) {
          const word = data[off]! | (data[off + 1]! << 8) |
            (data[off + 2]! << 16) | (data[off + 3]! << 24);
          off += 4;
          this.payRem -= 1;
          this.acceptWord(word >>> 0);
        }
        if (this.payRem === 0) {
          this.state = 0;
          // Publish the snapshots this payload completed. A payload can end in the
          // middle of a snapshot; that partial stays in the batch for the next block.
          this.flushBatch();
          continue;
        }
        // A partial word or a partial payload stays for the next feed().
        if (off < data.length) this.carry = data.slice(off);
        return;
      }

      if (this.state === 1) {
        const want = UHSIF_HDR_SIZE - this.hdrLen;
        const take = Math.min(want, data.length - off);
        this.hdr.set(data.subarray(off, off + take), this.hdrLen);
        this.hdrLen += take;
        off += take;
        if (this.hdrLen < UHSIF_HDR_SIZE) return;
        this.hdrLen = 0;
        this.parseHeader();
        continue;
      }

      // SCAN: look for W0's low 16 bits == 0x6CC6.
      if (data.length - off < 4) {
        this.carry = data.slice(off);
        return;
      }
      if ((data[off]! | (data[off + 1]! << 8)) !== UHSIF_BLK_MAGIC16) {
        // The device pads each 4092-byte payload to a 16 KiB transfer, so most
        // scan bytes are zero. Jump to the next 0xC6 (the magic's low byte) with
        // the native indexOf instead of walking the padding one byte at a time.
        const next = data.indexOf(0xC6, off + 1);
        if (next < 0 || next + 3 >= data.length) {
          const keep = Math.max(off, next >= 0 ? next : data.length - 3);
          this.stats.junkBytes += data.length - off;
          this.carry = data.slice(keep);
          return;
        }
        this.stats.junkBytes += next - off;
        off = next;
        continue;
      }
      this.hdr.set(data.subarray(off, off + 4), 0);
      this.hdrLen = 4;
      off += 4;
      this.state = 1;
    }
  }

  /** End of stream: publish complete snapshots, drop a partial one. */
  finish(): void {
    this.flushBatch();
    this.batchWords = 0;
    this.batchSnapshots = 0;
    this.hdrLen = 0;
    this.payRem = 0;
    this.state = 0;
    this.carry = new Uint8Array(0);
  }

  private acceptWord(word: number): void {
    this.stats.payloadWords++;
    this.batch[this.batchWords++] = word;
    if (this.batchWords % this.map.nchan === 0) {
      this.batchSnapshots++;
      if (this.batchWords >= this.batch.length) this.flushBatch();
    }
  }

  /**
   * Publish complete snapshots and keep the words of an incomplete one at the front.
   * The callback consumes `batch` synchronously, so the copy happens after it returns.
   */
  private flushBatch(): void {
    const completeWords = this.batchSnapshots * this.map.nchan;
    if (this.batchSnapshots > 0) {
      this.stats.snapshots += this.batchSnapshots;
      this.onBatch(this.batch, this.batchSnapshots);
    }
    const remainder = this.batchWords - completeWords;
    if (remainder > 0) this.batch.copyWithin(0, completeWords, this.batchWords);
    this.batchWords = remainder;
    this.batchSnapshots = 0;
  }

  private parseHeader(): void {
    const w0 = readU32(this.hdr, 0);
    const w1 = readU32(this.hdr, 4);
    const w2 = readU32(this.hdr, 8);
    const w3 = readU32(this.hdr, 12);
    if ((w0 >>> 16) !== vllogicCrc16(w1, w2, w3)) {
      this.stats.crcFail++;
      // The bytes read as a header may contain the real next header; rescan from
      // the byte after the first magic byte instead of swallowing the gate.
      this.batchWords = 0;
      this.batchSnapshots = 0;
      this.hdr.copyWithin(0, 1);
      this.hdrLen = UHSIF_HDR_SIZE - 1;
      this.state = 1;
      return;
    }
    this.stats.blocks++;
    const plen = (w3 >>> 12) & 0xFFF;
    if (plen === 0) {
      this.stats.acks++;
      this.state = 0;
      return;
    }
    if (plen < UHSIF_PAY_MIN || plen > UHSIF_PAY_MAX) {
      this.stats.badLen++;
      this.batchWords = 0;
      this.batchSnapshots = 0;
      this.state = 0;
      return;
    }
    this.stats.dataBlocks++;
    const drop = ((w2 >>> 22) & 1) !== 0;
    if (drop && !this.dropActive) this.stats.dropBlocks++;
    this.dropActive = drop;
    if ((w1 & 0xFFFFF) !== this.map.mask) {
      this.stats.maskMismatch++;
      this.batchWords = 0;
      this.batchSnapshots = 0;
    }
    this.payRem = plen;
    this.state = 2;
  }
}

function readU32(data: Uint8Array, off: number): number {
  return (data[off]! | (data[off + 1]! << 8) |
    (data[off + 2]! << 16) | (data[off + 3]! << 24)) >>> 0;
}
