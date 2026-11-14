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

import { VLLOGIC_FIFO_HARD_MBPS, maxChannelsForBandwidth } from './vllogicBandwidth.js';

/**
 * USB identity. Logic20 firmware reports bcdDevice 0x0820 (8.20); the host stacks
 * decode the BCD nibbles differently: Windows shows the raw REV_0820, desktop
 * Chrome splits it into 8 / 2 / 0, and Chrome on Android has been observed
 * reporting 0x0801 for the same board. Every Logic20 firmware is USB device
 * version 8.x, while the older Sniffer2 is 0x0602 and is not compatible.
 */
export const VLLOGIC_VID = 0x1209;
export const VLLOGIC_PID = 0x6688;
/** Raw firmware bcdDevice: 8.20. */
export const VLLOGIC_BCD_LOGIC20 = 0x0820;
/** Chrome on Android has been observed reporting this value for the same board. */
export const VLLOGIC_BCD_LOGIC20_ANDROID = 0x0801;
/** All Logic20 firmware versions share this bcdDevice high byte. */
export const VLLOGIC_BCD_LOGIC20_FAMILY = 0x0800;
export const VLLOGIC_PRODUCT = 'Logic20';

/**
 * Rebuild bcdDevice from the three fields WebUSB splits it into. Chrome on Android
 * fills the fields differently than desktop Chrome, so compare the rebuilt value
 * against the 8.x family instead of one exact combination.
 */
export function vllogicBcdDevice(major: number, minor: number, subminor: number): number {
  return ((major & 0xFF) << 8) | ((minor & 0x0F) << 4) | (subminor & 0x0F);
}

/** True for Logic20 firmware; rejects the Sniffer2 (0x06xx) and unrelated devices. */
export function vllogicBcdIsLogic20(bcd: number): boolean {
  return (bcd & 0xFF00) === VLLOGIC_BCD_LOGIC20_FAMILY;
}
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
 * The rates the driver offers. The 2.4 GHz ISERDES divider covers 20..1200 MHz; the
 * slower 10/5/2.5 MHz entries keep the device at 20 MHz (div 120) and drop every
 * second/fourth/eighth sample on the host, which is exactly what the native driver
 * calls the "PC decimation" factor.
 *
 * `vllogicMaxChannels()` keeps the selected lanes under the 4500 Mbit/s FIFO hard
 * limit (1200x3 = 3600, 600x7 = 4200, 300x15 = 4500, 150x20 = 3000).
 */
export interface VllogicRate {
  readonly rate: number;
  readonly div: number;
  /** Host-side decimation: keep every Nth sample the device streams. */
  readonly decimate: number;
}

export const VLLOGIC_RATES: readonly VllogicRate[] = [
  { rate: 2_500_000, div: 120, decimate: 8 },
  { rate: 5_000_000, div: 120, decimate: 4 },
  { rate: 10_000_000, div: 120, decimate: 2 },
  { rate: 20_000_000, div: 120, decimate: 1 },
  { rate: 40_000_000, div: 60, decimate: 1 },
  { rate: 80_000_000, div: 30, decimate: 1 },
  { rate: 120_000_000, div: 20, decimate: 1 },
  { rate: 150_000_000, div: 16, decimate: 1 },
  { rate: 300_000_000, div: 8, decimate: 1 },
  { rate: 600_000_000, div: 4, decimate: 1 },
  { rate: 1_200_000_000, div: 2, decimate: 1 },
];

/** The table entry for an exact rate, or null when the table does not offer it. */
export function vllogicRateFor(rate: number): VllogicRate | null {
  return VLLOGIC_RATES.find((candidate) => candidate.rate === rate) ?? null;
}

/**
 * Comparator presets shown in the UI: the measured -2.5/+5.0 V endpoints, plus one
 * mid-swing point per common logic family (0.6 V for 1.2 V, 0.9 V for 1.8 V, 1.6 V for
 * 3.3 V, 2.5 V for 5.0 V CMOS). 1.6 V is the default: 3.3 V CMOS is the most common
 * target. Anything else is entered as a custom value.
 */
export const VLLOGIC_THRESHOLD_PRESETS: readonly number[] = [
  -2.5, -1.5, 0, 0.6, 0.9, 1.6, 2.5, 5,
];

/** Selected lanes that fit under the 4500 Mbit/s FIFO hard limit at `rate`. */
export function vllogicMaxChannels(rate: number): number {
  return Math.min(VLLOGIC_NUM_CHANNELS, maxChannelsForBandwidth(rate, VLLOGIC_FIFO_HARD_MBPS));
}

/** The exact div entry for a rate, or null when the table does not offer it. */
export function vllogicDivForRate(rate: number): number | null {
  return vllogicRateFor(rate)?.div ?? null;
}

/**
 * The table's first rate for a div, or null. 120 now maps to four entries (20/10/5/2.5
 * MHz), so this only answers "does a div exist"; callers that need the rate itself use
 * `vllogicRateFor()`.
 */
export function vllogicRateForDiv(div: number): number | null {
  const matches = VLLOGIC_RATES.filter((candidate) => candidate.div === div);
  // div 120 carries four rates now (20/10/5/2.5 MHz), so only a unique div answers.
  return matches.length === 1 ? matches[0]!.rate : null;
}

/**
 * Host-side decimation for the slow rates. The device streams at div 120 and every
 * `factor`th sample is kept; a factor of 1 is the identity.
 *
 * Words are 32 samples, and factor divides 32, so each source word contributes exactly
 * 32/factor samples. Bits left over at a batch boundary are carried to the next call.
 */
export class VllogicDecimator {
  private readonly carries: Uint32Array;
  private readonly carryBits: Uint32Array;

  constructor(channels: number, private readonly factor: number) {
    if (!Number.isInteger(factor) || factor < 1 || factor & (factor - 1)) {
      throw new Error(`decimation factor must be a power of two, got ${factor}`);
    }
    this.carries = new Uint32Array(channels);
    this.carryBits = new Uint32Array(channels);
  }

  /** Decimate one channel's source words into `out`; returns the whole words written. */
  decimate(channel: number, src: Uint32Array, out: Uint32Array): number {
    const f = this.factor;
    let acc = this.carries[channel]!;
    let bits = this.carryBits[channel]!;
    let written = 0;
    for (let i = 0; i < src.length; i++) {
      const word = src[i]!;
      for (let b = 0; b < 32; b += f) {
        acc |= ((word >>> b) & 1) << bits;
        if (++bits === 32) {
          out[written++] = acc >>> 0;
          acc = 0;
          bits = 0;
        }
      }
    }
    this.carries[channel] = acc;
    this.carryBits[channel] = bits;
    return written;
  }
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
  /** Data blocks discarded by the START barrier (a previous capture's tail). */
  preAckBlocks: number;
  dataBlocks: number;
  crcFail: number;
  badLen: number;
  maskMismatch: number;
  payloadWords: number;
  snapshots: number;
  junkBytes: number;
  dropBlocks: number;
  /**
   * The drop bit of the first data block. drop_flag is latched by the board, so a 1
   * here may have been carried over from the previous capture rather than lost in
   * this one; a later 0 -> 1 edge is unambiguously this capture's own drop.
   */
  firstDataDrop: boolean;
  /** Snapshots delivered when the drop edge appeared; -1 when there was no edge. */
  dropAtSnapshots: number;
  seqJumps: number;
  partialSnapshots: number;
}

/** Fields of the last CRC-valid data block, for the transport's first-block check. */
export interface VllogicBlockHeader {
  readonly div: number;
  readonly mask: number;
  readonly mode: number;
  readonly capturing: boolean;
  readonly lutCheck: number;
  readonly drop: boolean;
  readonly seq: number;
  readonly payloadWords: number;
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
    blocks: 0, acks: 0, preAckBlocks: 0, dataBlocks: 0, crcFail: 0, badLen: 0,
    maskMismatch: 0, payloadWords: 0, snapshots: 0, junkBytes: 0, dropBlocks: 0,
    firstDataDrop: false, dropAtSnapshots: -1, seqJumps: 0, partialSnapshots: 0,
  };

  /** The most recent CRC-valid data block header, or null before the first one. */
  lastHeader: VllogicBlockHeader | null = null;
  private lastSeq: number | null = null;

  private state: 0 | 1 | 2 = 0;
  private readonly hdr = new Uint8Array(UHSIF_HDR_SIZE);
  private hdrLen = 0;
  private payRem = 0;
  private readonly batch: Uint32Array;
  private batchWords = 0;
  private batchSnapshots = 0;
  private carry = new Uint8Array(0);
  /**
   * Bytes of a rejected header candidate that still need rescanning. A corrupt header is
   * rejected after its first byte already matched the block magic, so the other 15 bytes
   * may hide the next real header; they are replayed at the front of the stream (the
   * native parser's `replay`, uhsif_rx.c:794-795) instead of being treated as another
   * header candidate. This keeps the resync to the byte after the false magic and counts
   * one `crcFail` per corrupt block instead of one per shifted candidate.
   */
  private replay = new Uint8Array(0);
  private dropActive = false;
  /**
   * START barrier. WebUSB cannot cancel the previous capture's last transferIn, and at
   * 20 lanes the tail can still arrive after the pre-START drain. If it carries the same
   * mask, the parser would treat it as new data; a tail that is not a whole snapshot
   * then rotates every following snapshot, so a signal on D0 appears on another lane.
   * Discard data blocks until the board sends an ACK; the new capture's data starts
   * after the ACK run, on a snapshot boundary.
   */
  private awaitingStartAck = false;
  /**
   * Drop the payload of a block whose header mask is not the configured one. Its words
   * belong to another lane set (a stale block from before START, or a misconfigured
   * board), so consuming them would mix a different word order into this capture.
   */
  private discardPayload = false;

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
    while (off < data.length || this.replay.length > 0) {
      // A rejected header's tail is scanned before the current input, in stream order.
      if (this.replay.length > 0) {
        const rest = data.length - off;
        const joined = new Uint8Array(this.replay.length + rest);
        joined.set(this.replay, 0);
        if (rest > 0) joined.set(data.subarray(off), this.replay.length);
        data = joined;
        off = 0;
        this.replay = new Uint8Array(0);
      }
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
        // A block is one 16 KiB transfer (16 B header + up to 4092 words), and a
        // short block leaves zero padding, so most scan bytes are zero. Jump to
        // the next 0xC6 (the magic's low byte) with the native indexOf instead of
        // walking the padding one byte at a time.
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

  /**
   * Arm the START barrier: drop every data block until the first ACK, then accept data.
   * Called by the transport before START so a previous capture's tail cannot contribute
   * samples to the new capture.
   */
  armStartBarrier(): void {
    this.awaitingStartAck = true;
    this.resetSnapshotPhase();
    this.carry = new Uint8Array(0);
    this.replay = new Uint8Array(0);
    this.hdrLen = 0;
    this.payRem = 0;
    this.state = 0;
    this.discardPayload = false;
    this.dropActive = false;
    this.lastSeq = null;
    this.lastHeader = null;
  }

  /** End of stream: publish complete snapshots, drop a partial one. */
  finish(): void {
    this.resetSnapshotPhase();
    this.hdrLen = 0;
    this.payRem = 0;
    this.state = 0;
    this.carry = new Uint8Array(0);
    this.replay = new Uint8Array(0);
    this.discardPayload = false;
  }

  private acceptWord(word: number): void {
    // A mismatched block's words are consumed from the wire either way, but they must
    // not reach the batch: the lane order they carry is not this capture's.
    if (this.discardPayload) return;
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

  /**
   * Drop the snapshot being assembled when its block was rejected, without losing the
   * complete snapshots already batched before it. The incomplete tail is counted as a
   * partial snapshot, matching uhsif_rx.c:790-793 / 814-818 / 835-838.
   */
  private resetSnapshotPhase(): void {
    if (this.batchSnapshots > 0) this.flushBatch();
    if (this.batchWords > 0) {
      this.batchWords = 0;
      this.batchSnapshots = 0;
      this.stats.partialSnapshots += 1;
    }
  }

  private parseHeader(): void {
    const w0 = readU32(this.hdr, 0);
    const w1 = readU32(this.hdr, 4);
    const w2 = readU32(this.hdr, 8);
    const w3 = readU32(this.hdr, 12);
    if ((w0 >>> 16) !== vllogicCrc16(w1, w2, w3)) {
      this.stats.crcFail++;
      // The bytes read as a header may contain the real next header; rescan from the
      // byte after the first magic byte instead of swallowing the gate. The 15 bytes
      // after that byte are replayed into SCAN, so the failed candidate is counted once
      // and a shifted copy is never tested as a header (uhsif_rx.c:780-797).
      this.resetSnapshotPhase();
      this.replay = this.hdr.slice(1);
      this.hdrLen = 0;
      this.state = 0;
      return;
    }
    this.stats.blocks++;
    const plen = (w3 >>> 12) & 0xFFF;
    if (this.awaitingStartAck) {
      if (plen === 0) {
        this.stats.acks++;
        this.awaitingStartAck = false;
        this.resetSnapshotPhase();
        this.state = 0;
        return;
      }
      if (plen < UHSIF_PAY_MIN || plen > UHSIF_PAY_MAX) {
        this.stats.badLen++;
        this.state = 0;
        return;
      }
      // A previous capture's tail, or anything before START is acknowledged. Consume
      // it without touching the batch, drop/seq statistics or lastHeader.
      this.stats.preAckBlocks++;
      this.discardPayload = true;
      this.payRem = plen;
      this.state = 2;
      return;
    }
    if (plen === 0) {
      this.stats.acks++;
      this.state = 0;
      return;
    }
    if (plen < UHSIF_PAY_MIN || plen > UHSIF_PAY_MAX) {
      this.stats.badLen++;
      this.resetSnapshotPhase();
      this.state = 0;
      return;
    }
    this.stats.dataBlocks++;
    const drop = ((w2 >>> 22) & 1) !== 0;
    if (this.stats.dataBlocks === 1) this.stats.firstDataDrop = drop;
    if (drop && !this.dropActive) {
      this.stats.dropBlocks++;
      this.stats.dropAtSnapshots = this.stats.snapshots;
    }
    this.dropActive = drop;
    const seq = (w3 >>> 24) & 0xFF;
    if (this.lastSeq !== null && seq !== ((this.lastSeq + 1) & 0xFF)) {
      this.stats.seqJumps += 1;
    }
    this.lastSeq = seq;
    this.lastHeader = {
      div: (w2 >>> 15) & 0x7F,
      mask: w1 & 0xFFFFF,
      mode: (w3 >>> 10) & 3,
      capturing: ((w2 >>> 23) & 1) !== 0,
      lutCheck: (w2 >>> 24) & 0xFF,
      drop,
      seq,
      payloadWords: plen,
    };
    this.discardPayload = (w1 & 0xFFFFF) !== this.map.mask;
    if (this.discardPayload) {
      this.stats.maskMismatch++;
      this.resetSnapshotPhase();
    }
    this.payRem = plen;
    this.state = 2;
  }
}

function readU32(data: Uint8Array, off: number): number {
  return (data[off]! | (data[off + 1]! << 8) |
    (data[off + 2]! << 16) | (data[off + 3]! << 24)) >>> 0;
}
