// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Hardware page for the Logic20 pre-START drain. Not part of the app build.
 *
 * Open `/src/device/bench/drain.html` on `npm run dev` (or `npm run dev:lan` from a
 * phone on the same Wi-Fi) and connect a Logic20. Each cycle records what the optional
 * drain saw before START, whether its pending read became the capture's first read,
 * the first-block latency, and the parser counters. Consecutive cycles also prove that
 * stop() leaves no read loop behind: a parked loop shows up as a stop time at the
 * 750 ms settle ceiling and as missing later cycles.
 */

import { VllogicDevice } from '../vllogic.js';
import { PlanarSampleStore } from '../../data/planarStore.js';
import { ChannelMajorCoalescer, displayBatchSamples } from '../../data/channelMajorCoalescer.js';
import { CHANNEL_COUNTS, isChannelCount, type ChannelCount } from '../../types.js';

const VLLOGIC_VID = 0x1209;
const VLLOGIC_PID = 0x6688;
const CAPTURE_TIMEOUT_MS = 20_000;
const CLOSE_SETTLE_MS = 700;

interface CycleResult {
  cycle: number;
  rate: number;
  channels: number;
  seconds: number;
  target: number;
  batchMs: number;
  depth: number;
  readKiB: number;
  drainIdleMs: number;
  configMs: number;
  drain: {
    enabled: boolean; reads: number; bytes: number; preArmed: boolean; ms: number;
  };
  firstBlockMs: number | null;
  runMs: number;
  storeLength: number;
  effMSa: number;
  lineMBs: number;
  transfers: number;
  shortReads: number;
  peakInFlight: number;
  stopMs: number;
  parser: {
    acks: number; dataBlocks: number; crcFail: number; badLen: number;
    maskMismatch: number; dropBlocks: number; seqJumps: number; partialSnapshots: number;
  } | null;
  ended: boolean;
  error: string | null;
}

const rateInput = document.getElementById('rate') as HTMLSelectElement;
const channelsInput = document.getElementById('channels') as HTMLSelectElement;
const secondsInput = document.getElementById('seconds') as HTMLInputElement;
const cyclesInput = document.getElementById('cycles') as HTMLInputElement;
const drainInput = document.getElementById('drain') as HTMLInputElement;
const batchInput = document.getElementById('batch') as HTMLInputElement;
const depthInput = document.getElementById('depth') as HTMLInputElement;
const readKiBInput = document.getElementById('readKiB') as HTMLInputElement;
const gapInput = document.getElementById('gap') as HTMLInputElement;
const connectButton = document.getElementById('connect') as HTMLButtonElement;
const runButton = document.getElementById('run') as HTMLButtonElement;
const copyButton = document.getElementById('copy') as HTMLButtonElement;
const statusLine = document.getElementById('status') as HTMLDivElement;
const table = document.getElementById('table') as HTMLTableElement;
const rows = document.getElementById('rows') as HTMLTableSectionElement;
const json = document.getElementById('json') as HTMLTextAreaElement;

const results: CycleResult[] = [];
let usb: USBDevice | null = null;

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
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
    setStatus(`连接失败：${errorText(e)}`);
  }
});

function row(result: CycleResult): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (result.error !== null) tr.className = 'bad';
  const cells = [
    String(result.cycle),
    result.batchMs.toFixed(2),
    String(result.drainIdleMs),
    String(result.drain.reads),
    String(result.drain.bytes),
    result.drain.preArmed ? '是' : '否',
    String(Math.round(result.configMs)),
    result.firstBlockMs === null ? '—' : result.firstBlockMs.toFixed(1),
    String(Math.round(result.runMs)),
    `${result.storeLength}/${result.target}`,
    result.effMSa.toFixed(2),
    result.lineMBs.toFixed(1),
    String(result.parser?.acks ?? '—'),
    String(result.parser?.crcFail ?? '—'),
    String(result.parser?.maskMismatch ?? '—'),
    String(result.parser?.dropBlocks ?? '—'),
    String(result.parser?.seqJumps ?? '—'),
    String(result.shortReads),
    String(Math.round(result.stopMs)),
    result.error ?? (result.ended ? 'OK' : '未完成'),
  ];
  for (const text of cells) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.append(td);
  }
  return tr;
}

async function runCycle(cycle: number): Promise<CycleResult> {
  const rate = Number(rateInput.value);
  const requestedChannels = Number(channelsInput.value);
  if (!isChannelCount(requestedChannels) || !CHANNEL_COUNTS.includes(requestedChannels)) {
    throw new Error('通道数不在支持范围内');
  }
  const channels: ChannelCount = requestedChannels;
  const seconds = Number(secondsInput.value);
  const target = Math.round(rate * seconds);
  const depth = Math.max(1, Math.round(Number(depthInput.value)));
  const readKiB = Math.max(4, Math.round(Number(readKiBInput.value)));
  const drainIdleMs = Math.max(0, Math.round(Number(drainInput.value)));
  const batchMs = Math.max(0, Number(batchInput.value));
  const base: CycleResult = {
    cycle, rate, channels, seconds, target, batchMs, depth, readKiB, drainIdleMs,
    configMs: 0,
    drain: { enabled: false, reads: 0, bytes: 0, preArmed: false, ms: 0 },
    firstBlockMs: null, runMs: 0, storeLength: 0, effMSa: 0, lineMBs: 0,
    transfers: 0, shortReads: 0, peakInFlight: 0, stopMs: 0, parser: null,
    ended: false, error: null,
  };
  if (!usb) throw new Error('设备未连接');

  const device = await VllogicDevice.open(usb, {
    depth, bytes: readKiB * 1024, firstBlockMs: 1000, drainIdleMs,
  });
  const store = new PlanarSampleStore({ channelCount: channels, samplerate: rate });
  const batchSamples = batchMs > 0
    ? displayBatchSamples(rate, 1000 / batchMs)
    : 0;
  const markFirstCommit = (): void => {
    if (firstCommitAt === 0) firstCommitAt = performance.now();
  };
  // Match the app's production path when batching is on: one 120 Hz-class commit
  // instead of one commit per device block. batchMs = 0 keeps the per-block path.
  const coalescer = batchSamples > 0
    ? new ChannelMajorCoalescer({
      beginFrame: (chs) => store.beginFrame(chs),
      appendChannel: (ch, start, words) => store.appendChannel(ch, start, words),
      commitSamples: (samples) => store.commitSamples(samples),
    }, batchSamples, markFirstCommit)
    : null;
  const sink = coalescer ?? {
    begin: (chs: readonly number[]) => store.beginFrame(chs),
    channel: (ch: number, start: number, words: Uint32Array) =>
      store.appendChannel(ch, start, words),
    commit: (samples: number) => {
      store.commitSamples(samples);
      markFirstCommit();
    },
  };
  let ended = false;
  let endedAt = 0;
  let firstCommitAt = 0;
  let failure: string | null = null;
  device.onError = (e) => { failure = errorText(e); };

  const startedAt = performance.now();
  try {
    await device.startChannelMajor(
      { channels, samplerate: rate, thresholdVolts: 1.65 },
      sink,
      undefined,
      {
        deviceSampleLimit: target,
        onEnd: () => { ended = true; endedAt = performance.now(); },
      },
    );
    const armedAt = performance.now();
    base.configMs = armedAt - startedAt;
    base.drain = { ...device.drainStats };

    while (!ended && failure === null && performance.now() - armedAt < CAPTURE_TIMEOUT_MS) {
      await delay(10);
    }
    // A pending coalescer batch is part of the capture: publish it before measuring.
    coalescer?.flush();
    const runEnd = endedAt > 0 ? endedAt : performance.now();
    base.runMs = runEnd - armedAt;
    base.firstBlockMs = firstCommitAt > 0 ? firstCommitAt - armedAt : null;
    base.storeLength = store.length;
    base.effMSa = store.length / 1e6 / (Math.max(1, base.runMs) / 1000);
  } catch (e) {
    failure = errorText(e);
  }

  const stopStart = performance.now();
  try {
    await device.stop();
  } catch (e) {
    failure ??= errorText(e);
  }
  base.stopMs = performance.now() - stopStart;
  // The parser counters are final only after stop() joined the read loop.
  const elapsedSec = Math.max(0.001, base.runMs / 1000);
  base.transfers = device.readStats.transfers;
  base.shortReads = device.readStats.shortReads;
  base.peakInFlight = device.readStats.peakInFlight;
  base.lineMBs = device.readStats.bytes / 1e6 / elapsedSec;
  base.parser = device.parserStats
    ? {
      acks: device.parserStats.acks,
      dataBlocks: device.parserStats.dataBlocks,
      crcFail: device.parserStats.crcFail,
      badLen: device.parserStats.badLen,
      maskMismatch: device.parserStats.maskMismatch,
      dropBlocks: device.parserStats.dropBlocks,
      seqJumps: device.parserStats.seqJumps,
      partialSnapshots: device.parserStats.partialSnapshots,
    }
    : null;
  device.terminate();
  await delay(CLOSE_SETTLE_MS);

  base.ended = ended;
  base.error = failure;
  return base;
}

runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  connectButton.disabled = true;
  copyButton.disabled = true;
  results.length = 0;
  rows.replaceChildren();
  table.hidden = false;
  json.value = '';

  const total = Math.max(1, Math.round(Number(cyclesInput.value)));
  const gap = Math.max(0, Math.round(Number(gapInput.value)));
  for (let i = 0; i < total; i++) {
    setStatus(`运行第 ${i + 1}/${total} 轮…`);
    try {
      const result = await runCycle(i + 1);
      results.push(result);
      rows.append(row(result));
    } catch (e) {
      const failure: CycleResult = {
        cycle: i + 1,
        rate: Number(rateInput.value), channels: Number(channelsInput.value),
        seconds: Number(secondsInput.value), target: 0,
        batchMs: Number(batchInput.value), depth: 0, readKiB: 0,
        drainIdleMs: Number(drainInput.value), configMs: 0,
        drain: { enabled: false, reads: 0, bytes: 0, preArmed: false, ms: 0 },
        firstBlockMs: null, runMs: 0, storeLength: 0, effMSa: 0, lineMBs: 0,
        transfers: 0, shortReads: 0, peakInFlight: 0, stopMs: 0, parser: null,
        ended: false, error: errorText(e),
      };
      results.push(failure);
      rows.append(row(failure));
    }
    json.value = JSON.stringify(results, null, 2);
    if (gap > 0 && i + 1 < total) await delay(gap);
  }
  const bad = results.filter((r) => r.error !== null || !r.ended).length;
  setStatus(bad === 0
    ? `完成：${results.length} 轮全部正常。`
    : `完成：${results.length} 轮，${bad} 轮异常，详见表格/JSON。`);
  runButton.disabled = false;
  connectButton.disabled = true;
  copyButton.disabled = false;
});

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(json.value);
    setStatus('JSON 已复制。');
  } catch (e) {
    setStatus(`复制失败：${errorText(e)}`);
  }
});
