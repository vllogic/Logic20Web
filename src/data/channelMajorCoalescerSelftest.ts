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

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
const proc = (globalThis as { process?: { exit(code: number): never } }).process;
proc?.exit(failed === 0 ? 0 : 1);
