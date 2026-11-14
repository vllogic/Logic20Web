// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * The page's handle on the Logic20 transport that lives in `vllogicWorker.ts`.
 *
 * The worker owns the read loop and the UHSIF parser, so a page that is drawing,
 * decoding or collecting garbage cannot delay a transferIn resubmission. This side only
 * writes the batches the worker hands over into the planar store.
 */

import { DiagnosticError, fromWireDiagnostic } from '../diagnostics.js';
import type { Device } from './types.js';
import type {
  CaptureConfig, CaptureStartOptions, ChannelSampleSink, DropoutSink,
} from './types.js';
import {
  VLLOGIC_NUM_CHANNELS,
  VLLOGIC_RATES,
  VLLOGIC_THRESHOLD_PRESETS,
} from './vllogicProtocol.js';
import { VllogicDevice, vllogicReadTuning, type VllogicReadTuning } from './vllogic.js';
import type {
  VllogicDeviceFilter, VllogicFromWorker, VllogicToWorker,
} from './vllogicWorkerProtocol.js';

const OPEN_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;

let installedSpawn: (() => Worker) | null = null;

/** Installed by `vllogicWorkerSpawn.ts`; the offline suite never needs a real worker. */
export function installVllogicWorkerSpawn(spawn: () => Worker): void {
  installedSpawn = spawn;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeout(ms: number, kind: string): Promise<never> {
  return delay(ms).then(() => {
    throw new DiagnosticError('device.workerTimeout', { kind, ms });
  });
}

function asError(message: Extract<VllogicFromWorker, { kind: 'error' }>): Error {
  return fromWireDiagnostic(message);
}

export class WorkerVllogicDevice implements Device {
  readonly sampleLayout = 'channel-major' as const;
  readonly maxChannels = VLLOGIC_NUM_CHANNELS;
  readonly sampleratesHz = VLLOGIC_RATES.map((entry) => entry.rate);
  readonly maxSamplerateHz: Readonly<Record<number, number>> = {
    4: 800_000_000,
    8: 400_000_000,
    16: 200_000_000,
    20: 160_000_000,
  };
  readonly recommendedSamplerateHz: Readonly<Record<number, number>> = {
    4: 800_000_000,
    8: 400_000_000,
    16: 200_000_000,
    20: 100_000_000,
  };
  readonly thresholdRange = { min: -2.5, max: 5.0 };
  readonly thresholdPresets = VLLOGIC_THRESHOLD_PRESETS;
  readonly name: string;
  readonly serial: string;

  onError: ((error: unknown) => void) | null = null;

  private sink: ChannelSampleSink | null = null;
  private onDropout: DropoutSink | null = null;
  private onEnd: (() => void) | null = null;
  private startWaiter: (() => void) | null = null;
  private startFailure: ((error: Error) => void) | null = null;
  private stopWaiter: (() => void) | null = null;
  private failure: Error | null = null;
  private closed = false;

  private constructor(
    private readonly worker: Worker,
    name: string,
    serial: string,
  ) {
    this.name = name;
    this.serial = serial;
    worker.onmessage = (event: MessageEvent<VllogicFromWorker>) => this.onMessage(event.data);
    worker.onerror = (event) => {
      const error = new Error(event.message || 'the Logic20 worker failed');
      this.fail(error);
    };
    worker.onmessageerror = () => this.fail(new Error('the Logic20 worker sent an unreadable message'));
  }

  static async open(usb: USBDevice, tuning?: VllogicReadTuning): Promise<WorkerVllogicDevice> {
    const spawn = installedSpawn;
    if (!spawn) throw new DiagnosticError('device.workerUnavailable');
    const worker = spawn();
    const opened = new Promise<Extract<VllogicFromWorker, { kind: 'opened' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DiagnosticError('device.workerTimeout', {
        kind: 'open', ms: OPEN_TIMEOUT_MS,
      })), OPEN_TIMEOUT_MS);
      const check = (event: MessageEvent<VllogicFromWorker>): void => {
        if (event.data.kind === 'opened') {
          clearTimeout(timer);
          worker.removeEventListener('message', check);
          resolve(event.data);
        } else if (event.data.kind === 'error') {
          clearTimeout(timer);
          worker.removeEventListener('message', check);
          reject(asError(event.data));
        }
      };
      worker.addEventListener('message', check);
    });
    const filter: VllogicDeviceFilter = {
      vendorId: usb.vendorId,
      productId: usb.productId,
      ...(usb.serialNumber ? { serial: usb.serialNumber } : {}),
    };
    const message: VllogicToWorker = {
      kind: 'open', filter, tuning: tuning ?? vllogicReadTuning(),
    };
    worker.postMessage(message);
    try {
      const hello = await opened;
      return new WorkerVllogicDevice(worker, hello.name, hello.serial);
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }

  /** The worker accepts the same two limitations as the page transport. */
  async start(): Promise<never> {
    throw new Error('VLLogic is a channel-major device; use startChannelMajor()');
  }

  async startChannelMajor(
    cfg: CaptureConfig,
    sink: ChannelSampleSink,
    onDropout?: DropoutSink,
    options?: CaptureStartOptions,
  ): Promise<void> {
    if (this.failure) throw this.failure;
    if (options?.loop) throw new Error('VLLogic captures do not support loop mode yet');
    this.sink = sink;
    this.onDropout = onDropout ?? null;
    this.onEnd = options?.onEnd ?? null;
    const started = new Promise<void>((resolve, reject) => {
      this.startWaiter = resolve;
      this.startFailure = reject;
    });
    const message: VllogicToWorker = {
      kind: 'start',
      cfg,
      deviceSampleLimit: options?.deviceSampleLimit ?? 0,
    };
    this.worker.postMessage(message);
    await Promise.race([started, timeout(START_TIMEOUT_MS, 'start')]);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.sink = null;
    this.onDropout = null;
    this.onEnd = null;
    if (this.failure) return;
    const stopped = new Promise<void>((resolve) => { this.stopWaiter = resolve; });
    const message: VllogicToWorker = { kind: 'stop' };
    this.worker.postMessage(message);
    await Promise.race([stopped, delay(STOP_TIMEOUT_MS)]);
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    const message: VllogicToWorker = { kind: 'terminate' };
    this.worker.postMessage(message);
    // Give the worker a moment to stop the device and close the interface, then make
    // sure the thread is gone.
    setTimeout(() => this.worker.terminate(), 1_000);
  }

  private fail(error: Error): void {
    this.failure = error;
    this.startFailure?.(error);
    this.startFailure = null;
    this.onError?.(error);
  }

  private onMessage(message: VllogicFromWorker): void {
    switch (message.kind) {
      case 'started':
        this.startWaiter?.();
        this.startWaiter = null;
        this.startFailure = null;
        return;
      case 'batch': {
        const sink = this.sink;
        if (!sink) return;
        try {
          sink.begin?.(message.channels);
          for (let i = 0; i < message.channels.length; i++) {
            const buffer = message.words[i];
            if (!buffer) continue;
            sink.channel(message.channels[i]!, message.startSample, new Uint32Array(buffer));
          }
          sink.commit(message.samples);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      case 'dropout':
        this.onDropout?.(message.position, message.missing);
        return;
      case 'ended': {
        const end = this.onEnd;
        this.onEnd = null;
        end?.();
        return;
      }
      case 'stopped':
        this.stopWaiter?.();
        this.stopWaiter = null;
        return;
      case 'error':
        this.fail(asError(message));
        return;
    }
  }
}

/**
 * Worker-first Logic20 open, with the page transport as the fallback. `?vllogic-worker=0`
 * forces the page path for bring-up.
 */
export const vllogicWorkerTransport = {
  preferred: true,
  lastFallbackReason: '',

  async open(usb: USBDevice): Promise<Device> {
    const forcedOff = typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('vllogic-worker') === '0';
    if (!this.preferred || forcedOff || typeof Worker === 'undefined' ||
        typeof navigator === 'undefined' || !navigator.usb) {
      return VllogicDevice.open(usb);
    }
    try {
      const device = await WorkerVllogicDevice.open(usb, vllogicReadTuning());
      this.lastFallbackReason = '';
      return device;
    } catch (error) {
      this.lastFallbackReason = error instanceof Error ? error.message : String(error);
      console.warn('[vllogic] worker transport unavailable, using the page thread:', error);
      return VllogicDevice.open(usb);
    }
  },
};
