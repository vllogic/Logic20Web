// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VLLogic driver authors
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
import { VllogicDevice } from './vllogic.js';
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
  const plen = payload.length * 4;
  const w1 = mask >>> 0;
  const w2 = (div << 15) >>> 0;
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
  readonly chunks: Uint8Array[] = [];
  readonly commands: Array<{ cmd: number; param: number }> = [];
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
    while (!this.started) await new Promise((resolve) => setTimeout(resolve, 2));
    const chunk = this.chunks.shift();
    if (!chunk) return { status: 'ok', data: new DataView(new ArrayBuffer(0)) };
    return {
      status: 'ok',
      data: new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    };
  }
}

async function main(): Promise<void> {
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
  const snapshots = 5;
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

  // A payload cut by end-of-stream must not invent a snapshot.
  let delivered = 0;
  const cut = new VllogicParser(map, (_words, batchSnapshots) => { delivered += batchSnapshots; });
  cut.feed(block(0xFFFFF, 15, 10, [0x1, 0x2, 0x3]));
  cut.finish();
  check(
    'a truncated snapshot is dropped at end of stream',
    delivered === 0,
    `delivered=${delivered}`,
  );

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

  const failed = results.filter((result) => !result.pass).length;
  console.log(results.map((result) =>
    `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
  console.log(`\n${results.length - failed}/${results.length} passed`);
  const proc = (globalThis as { process?: { exit(code: number): never } }).process;
  proc?.exit(failed === 0 ? 0 : 1);
}

void main();
