// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * The Logic20 transport, on a thread of its own.
 *
 * Everything here runs in a Dedicated Worker. The page only sees coalesced
 * channel-major batches, so a GC pause or a slow frame on the page cannot delay a
 * `transferIn` resubmission - which is exactly the failure the page-side read loop hit
 * at 320 MB/s (27 ms average completion, 105 ms worst, a drop in every capture).
 *
 * WebUSB exposes `getDevices()` in workers but not `requestDevice`, so the one-time grant
 * stays a page-side user gesture; the worker opens the device the origin already has
 * permission for.
 */

import {
  ChannelMajorCoalescer, displayBatchSamples, type ChannelMajorTarget,
} from '../data/channelMajorCoalescer.js';
import { wireDiagnostic } from '../diagnostics.js';
import { VllogicDevice } from './vllogic.js';
import type {
  VllogicBatchMessage, VllogicFromWorker, VllogicToWorker,
} from './vllogicWorkerProtocol.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let device: VllogicDevice | null = null;
let coalescer: ChannelMajorCoalescer | null = null;
/**
 * Batch buffers returned by the page. Without the pool the worker would allocate 2.66 MB
 * every 8.33 ms (320 MB/s) and leave it for its own GC, which shares the event loop with
 * the reads it is protecting.
 */
const pool: ArrayBuffer[] = [];
let nextBatchId = 1;
let batchBytes = 0;

function post(message: VllogicFromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function describeFailure(error: unknown): Extract<VllogicFromWorker, { kind: 'error' }> {
  return {
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
    ...(wireDiagnostic(error) ?? {}),
  };
}

/**
 * A coalescer target that turns one 120 Hz frame into one transferred message. The
 * coalescer owns the frame buffers and reuses them, so each channel's words are copied
 * once into a buffer the page then owns.
 */
function sender(): ChannelMajorTarget {
  let channels: readonly number[] = [];
  let startSample = 0;
  const pending: Array<{ channel: number; words: Uint32Array }> = [];

  return {
    beginFrame: (next) => {
      channels = next;
      startSample = 0;
      pending.length = 0;
    },
    appendChannel: (channel, start, words) => {
      if (!channels.includes(channel)) return;
      startSample = start;
      pending.push({ channel, words });
    },
    commitSamples: (samples) => {
      let total = 0;
      for (const entry of pending) total += entry.words.length;
      const need = total * 4;
      // Prefer a buffer the page has already returned; allocating 2.66 MB per frame is
      // what put the worker's GC on the read loop's critical path.
      let buffer = pool.pop();
      if (!buffer || buffer.byteLength < need) {
        buffer = new ArrayBuffer(Math.max(need, batchBytes));
      }
      const out = new Uint32Array(buffer);
      const offsets: number[] = [];
      const lengths: number[] = [];
      let at = 0;
      for (const entry of pending) {
        out.set(entry.words, at);
        offsets.push(at);
        lengths.push(entry.words.length);
        at += entry.words.length;
      }
      const message: VllogicBatchMessage = {
        kind: 'batch',
        id: nextBatchId++,
        channels: pending.map((entry) => entry.channel),
        startSample,
        buffer,
        offsets,
        lengths,
        samples,
      };
      // One transferable per frame: the page owns it, and returns it with an ack. The
      // `buffer` here is freshly allocated because `pending` holds views into the
      // coalescer's buffers; the ack lets the next frame reuse this allocation.
      post(message, [buffer]);
    },
  };
}

async function handle(
  message: Exclude<VllogicToWorker, { kind: 'terminate' } | { kind: 'ack' }>,
): Promise<void> {
  switch (message.kind) {
    case 'open': {
      const all = await navigator.usb.getDevices();
      const usb = all.find((candidate) =>
        candidate.vendorId === message.filter.vendorId &&
        candidate.productId === message.filter.productId &&
        (message.filter.serial === undefined || candidate.serialNumber === message.filter.serial));
      if (!usb) {
        throw new Error('the Logic20 is not visible to this worker');
      }
      const instance = await VllogicDevice.open(usb, message.tuning);
      instance.onError = (error) => post(describeFailure(error));
      device = instance;
      post({
        kind: 'opened',
        name: instance.name,
        serial: instance.serial,
      });
      return;
    }

    case 'start': {
      if (!device) throw new Error('start before open');
      const running = device;
      const frame = displayBatchSamples(message.cfg.samplerate, 120);
      batchBytes = Math.ceil(frame / 32) * message.cfg.channels * 4;
      // A new geometry invalidates the pooled sizes; eight frames is ~66 ms of page
      // slack, after which the worker starts allocating again.
      pool.length = 0;
      for (let i = 0; i < 8; i++) pool.push(new ArrayBuffer(batchBytes));
      const sink = new ChannelMajorCoalescer(sender(), frame);
      coalescer = sink;
      await running.startChannelMajor(
        message.cfg,
        sink,
        (position, missing) => post({ kind: 'dropout', position, missing }),
        {
          ...(message.loop ? { loop: true } : {}),
          ...(!message.loop && message.deviceSampleLimit > 0
            ? { deviceSampleLimit: message.deviceSampleLimit }
            : {}),
          onEnd: () => {
            // Publish the sub-frame tail first, then say the capture is over: the page
            // must see every sample before it learns there are no more.
            sink.flush();
            post({ kind: 'ended' });
          },
        },
      );
      post({ kind: 'started' });
      return;
    }

    case 'stop': {
      if (device) {
        await device.stop().catch(() => undefined);
        coalescer?.flush();
        post({
          kind: 'stats',
          read: {
            transfers: device.readStats.transfers,
            bytes: device.readStats.bytes,
            shortReads: device.readStats.shortReads,
            sumTransferMs: device.readStats.sumTransferMs,
            maxTransferMs: device.readStats.maxTransferMs,
            peakInFlight: device.readStats.peakInFlight,
            elapsedMs: Math.max(1, performance.now() - device.readStats.startedAt),
          },
          parser: device.parserStats ? { ...device.parserStats } : null,
          drain: { ...device.drainStats },
        });
      }
      coalescer = null;
      post({ kind: 'stopped' });
      return;
    }
  }
}

scope.onmessage = (event: MessageEvent<VllogicToWorker>) => {
  const message = event.data;
  if (message.kind === 'ack') {
    pool.push(message.buffer);
    if (pool.length > 16) pool.length = 16;
    return;
  }
  if (message.kind === 'terminate') {
    void (async () => {
      if (device) {
        await device.stop().catch(() => undefined);
        device.terminate();
      }
      scope.close();
    })();
    return;
  }
  void handle(message).catch((error) => {
    // A failed stop must still release the page waiting on `stopped`.
    if (message.kind === 'stop') post({ kind: 'stopped' });
    post(describeFailure(error));
  });
};
