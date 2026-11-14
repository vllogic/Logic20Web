// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VLLogic driver authors
// Copyright (C) 2026 vllogic.com
/**
 * Offline checks for the VLLogic UHSIF parser and protocol helpers.
 *
 * The streams here are synthetic, so the suite runs without a device:
 *   node_modules/.bin/esbuild src/device/vllogicSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/vllogic-selftest.mjs --log-level=error
 *   node /tmp/vllogic-selftest.mjs
 */

import {
  UHSIF_BLK_MAGIC16,
  UhsifCmd,
  VLLOGIC_EP_IN_ADDR,
  VLLOGIC_EP_OUT_ADDR,
  VLLOGIC_NUM_CHANNELS,
  VllogicParser,
  vllogicBuildCommand,
  vllogicBuildLut,
  vllogicCrc16,
  vllogicDivForRate,
  vllogicMapBuild,
  vllogicMaxChannels,
  vllogicPwmToThreshold,
  vllogicRateForDiv,
  vllogicThresholdToPwm,
} from './vllogicProtocol.js';
import { VllogicDevice, vllogicReadTuning } from './vllogic.js';
import { PlanarSampleStore } from '../data/planarStore.js';

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}

const results: Result[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function u32(value: number): number[] {
  return [value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF];
}

function block(
  mask: number, div: number, seq: number, payload: readonly number[], corrupt = false,
): Uint8Array {
  const plen = payload.length;
  const w1 = mask >>> 0;
  const w2 = ((div << 15) | (1 << 23)) >>> 0; // capturing=1
  const w3 = ((plen << 12) | (seq << 24)) >>> 0;
  const crc = vllogicCrc16(w1, w2, w3);
  const w0 = (((corrupt ? crc ^ 0xFFFF : crc) << 16) | UHSIF_BLK_MAGIC16) >>> 0;
  const out: number[] = [...u32(w0), ...u32(w1), ...u32(w2), ...u32(w3)];
  for (const word of payload) out.push(...u32(word));
  return Uint8Array.from(out);
}

class FakeUsb {
  opened = true;
  readonly productName = 'Logic20';
  readonly serialNumber = 'selftest';
  deviceVersionMajor = 8;
  deviceVersionMinor = 0x02;
  readonly deviceVersionSubminor = 0;
  readonly chunks: Uint8Array[] = [];
  /** Blocks the pre-START drain may see; empty means the endpoint is idle. */
  readonly beforeStartChunks: Uint8Array[] = [];
  readonly commands: Array<{ cmd: number; param: number }> = [];
  delayMs = 0;
  varyDelay = false;
  /** Let a pre-START transferIn consume `beforeStartChunks` instead of waiting for START. */
  serveBeforeStart = false;
  /** Model a wedged board: transferIn never completes once the queued chunks run out. */
  hangWhenEmpty = false;
  calls = 0;
  maxConcurrent = 0;
  private active = 0;
  private started = false;

  async open(): Promise<void> {}
  async selectConfiguration(_value: number): Promise<void> {}
  async claimInterface(_number: number): Promise<void> {}
  async releaseInterface(_number: number): Promise<void> {}
  async close(): Promise<void> {}

  async transferOut(_endpoint: number, data: ArrayBuffer): Promise<USBOutTransferResult> {
    const view = new DataView(data);
    const cmd = view.getUint32(4, true);
    const param = view.getUint32(8, true);
    this.commands.push({ cmd, param });
    if (cmd === UhsifCmd.Start) this.started = true;
    return { status: 'ok', bytesWritten: data.byteLength };
  }

  async transferIn(_endpoint: number, _length: number): Promise<USBInTransferResult> {
    const call = this.calls++;
    // A pre-START drain read returns queued leftovers immediately; once they run out
    // the read parks and the transport's idle window turns it into the pre-arm.
    if (!this.started && this.serveBeforeStart && this.beforeStartChunks.length > 0) {
      const stale = this.beforeStartChunks.shift()!;
      return {
        status: 'ok',
        data: new DataView(stale.buffer, stale.byteOffset, stale.byteLength),
      };
    }
    // Bind the block at submission time: that is the endpoint's FIFO order, even
    // though the *completion* may still arrive out of order.
    const chunk = this.chunks.shift();
    while (!this.started) await new Promise((resolve) => setTimeout(resolve, 2));
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    try {
      const wait = this.varyDelay ? (call % 3) * 3 : this.delayMs;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (!chunk && this.hangWhenEmpty) {
        return new Promise<USBInTransferResult>(() => { /* wedged: never completes */ });
      }
      if (!chunk) return { status: 'ok', data: new DataView(new ArrayBuffer(0)) };
      return {
        status: 'ok',
        data: new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      };
    } finally {
      this.active -= 1;
    }
  }
}

async function main(): Promise<void> {
  const nodeProc = (globalThis as {
    process?: { on?: (event: string, cb: (e: unknown) => void) => void };
  }).process;
  nodeProc?.on?.('unhandledRejection', (e) => { console.error('UNHANDLED', e); });

  // ---- command framing ----------------------------------------------------
  const ping = vllogicBuildCommand(UhsifCmd.Ping, 0);
  const pingView = new DataView(ping.buffer);
  const pingW1 = pingView.getUint32(4, true);
  const pingW2 = pingView.getUint32(8, true);
  const pingW3 = pingView.getUint32(12, true);
  check(
    'command frame carries magic, CRC and zero payload',
    ping.byteLength === 16 &&
      (pingView.getUint32(0, true) & 0xFFFF) === 0xC7F3 &&
      (pingView.getUint32(0, true) >>> 16) === vllogicCrc16(pingW1, pingW2, pingW3) &&
      pingW1 === UhsifCmd.Ping && pingW2 === 0 && pingW3 === 0,
    `len=${ping.byteLength}, w=${pingView.getUint32(0, true).toString(16)}`,
  );
  check(
    'endpoint addresses are the Logic20 descriptor values',
    VLLOGIC_EP_IN_ADDR === 0x81 && VLLOGIC_EP_OUT_ADDR === 0x01,
    `${VLLOGIC_EP_IN_ADDR}/${VLLOGIC_EP_OUT_ADDR}`,
  );

  // ---- LUT ---------------------------------------------------------------
  const lut = vllogicBuildLut(0xFFFFF);
  const expectedLut = [0xCC520C41, 0xD62D4941, 0x4E5183DC, 0, 0];
  check(
    '20-lane LUT matches the driver reference',
    expectedLut.every((value, i) => lut[i] === value),
    Array.from(lut).map((v) => v.toString(16)).join(','),
  );

  // ---- channel map -------------------------------------------------------
  const all = Array.from({ length: VLLOGIC_NUM_CHANNELS }, (_, i) => i);
  const map = vllogicMapBuild(all);
  check(
    '20-lane map is the identity mask with swapped low pairs',
    map.mask === 0xFFFFF && map.nchan === 20 && map.phys2log[0] === 1 &&
      map.phys2log[1] === 0 && map.phys2log[19] === 19 && map.unitsize === 3,
    `mask=${map.mask.toString(16)} nchan=${map.nchan} unitsize=${map.unitsize}`,
  );
  const four = vllogicMapBuild([0, 1, 2, 3]);
  check(
    'a four-lane map keeps ascending physical order',
    four.mask === 0xF && four.nchan === 4 &&
      four.physList.join(',') === '0,1,2,3' &&
      four.phys2log[0] === 1 && four.phys2log[1] === 0 &&
      four.phys2log[2] === 3 && four.phys2log[3] === 2 &&
      four.unitsize === 1,
    `mask=${four.mask.toString(16)} phys=${four.physList.join(',')}`,
  );

  // ---- rate / threshold helpers -----------------------------------------
  check(
    'div table and channel ceilings follow the hardware rules',
    vllogicDivForRate(20_000_000) === 120 &&
      vllogicDivForRate(100_000_000) === 24 &&
      vllogicDivForRate(160_000_000) === 15 &&
      vllogicDivForRate(1_200_000_000) === 2 &&
      vllogicDivForRate(123_456) === null &&
      vllogicRateForDiv(15) === 160_000_000 &&
      vllogicMaxChannels(160_000_000) === 20 &&
      vllogicMaxChannels(200_000_000) === 16 &&
      vllogicMaxChannels(400_000_000) === 8 &&
      vllogicMaxChannels(800_000_000) === 4 &&
      vllogicMaxChannels(1_200_000_000) === 2,
    'div/rate/ceiling table',
  );
  const at165 = vllogicThresholdToPwm(1.65);
  const atMinus25 = vllogicThresholdToPwm(-2.5);
  const at5 = vllogicThresholdToPwm(5.0);
  check(
    'threshold inverse reproduces the calibrated DAC endpoints',
    at165?.pwm0 === 19 && at165.pwm1 === 0 &&
      atMinus25?.pwm0 === 122 && atMinus25.pwm1 === 0 &&
      at5?.pwm0 === 0 && at5.pwm1 === 120 &&
      Math.abs(vllogicPwmToThreshold(19, 0) - 1.6412) < 1e-6 &&
      vllogicThresholdToPwm(1e9) === null,
    `1.65V=${JSON.stringify(at165)} -2.5V=${JSON.stringify(atMinus25)} 5V=${JSON.stringify(at5)}`,
  );

  // ---- parser ------------------------------------------------------------
  const snapshots = 6;
  const wordsPerSnapshot: number[][] = [];
  for (let s = 0; s < snapshots; s++) {
    wordsPerSnapshot.push(all.map((channel) => ((channel * 0x9E3779B1) ^ (s * 0x45D9F3B)) >>> 0));
  }
  const payload: number[] = [];
  for (const words of wordsPerSnapshot) payload.push(...words);
  const stream = block(0xFFFFF, 15, 7, payload);
  // Junk + a corrupt header must not consume the real header that follows it.
  const corrupt = block(0xFFFFF, 15, 8, [0xDEADBEEF], true);
  const ack = block(0xFFFFF, 15, 9, []);
  const batches: Array<{ words: number[]; snapshots: number }> = [];
  const parser = new VllogicParser(map, (words, batchSnapshots) =>
    batches.push({ words: Array.from(words), snapshots: batchSnapshots }));
  const source = Uint8Array.from([0x00, 0x11, 0x22, ...corrupt, ...ack, ...stream]);
  // Feed in awkward chunks so a header and a word both straddle a transfer boundary.
  for (let off = 0; off < source.length; off += 7) {
    parser.feed(source.subarray(off, Math.min(source.length, off + 7)));
  }
  const received = batches.flatMap((batch) => Array.from({ length: batch.snapshots }, (_, s) =>
    batch.words.slice(s * map.nchan, (s + 1) * map.nchan)));
  const matches = received.length === snapshots &&
    received.every((words, i) => words.every((word, j) => word === wordsPerSnapshot[i]![j]));
  check(
    'parser recovers from junk/corrupt headers and carries split words',
    matches && parser.stats.acks === 1 && parser.stats.crcFail >= 1,
    `snapshots=${received.length}/${snapshots} acks=${parser.stats.acks} crcFail=${parser.stats.crcFail}`,
  );

  // A stale block from another lane set must not be mixed into this capture, even
  // though its words are consumed from the wire.
  {
    // Both payloads clear the 120-word firmware minimum; the stale one is 121 words
    // (6 snapshots + 1 dangling), so it also exercises the partial-snapshot carry.
    const stalePayload = Array.from({ length: 121 }, (_, i) => (0xAAAA0000 | i) >>> 0);
    const goodPayload = Array.from({ length: 120 }, (_, i) => (0x55550000 | i) >>> 0);
    let delivered = 0;
    const seen: number[] = [];
    const mixed = new VllogicParser(map, (words, batchSnapshots) => {
      delivered += batchSnapshots;
      seen.push(...Array.from(words.subarray(0, batchSnapshots * map.nchan)));
    });
    mixed.feed(block(0xF, 15, 1, stalePayload));
    mixed.feed(block(0xFFFFF, 15, 2, goodPayload));
    mixed.finish();
    check(
      'a block with the wrong mask is dropped instead of mixed in',
      delivered === 6 && seen.length === 120 &&
        seen.every((word, i) => word === goodPayload[i]) &&
        mixed.stats.maskMismatch === 1 && mixed.stats.payloadWords === 120,
      `delivered=${delivered} seen=${seen.length} maskMismatch=${mixed.stats.maskMismatch} ` +
        `payloadWords=${mixed.stats.payloadWords}`,
    );
  }

  // A 121-word payload is 6 whole 20-lane snapshots plus 1 dangling word: end of
  // stream publishes the 6 and drops the partial.
  let delivered = 0;
  const cut = new VllogicParser(map, (_words, batchSnapshots) => { delivered += batchSnapshots; });
  cut.feed(block(0xFFFFF, 15, 10, Array.from({ length: 121 }, (_, i) => i + 1)));
  cut.finish();
  check(
    'a partial trailing snapshot is dropped at end of stream',
    delivered === 6,
    `delivered=${delivered}`,
  );

  // The real block geometry: 4092 payload dwords is 204 snapshots at 20 lanes plus a
  // 12-word tail. This is the regression guard for treating payload_len as bytes.
  {
    const payload4092 = Array.from({ length: 4092 }, (_, i) => (i * 0x9E3779B1) >>> 0);
    let delivered = 0;
    const full = new VllogicParser(map, (_words, n) => { delivered += n; });
    full.feed(block(0xFFFFF, 15, 11, payload4092));
    full.finish();
    check(
      'a real 4092-word payload yields 204 snapshots with no junk',
      delivered === 204 && full.stats.payloadWords === 4092 &&
        full.stats.junkBytes === 0 && full.stats.crcFail === 0 && full.stats.badLen === 0,
      `delivered=${delivered} words=${full.stats.payloadWords} junk=${full.stats.junkBytes} ` +
        `crcFail=${full.stats.crcFail} badLen=${full.stats.badLen}`,
    );
  }

  // ---- device transport over a fake WebUSB port --------------------------
  {
    const fake = new FakeUsb();
    const snapshots = 10;
    const payload: number[] = [];
    for (let s = 0; s < snapshots; s++) {
      for (const channel of all) {
        payload.push((channel * 0x01010101 ^ s * 0x11111111) >>> 0);
      }
    }
    fake.chunks.push(block(0xFFFFF, 30, 1, payload));
    const device = await VllogicDevice.open(fake as unknown as USBDevice);
    const store = new PlanarSampleStore({ channelCount: 20, samplerate: 80e6 });
    let commits = 0;
    let ended = false;
    await device.startChannelMajor(
      { channels: 20, samplerate: 80e6, thresholdVolts: 1.65 },
      {
        begin: (channels) => store.beginFrame(channels),
        channel: (channel, start, words) => store.appendChannel(channel, start, words),
        commit: (samples) => { store.commitSamples(samples); commits++; },
      },
      undefined,
      { deviceSampleLimit: snapshots * 32, onEnd: () => { ended = true; } },
    );
    for (let i = 0; i < 200 && !ended; i++) await new Promise((r) => setTimeout(r, 5));
    await device.stop();
    for (let i = 0; i < 200 && !ended; i++) await new Promise((r) => setTimeout(r, 5));
    const commands = fake.commands.map((c) => c.cmd);
    const expected = [
      UhsifCmd.Stop, UhsifCmd.Flush, UhsifCmd.MaxPayload, UhsifCmd.ChannelMask,
      UhsifCmd.Lut0, UhsifCmd.Lut0 + 1, UhsifCmd.Lut0 + 2, UhsifCmd.Lut0 + 3,
      UhsifCmd.Lut0 + 4, UhsifCmd.IserdesDiv, UhsifCmd.VbiasPwm0, UhsifCmd.VbiasPwm1,
      UhsifCmd.ModeNormal, UhsifCmd.Start,
    ];
    check(
      'device transport configures, starts and lands every channel word',
      ended && store.length === snapshots * 32 && commits >= 1 &&
        expected.every((cmd, i) => commands[i] === cmd) &&
        commands.includes(UhsifCmd.Stop) &&
        store.sampleAt(0, 0) === (payload[1]! & 1) &&
        store.sampleAt(19, 31) === ((payload[19]! >>> 31) & 1),
      `ended=${ended} length=${store.length} commits=${commits} commands=${commands.length}`,
    );
  }

  // ---- optional pre-START drain ------------------------------------------
  {
    const fake = new FakeUsb();
    fake.serveBeforeStart = true;
    // A stale block from a previous capture (wrong mask) that the drain must discard.
    const stalePayload = Array.from({ length: 121 }, (_, i) => (0xAAAA0000 | i) >>> 0);
    const goodPayload = Array.from({ length: 120 }, (_, i) => (0x55550000 | i) >>> 0);
    const stale = block(0xF, 60, 1, stalePayload);
    fake.beforeStartChunks.push(stale);
    // 120 words at 20 lanes is 6 snapshots; it is what the pre-armed read delivers.
    fake.chunks.push(block(0xFFFFF, 120, 2, goodPayload));
    const device = await VllogicDevice.open(fake as unknown as USBDevice, {
      bytes: 8192, depth: 2, firstBlockMs: 1000, drainIdleMs: 5,
    });
    const store = new PlanarSampleStore({ channelCount: 20, samplerate: 20e6 });
    let ended = false;
    let error: unknown = null;
    device.onError = (e) => { error = e; };
    await device.startChannelMajor(
      { channels: 20, samplerate: 20e6, thresholdVolts: 1.65 },
      {
        begin: (channels) => store.beginFrame(channels),
        channel: (channel, start, words) => store.appendChannel(channel, start, words),
        commit: (samples) => store.commitSamples(samples),
      },
      undefined,
      { deviceSampleLimit: 6 * 32, onEnd: () => { ended = true; } },
    );
    for (let i = 0; i < 200 && !ended; i++) await new Promise((r) => setTimeout(r, 5));
    await device.stop();
    check(
      'the pre-START drain discards stale blocks and hands its pending read to the capture',
      ended && error === null && store.length === 6 * 32 &&
        device.drainStats.reads === 1 && device.drainStats.bytes === stale.length &&
        device.drainStats.preArmed,
      `ended=${ended} code=${(error as { code?: string } | null)?.code ?? 'none'} ` +
        `length=${store.length} drain=${JSON.stringify(device.drainStats)}`,
    );
  }

  // ---- pipelined reads ---------------------------------------------------
  {
    const overridden = vllogicReadTuning(
      '?vllogic-read=131072&vllogic-depth=4&vllogic-firstblock=250&vllogic-drain=20',
    );
    const rejected = vllogicReadTuning(
      '?vllogic-read=1&vllogic-depth=999&vllogic-firstblock=1&vllogic-drain=9999',
    );
    const defaults = vllogicReadTuning('');
    check(
      'read tuning honours safe overrides, rejects unsafe values and defaults to 256 KiB x 16',
      overridden.bytes === 131072 && overridden.depth === 4 && overridden.firstBlockMs === 250 &&
        overridden.drainIdleMs === 20 &&
        rejected.bytes === 256 * 1024 && rejected.depth === 16 &&
        rejected.firstBlockMs === 1000 && rejected.drainIdleMs === 20 &&
        defaults.bytes === 256 * 1024 && defaults.depth === 16 &&
        defaults.firstBlockMs === 1000 && defaults.drainIdleMs === 20,
      `override=${JSON.stringify(overridden)} rejected=${JSON.stringify(rejected)} ` +
        `defaults=${JSON.stringify(defaults)}`,
    );
  }

  {
    const fake = new FakeUsb();
    fake.deviceVersionMajor = 0x06;
    fake.deviceVersionMinor = 0x02;
    let code = '';
    try {
      await VllogicDevice.open(fake as unknown as USBDevice);
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
    }
    check(
      'a Sniffer2 bcdDevice is rejected before claiming',
      code === 'device.unexpectedDevice',
      `code=${code}`,
    );
  }

  {
    const fake = new FakeUsb();
    const payload: number[] = [];
    for (let s = 0; s < 30; s++) {
      for (let c = 0; c < 4; c++) payload.push(((s * 0x9E3779B1) ^ c) >>> 0);
    }
    // The device was configured for div 120 (20 MHz), but the first block says 60.
    fake.chunks.push(block(0xF, 60, 1, payload));
    const device = await VllogicDevice.open(fake as unknown as USBDevice);
    const mismatchStore = new PlanarSampleStore({ channelCount: 4, samplerate: 20e6 });
    let error: unknown = null;
    device.onError = (e) => { error = e; };
    await device.startChannelMajor(
      { channels: 4, samplerate: 20e6, thresholdVolts: 1.65 },
      {
        begin: (chs) => mismatchStore.beginFrame(chs),
        channel: (ch, start, words) => mismatchStore.appendChannel(ch, start, words),
        commit: (samples) => mismatchStore.commitSamples(samples),
      },
      undefined,
      { deviceSampleLimit: 30 * 32 },
    );
    for (let i = 0; i < 50 && error === null; i++) await new Promise((r) => setTimeout(r, 10));
    await device.stop();
    const code = (error as { code?: string } | null)?.code ?? 'none';
    check(
      'a first block with the wrong divider is rejected',
      code === 'device.headerMismatch',
      `code=${code}`,
    );
  }

  {
    const fake = new FakeUsb();
    const tuned = await VllogicDevice.open(
      fake as unknown as USBDevice,
      { depth: 3, bytes: 8192, firstBlockMs: 1000, drainIdleMs: 0 },
    );
    check(
      'open() accepts an explicit read geometry for bench runs',
      tuned.readTuning.depth === 3 && tuned.readTuning.bytes === 8192 &&
        tuned.readTuning.firstBlockMs === 1000 && tuned.readTuning.drainIdleMs === 0,
      `depth=${tuned.readTuning.depth} bytes=${tuned.readTuning.bytes} ` +
        `firstBlock=${tuned.readTuning.firstBlockMs} drain=${tuned.readTuning.drainIdleMs}`,
    );
  }

  // ---- stop wake + first-block watchdog ----------------------------------
  {
    // A wedged board acknowledges everything and never completes a bulk IN. Before
    // the wake fix, stop() returned after 750 ms but readLoop stayed parked forever.
    const fake = new FakeUsb();
    fake.hangWhenEmpty = true;
    const device = await VllogicDevice.open(fake as unknown as USBDevice, {
      depth: 2, bytes: 8192, firstBlockMs: 60_000, drainIdleMs: 0,
    });
    await device.startChannelMajor(
      { channels: 4, samplerate: 20e6, thresholdVolts: 1.65 },
      {
        begin: () => {},
        channel: () => {},
        commit: () => {},
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const t0 = performance.now();
    await device.stop();
    const stopMs = performance.now() - t0;
    check(
      'stop() wakes a read loop parked on a silent endpoint',
      device.loopCompleted && stopMs < 1500,
      `loopCompleted=${device.loopCompleted} stopMs=${stopMs.toFixed(0)}`,
    );
  }

  {
    // A finite capture that delivered its budget has nothing left to collect. The
    // outstanding reads cannot complete after STOP, so stop() must not spend the
    // settle window on them.
    const fake = new FakeUsb();
    const payload = Array.from({ length: 120 }, (_, i) => (0x12340000 | i) >>> 0);
    fake.chunks.push(block(0xFFFFF, 120, 1, payload));
    fake.hangWhenEmpty = true;
    const device = await VllogicDevice.open(fake as unknown as USBDevice, {
      depth: 2, bytes: 8192, firstBlockMs: 1000, drainIdleMs: 0,
    });
    let ended = false;
    await device.startChannelMajor(
      { channels: 20, samplerate: 20e6, thresholdVolts: 1.65 },
      { begin: () => {}, channel: () => {}, commit: () => {} },
      undefined,
      { deviceSampleLimit: 6 * 32, onEnd: () => { ended = true; } },
    );
    for (let i = 0; i < 100 && !ended; i++) await new Promise((r) => setTimeout(r, 5));
    const t0 = performance.now();
    await device.stop();
    const stopMs = performance.now() - t0;
    check(
      'stop() returns promptly after a finite capture delivered its budget',
      ended && stopMs < 100 && device.loopCompleted && device.parserStats !== null,
      `ended=${ended} stopMs=${stopMs.toFixed(0)} loopCompleted=${device.loopCompleted} ` +
        `parser=${device.parserStats !== null}`,
    );
  }

  {
    const fake = new FakeUsb();
    fake.hangWhenEmpty = true;
    const device = await VllogicDevice.open(fake as unknown as USBDevice, {
      depth: 1, bytes: 8192, firstBlockMs: 60, drainIdleMs: 0,
    });
    let error: unknown = null;
    device.onError = (e) => { error = e; };
    const startedAt = performance.now();
    await device.startChannelMajor(
      { channels: 4, samplerate: 20e6, thresholdVolts: 1.65 },
      { begin: () => {}, channel: () => {}, commit: () => {} },
      undefined,
      { onEnd: () => { /* a wedged capture must not report a normal end */ } },
    );
    for (let i = 0; i < 50 && error === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ms = performance.now() - startedAt;
    await device.stop();
    const code = (error as { code?: string } | null)?.code ?? 'none';
    check(
      'a capture that never receives a data block fails with device.noData',
      code === 'device.noData' && ms < 500,
      `code=${code} after ${ms.toFixed(0)} ms`,
    );
  }

  {
    const fake = new FakeUsb();
    fake.varyDelay = true;
    const perBlock = 30; // 120 payload words, the firmware minimum
    const blocks = 16;
    const words: number[] = [];
    for (let i = 0; i < blocks; i++) {
      const payload: number[] = [];
      for (let s = 0; s < perBlock; s++) {
        const word = (((i * perBlock + s) * 0x9E3779B1) ^ 0xA5A5A5A5) >>> 0;
        words.push(word);
        payload.push(word, word, word, word);
      }
      fake.chunks.push(block(0xF, 120, i, payload));
    }
    const device = await VllogicDevice.open(fake as unknown as USBDevice);
    const store = new PlanarSampleStore({ channelCount: 4, samplerate: 20e6 });
    let ended = false;
    await device.startChannelMajor(
      { channels: 4, samplerate: 20e6, thresholdVolts: 1.65 },
      {
        begin: (channels) => store.beginFrame(channels),
        channel: (channel, start, wordsOfChannel) =>
          store.appendChannel(channel, start, wordsOfChannel),
        commit: (samples) => store.commitSamples(samples),
      },
      undefined,
      { deviceSampleLimit: blocks * perBlock * 32, onEnd: () => { ended = true; } },
    );
    for (let i = 0; i < 400 && !ended; i++) await new Promise((r) => setTimeout(r, 5));
    await device.stop();
    for (let i = 0; i < 200 && !ended; i++) await new Promise((r) => setTimeout(r, 5));
    const samples = blocks * perBlock * 32;
    const ordered = store.length >= samples && words.every((word, i) =>
      store.sampleAt(0, i * 32) === (word & 1) &&
      store.sampleAt(0, i * 32 + 31) === ((word >>> 31) & 1));
    if (!ordered) {
      const bad = words.findIndex((word, i) =>
        store.sampleAt(0, i * 32) !== (word & 1) ||
        store.sampleAt(0, i * 32 + 31) !== ((word >>> 31) & 1));
      const dump = [bad - 1, bad, bad + 1].map((i) => {
        let got = 0;
        for (let b = 0; b < 32; b++) got = (got | (store.sampleAt(0, i * 32 + b) << b)) >>> 0;
        return `${i}:${got.toString(16)}/${words[i]!.toString(16)}`;
      });
      console.error('ORDER bad', bad, dump.join(' '),
        'len', store.length, 'ended', ended);
    }
    check(
      'pipelined reads keep endpoint order under out-of-order completions',
      ended && fake.maxConcurrent >= 2 && store.length === samples && ordered,
      `ended=${ended} concurrent=${fake.maxConcurrent} length=${store.length}/${samples} ` +
        `ordered=${ordered} transfers=${device.readStats.transfers} ` +
        `bytes=${device.readStats.bytes} peak=${device.readStats.peakInFlight}`,
    );
  }

  const failed = results.filter((result) => !result.pass).length;
  console.log(results.map((result) =>
    `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
  console.log(`\n${results.length - failed}/${results.length} passed`);
  const proc = (globalThis as { process?: { exit(code: number): never } }).process;
  proc?.exit(failed === 0 ? 0 : 1);
}

void main();
