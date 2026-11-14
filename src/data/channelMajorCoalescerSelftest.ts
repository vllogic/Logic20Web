// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Offline checks for the channel-major commit coalescer.
 *
 *   node_modules/.bin/esbuild src/data/channelMajorCoalescerSelftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/coalescer.mjs && node /tmp/coalescer.mjs
 */

import { ChannelMajorCoalescer, displayBatchSamples } from './channelMajorCoalescer.js';
import { PlanarSampleStore } from './planarStore.js';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function block(seed: number): Uint32Array {
  const words = new Uint32Array(4); // four lanes, 32 samples each
  for (let i = 0; i < words.length; i++) words[i] = ((seed * 0x9E3779B1) ^ (i * 0x01010101)) >>> 0;
  return words;
}

function run(batch: number, blocks: number) {
  const store = new PlanarSampleStore({ channelCount: 4, samplerate: 20e6 });
  let commits = 0;
  const sink = new ChannelMajorCoalescer(store, batch, () => { commits += 1; });
  const payloads: Uint32Array[] = [];
  for (let b = 0; b < blocks; b++) {
    const words = block(b);
    payloads.push(words);
    sink.begin([0, 1, 2, 3]);
    for (let c = 0; c < 4; c++) sink.channel(c, b * 32, words.subarray(c, c + 1));
    sink.commit(32);
  }
  sink.flush();
  return { store, commits, sink, payloads };
}

{
  const at20 = displayBatchSamples(20e6);
  const at160 = displayBatchSamples(160e6);
  check('120 Hz batch is a whole 32-sample frame at both rates',
    at20 === 32 * Math.ceil(20e6 / 120 / 32) && at20 % 32 === 0 &&
      at160 === 32 * Math.ceil(160e6 / 120 / 32) && at160 % 32 === 0 && at20 > 0 && at160 > at20,
    `20M=${at20} 160M=${at160}`);
}

{
  // Reserve before the stream: the store must accept appends into preallocated
  // planes without changing what it publishes.
  const store = new PlanarSampleStore({ channelCount: 4, samplerate: 20e6 });
  store.reserveSamples(1024);
  const words = new Uint32Array(1).fill(0xAAAAAAAA);
  store.beginFrame([0, 1, 2, 3]);
  for (let c = 0; c < 4; c++) store.appendChannel(c, 0, words);
  store.commitSamples(32);
  check('reserveSamples preallocates without changing the published samples',
    store.length === 32 && store.sampleAt(0, 0) === 0 && store.sampleAt(0, 1) === 1 &&
      store.sampleAt(3, 31) === 1,
    `length=${store.length} b0=${store.sampleAt(0, 0)} b1=${store.sampleAt(0, 1)}`);
}

{
  const store = new PlanarSampleStore({ channelCount: 4, samplerate: 20e6 });
  store.reserveSamples(256);
  const chunk = new Uint8Array(64).fill(0x0F);
  store.append(chunk);
  const firstLength = store.length;
  store.reset();
  const empty = store.length;
  store.append(chunk);
  check('reset empties a store while keeping its allocation usable',
    firstLength === 64 && empty === 0 && store.length === 64 &&
      store.sampleAt(0, 0) === 1 && store.sampleAt(3, 63) === 1,
    `first=${firstLength} empty=${empty} again=${store.length}`);
}

{
  const { store, commits, payloads } = run(32, 3);
  const ordered = payloads.every((words, b) =>
    store.sampleAt(0, b * 32) === (words[0]! & 1) &&
    store.sampleAt(0, b * 32 + 31) === ((words[0]! >>> 31) & 1));
  check('batch=32 forwards every block and keeps the words in order',
    commits === 3 && store.length === 96 && ordered,
    `commits=${commits} length=${store.length} ordered=${ordered}`);
}

{
  const { store, commits, payloads, sink } = run(64, 5);
  const ordered = payloads.every((words, b) =>
    store.sampleAt(0, b * 32) === (words[0]! & 1) &&
    store.sampleAt(0, b * 32 + 31) === ((words[0]! >>> 31) & 1));
  check('batch=64 halves the commits, publishes the tail and keeps order',
    commits === 3 && store.length === 160 && sink.committedSamples === 160 && ordered,
    `commits=${commits} length=${store.length} committed=${sink.committedSamples} ordered=${ordered}`);
}

{
  let threw = false;
  const store = new PlanarSampleStore({ channelCount: 4, samplerate: 20e6 });
  const sink = new ChannelMajorCoalescer(store, 64);
  sink.begin([0, 1, 2, 3]);
  try { sink.channel(0, 32, block(0)); } catch { threw = true; }
  check('a channel that does not start at the batch origin is rejected', threw, `threw=${threw}`);
}

{
  let threw = false;
  const store = new PlanarSampleStore({ channelCount: 4, samplerate: 20e6 });
  const sink = new ChannelMajorCoalescer(store, 64);
  sink.begin([0, 1, 2, 3]);
  try { sink.channel(5, 0, new Uint32Array(1)); } catch { threw = true; }
  check('an undeclared channel is rejected', threw, `threw=${threw}`);
}

{
  const { store } = run(displayBatchSamples(20e6), 6000); // ~192 ms of blocks at 20 MHz
  check('a 120 Hz batch holds a growing capture without gaps',
    store.length === 6000 * 32,
    `length=${store.length}`);
}

{
  // A channel-major capture may stream a subset of the logical lanes. Only the active
  // planes may allocate; the untouched lanes must read as flat zero and cost nothing.
  const store = new PlanarSampleStore({ channelCount: 20, samplerate: 20e6 });
  store.setActiveChannels([2, 5, 19]);
  store.reserveSamples(32);
  const sink = new ChannelMajorCoalescer(store, 0);
  const words = new Uint32Array([0xAAAAAAAA, 0x0F0F0F0F, 0xFFFFFFFF]);
  sink.begin([2, 5, 19]);
  sink.channel(2, 0, words.subarray(0, 1));
  sink.channel(5, 0, words.subarray(1, 2));
  sink.channel(19, 0, words.subarray(2, 3));
  sink.commit(32);
  const full = new PlanarSampleStore({ channelCount: 20, samplerate: 20e6 });
  full.reserveSamples(32);
  const view = store.query(3, 0, 32, 8);
  check(
    'a sparse channel-major store allocates only the selected lanes',
    store.storedChannelCount === 3 && store.isChannelStored(2) &&
      !store.isChannelStored(3) && store.length === 32 &&
      store.sampleAt(2, 0) === 0 && store.sampleAt(19, 31) === 1 &&
      store.sampleAt(3, 0) === 0 && store.edges(3, 0, 32).length === 0 &&
      view.low.every((value) => value === 0) &&
      store.memory().totalBytes * 2 < full.memory().totalBytes,
    `stored=${store.storedChannelCount} len=${store.length} ` +
      `sparse=${store.memory().totalBytes} full=${full.memory().totalBytes}`,
  );
}

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
const proc = (globalThis as { process?: { exit(code: number): never } }).process;
proc?.exit(failed === 0 ? 0 : 1);
