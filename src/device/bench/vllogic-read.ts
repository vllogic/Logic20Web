// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Hardware bench for the Logic20 pipelined WebUSB reader. Not part of the app build:
 * open `/src/device/bench/index.html` on `npm run dev`, connect a Logic20 and run it.
 *
 * Each case re-opens the device with a different read geometry and records the elapsed
 * time, transfer statistics and how many store commits the sink needed. `batchMs`
 * coalesces commits to a display-like cadence (8.33 ms is 120 Hz) so its cost can be
 * compared with the per-block sink. Copy the JSON at the end and paste it back.
 */

import { VllogicDevice } from '../vllogic.js';
import { PlanarSampleStore } from '../../data/planarStore.js';
import { CHANNEL_COUNTS, isChannelCount, type ChannelCount } from '../../types.js';

const VLLOGIC_VID = 0x1209;
const VLLOGIC_PID = 0x6688;
const CAPTURE_TIMEOUT_MS = 20_000;

interface BenchCase {
  depth: number;
  readKiB: number;
  batchMs: number;
  drainIdleMs: number;
}

interface BenchResult extends BenchCase {
  rate: number;
  channels: number;
  seconds: number;
  target: number;
  elapsedMs: number;
  configMs: number;
  ended: boolean;
  storeLength: number;
  commits: number;
  sinkMs: number;
  transfers: number;
  bytes: number;
  shortReads: number;
  avgTransferMs: number;
  maxTransferMs: number;
  peakInFlight: number;
  lineMBs: number;
  effMSa: number;
  avgReadBytes: number;
  inFlightKiB: number;
  parser: {
    payloadWords: number; junkBytes: number; crcFail: number; badLen: number;
    maskMismatch: number; dropBlocks: number; seqJumps: number; partialSnapshots: number;
  } | null;
  error?: string;
}

/**
 * A ChannelSampleSink that can either forward every device block (batchMs = 0) or
 * coalesce blocks until `batchSamples` have arrived, then publish one store frame.
 * Words are copied because the parser reuses its batch buffer synchronously.
 */
class BenchSink {
  commits = 0;
  sinkMs = 0;
  private start = 0;
  private pending = 0;
  private channels: readonly number[] = [];
  private words: Uint32Array[] = [];
  private used: number[] = [];

  constructor(
    private readonly store: PlanarSampleStore,
    private readonly batchSamples: number,
  ) {}

  begin(channels: readonly number[]): void {
    if (this.pending > 0) return;
    this.channels = channels;
    this.start = this.store.length;
    const capacity = this.batchSamples > 0 ? Math.ceil(this.batchSamples / 32) : 1024;
    if (this.words.length !== channels.length || this.words[0]!.length < capacity) {
      this.words = channels.map(() => new Uint32Array(capacity));
    }
    if (this.used.length !== channels.length) this.used = channels.map(() => 0);
    for (let i = 0; i < this.used.length; i++) this.used[i] = 0;
  }

  channel(channel: number, startSample: number, words: Uint32Array): void {
    if (startSample !== this.start + this.pending) {
      throw new Error(`channel ${channel} starts at ${startSample}, expected ${this.start + this.pending}`);
    }
    const index = this.channels.indexOf(channel);
    if (index < 0) return;
    const used = this.used[index]!;
    const need = used + words.length;
    let buffer = this.words[index]!;
    if (need > buffer.length) {
      const grown = new Uint32Array(Math.max(need, buffer.length * 2));
      grown.set(buffer.subarray(0, used));
      this.words[index] = grown;
      buffer = grown;
    }
    buffer.set(words, used);
    this.used[index] = need;
  }

  commit(samples: number): void {
    this.pending += samples;
    if (this.batchSamples > 0 && this.pending < this.batchSamples) return;
    this.flush();
  }

  flush(): void {
    if (this.pending === 0) return;
    const started = performance.now();
    this.store.beginFrame(this.channels);
    for (let i = 0; i < this.channels.length; i++) {
      this.store.appendChannel(this.channels[i]!, this.start, this.words[i]!.subarray(0, this.used[i]!));
    }
    this.store.commitSamples(this.pending);
    this.sinkMs += performance.now() - started;
    this.commits += 1;
    this.start += this.pending;
    this.pending = 0;
    for (let i = 0; i < this.used.length; i++) this.used[i] = 0;
  }
}

const rateInput = document.getElementById('rate') as HTMLInputElement;
const channelsInput = document.getElementById('channels') as HTMLInputElement;
const secondsInput = document.getElementById('seconds') as HTMLInputElement;
const batchInput = document.getElementById('batch') as HTMLInputElement;
const depthsInput = document.getElementById('depths') as HTMLInputElement;
const readsInput = document.getElementById('reads') as HTMLInputElement;
const connectButton = document.getElementById('connect') as HTMLButtonElement;
const runButton = document.getElementById('run') as HTMLButtonElement;
const copyButton = document.getElementById('copy') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLDivElement;
const table = document.getElementById('table') as HTMLTableElement;
const rows = document.getElementById('rows') as HTMLTableSectionElement;
const json = document.getElementById('json') as HTMLTextAreaElement;
const targetNote = document.getElementById('target-note') as HTMLSpanElement;

const results: BenchResult[] = [];
let usb: USBDevice | null = null;

function numbers(value: string): number[] {
  return value.split(',').map((part) => Number(part.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

function updateTargetNote(): void {
  const rate = Number(rateInput.value);
  const seconds = Number(secondsInput.value);
  targetNote.textContent = Number.isFinite(rate) && Number.isFinite(seconds)
    ? `${Math.round(rate * seconds).toLocaleString()}（${rate.toLocaleString()} Hz × ${seconds} s）`
    : '';
}

rateInput.addEventListener('input', updateTargetNote);
secondsInput.addEventListener('input', updateTargetNote);
updateTargetNote();

function setStatus(text: string): void {
  status.textContent = text;
}

connectButton.addEventListener('click', async () => {
  try {
    usb = await navigator.usb.requestDevice({
      filters: [{ vendorId: VLLOGIC_VID, productId: VLLOGIC_PID }],
    });
    setStatus(`已连接：${usb.productName ?? 'Logic20'} ${usb.serialNumber ?? ''}`);
    runButton.disabled = false;
    connectButton.disabled = true;
  } catch (e) {
    setStatus(`连接失败：${e instanceof Error ? e.message : String(e)}`);
  }
});

function row(result: BenchResult): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const cells = result.error !== undefined
    ? ['ERROR', result.error]
    : [
      `${result.depth}×${result.readKiB}K/${result.batchMs}`,
      String(result.elapsedMs),
      String(result.configMs),
      result.lineMBs.toFixed(2),
      result.effMSa.toFixed(2),
      String(result.transfers),
      result.avgTransferMs.toFixed(2),
      result.maxTransferMs.toFixed(2),
      String(result.shortReads),
      String(result.peakInFlight),
      String(result.commits),
      result.sinkMs.toFixed(1),
      `${result.storeLength}/${result.target}`,
    ];
  for (const text of cells) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.append(td);
  }
  return tr;
}

async function runCase(bench: BenchCase): Promise<BenchResult> {
  const rate = Number(rateInput.value);
  const requestedChannels = Math.round(Number(channelsInput.value));
  if (!isChannelCount(requestedChannels)) {
    throw new Error(`通道数必须是 ${CHANNEL_COUNTS.join('/')} 之一`);
  }
  const channels: ChannelCount = requestedChannels;
  const seconds = Number(secondsInput.value);
  const target = Math.round(rate * seconds);
  const batchSamples = bench.batchMs > 0
    ? Math.max(32, Math.ceil((rate * bench.batchMs) / 1000 / 32) * 32)
    : 0;
  const base: BenchResult = {
    ...bench, rate, channels, seconds, target,
    elapsedMs: 0, configMs: 0, ended: false, storeLength: 0, commits: 0, sinkMs: 0,
    transfers: 0, bytes: 0, shortReads: 0, avgTransferMs: 0, maxTransferMs: 0,
    peakInFlight: 0, lineMBs: 0, effMSa: 0, avgReadBytes: 0, inFlightKiB: 0,
    parser: null,
  };

  if (!usb) throw new Error('device is not connected');
  const device = await VllogicDevice.open(usb, {
    depth: bench.depth,
    bytes: bench.readKiB * 1024,
    firstBlockMs: 1000,
    drainIdleMs: bench.drainIdleMs,
  });
  const store = new PlanarSampleStore({ channelCount: channels, samplerate: rate });
  const sink = new BenchSink(store, batchSamples);
  let ended = false;
  let endedAt = 0;
  const started = performance.now();
  try {
    await device.startChannelMajor(
      { channels, samplerate: rate, thresholdVolts: 1.65 },
      {
        begin: (chs) => sink.begin(chs),
        channel: (ch, start, words) => sink.channel(ch, start, words),
        commit: (samples) => sink.commit(samples),
      },
      undefined,
      { deviceSampleLimit: target, onEnd: () => { ended = true; endedAt = performance.now(); } },
    );
    while (!ended && store.length < target && performance.now() - started < CAPTURE_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    sink.flush();
    const stats = device.readStats;
    const endedAtSafe = endedAt > 0 ? endedAt : performance.now();
    const elapsed = Math.max(1, endedAtSafe - stats.startedAt);
    return {
      ...base,
      elapsedMs: Math.round(elapsed),
      configMs: Math.max(0, Math.round(stats.startedAt - started)),
      ended: ended || store.length >= target,
      storeLength: store.length,
      commits: sink.commits,
      sinkMs: Number(sink.sinkMs.toFixed(1)),
      transfers: stats.transfers,
      bytes: stats.bytes,
      shortReads: stats.shortReads,
      avgTransferMs: stats.transfers > 0 ? Number((stats.sumTransferMs / stats.transfers).toFixed(2)) : 0,
      maxTransferMs: Number(stats.maxTransferMs.toFixed(2)),
      peakInFlight: stats.peakInFlight,
      lineMBs: Number((stats.bytes / 1e6 / (elapsed / 1000)).toFixed(2)),
      effMSa: Number((store.length / 1e6 / (elapsed / 1000)).toFixed(2)),
      avgReadBytes: stats.transfers > 0 ? Math.round(stats.bytes / stats.transfers) : 0,
      inFlightKiB: stats.transfers > 0
        ? Number(((bench.depth * (stats.bytes / stats.transfers)) / 1024).toFixed(0)) : 0,
      parser: device.parserStats ? { ...device.parserStats } : null,
    };
  } finally {
    await device.release();
  }
}

runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  connectButton.disabled = true;
  copyButton.disabled = true;
  results.length = 0;
  rows.replaceChildren();
  table.hidden = false;
  json.value = '';

  const depths = numbers(depthsInput.value).map((n) => Math.round(n));
  const reads = numbers(readsInput.value).map((n) => Math.round(n));
  const batches = numbers(batchInput.value);
  if (batches.length === 0) batches.push(0);

  const cases: BenchCase[] = [];
  for (const depth of depths) {
    for (const readKiB of reads) {
      for (const batchMs of batches) cases.push({ depth, readKiB, batchMs, drainIdleMs: 0 });
    }
  }

  for (let i = 0; i < cases.length; i++) {
    const bench = cases[i]!;
    setStatus(`运行 ${i + 1}/${cases.length}：depth ${bench.depth}，read ${bench.readKiB} KiB，batch ${bench.batchMs} ms`);
    let result: BenchResult;
    try {
      result = await runCase(bench);
    } catch (e) {
      result = {
        ...bench,
        rate: Number(rateInput.value),
        channels: Number(channelsInput.value),
        seconds: Number(secondsInput.value),
        target: 0,
        elapsedMs: 0,
        configMs: 0,
        ended: false,
        storeLength: 0,
        commits: 0,
        sinkMs: 0,
        transfers: 0,
        bytes: 0,
        shortReads: 0,
        avgTransferMs: 0,
        maxTransferMs: 0,
        peakInFlight: 0,
        lineMBs: 0,
        effMSa: 0,
        avgReadBytes: 0,
        inFlightKiB: 0,
        parser: null,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      };
      setStatus(`第 ${i + 1} 组失败：${result.error}`);
    }
    results.push(result);
    rows.append(row(result));
    json.value = JSON.stringify(results, null, 2);
  }

  setStatus(`完成 ${results.length} 组。复制下方 JSON 反馈即可。`);
  runButton.disabled = false;
  copyButton.disabled = false;
});

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(json.value);
    setStatus('已复制 JSON 到剪贴板。');
  } catch {
    json.select();
    document.execCommand('copy');
    setStatus('已复制 JSON（回退路径）。');
  }
});
