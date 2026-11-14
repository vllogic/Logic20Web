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
  let buffers: Uint32Array[] = [];

  return {
    beginFrame: (next) => {
      channels = next;
      startSample = 0;
      buffers = next.map(() => new Uint32Array(0));
    },
    appendChannel: (channel, start, words) => {
      const index = channels.indexOf(channel);
      if (index < 0) return;
      startSample = start;
      buffers[index] = words.slice();
    },
    commitSamples: (samples) => {
      const message: VllogicBatchMessage = {
        kind: 'batch',
        channels: [...channels],
        startSample,
        words: buffers.map((words) => words.buffer as ArrayBuffer),
        samples,
      };
      // Transferring hands each frame buffer to the page; the coalescer allocates fresh
      // ones for the next frame anyway.
      post(message, message.words);
    },
  };
}

async function handle(message: Exclude<VllogicToWorker, { kind: 'terminate' }>): Promise<void> {
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
      const sink = new ChannelMajorCoalescer(sender(), frame);
      coalescer = sink;
      await running.startChannelMajor(
        message.cfg,
        sink,
        (position, missing) => post({ kind: 'dropout', position, missing }),
        {
          ...(message.deviceSampleLimit > 0
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
