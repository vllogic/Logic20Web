// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VLLogic driver authors
// Copyright (C) 2026 vllogic.com
/**
 * VLLogic Logic20 WebUSB transport.
 *
 * The device streams UHSIF v2.2 blocks whose payload is channel-major: one uint32 per
 * enabled lane (32 samples, bit 0 first), then the next lane. The transport decodes the
 * blocks and hands each snapshot to a ChannelSampleSink, which writes the words straight
 * into the planar store. No sample is transposed to the interleaved layout the SLogic U3
 * devices use.
 *
 * The transport runs on the page thread for now. The device is 5 Gbit/s and a 20-lane
 * 160 MHz capture is 400 MB/s; the receive loop is deliberately a single transferIn at
 * a time so backpressure is explicit, and the default VLLogic profile recommends
 * 100 MHz (250 MB/s) until the worker split lands.
 */

import { DiagnosticError } from '../diagnostics.js';
import type {
  CaptureConfig, CaptureStartOptions, ChannelSampleSink, Device, DropoutSink,
} from './types.js';
import {
  UHSIF_DEFAULT_PAYLOAD,
  UhsifCmd,
  VLLOGIC_EP_IN,
  VLLOGIC_EP_OUT,
  VLLOGIC_NUM_CHANNELS,
  VLLOGIC_RATES,
  VLLOGIC_THRESHOLD_PRESETS,
  VllogicParser,
  vllogicBuildCommand,
  vllogicBuildLut,
  vllogicDivForRate,
  vllogicMapBuild,
  vllogicThresholdToPwm,
  type VllogicChannelMap,
} from './vllogicProtocol.js';

/** One read at a time; 64 KiB is far below Chromium's 32 MiB transferIn cap. */
const READ_BYTES = 64 * 1024;
const CONFIG_SETTLE_MS = 35;
const STOP_SETTLE_MS = 750;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VllogicDevice implements Device {
  readonly sampleLayout = 'channel-major' as const;
  readonly name: string;
  readonly serial: string;
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
  /** Measured comparator range, see vllogicThresholdToPwm(). */
  readonly thresholdRange = { min: -2.5, max: 5.0 };
  readonly thresholdPresets = VLLOGIC_THRESHOLD_PRESETS;

  onError: ((error: unknown) => void) | null = null;

  private running = false;
  private stopRequested = false;
  private loopDone: Promise<void> | null = null;
  private parser: VllogicParser | null = null;
  private map: VllogicChannelMap | null = null;
  private sink: ChannelSampleSink | null = null;
  /** One word-run per physical lane, reused for every batch (no per-batch garbage). */
  private runBuffers: Uint32Array[] = [];
  private emittedSamples = 0;
  private targetSamples = 0;
  private onCaptureEnd: (() => void) | null = null;
  private ended = false;

  private constructor(private readonly usb: USBDevice) {
    this.name = usb.productName || 'Logic20';
    this.serial = usb.serialNumber ?? '';
  }

  /** Open and claim interface 0. Interface 1 is the DLDO interface and is never touched. */
  static async open(usb: USBDevice): Promise<VllogicDevice> {
    try {
      if (!usb.opened) await usb.open();
      // The device is normally already configured by the OS; a second select is a
      // no-op on Linux and can throw on Windows when the configuration is unchanged.
      try {
        await usb.selectConfiguration(1);
      } catch {
        // Already configured; claim below decides whether the interface is usable.
      }
      await usb.claimInterface(0);
    } catch (e) {
      throw new DiagnosticError('device.claimFailed', undefined, String((e as Error)?.message ?? e));
    }
    return new VllogicDevice(usb);
  }

  /**
   * The app calls startChannelMajor() for this profile; this exists only because the
   * Device contract has an interleaved start() and older callers may type-check it.
   */
  async start(): Promise<never> {
    throw new Error('VLLogic is a channel-major device; use startChannelMajor()');
  }

  private async send(cmd: UhsifCmd, param = 0): Promise<void> {
    const frame = vllogicBuildCommand(cmd, param);
    let result: USBOutTransferResult;
    try {
      result = await this.usb.transferOut(VLLOGIC_EP_OUT, frame.buffer as ArrayBuffer);
    } catch (e) {
      throw new DiagnosticError('device.configureFailed', { cmd }, String((e as Error)?.message ?? e));
    }
    if (result.status !== 'ok' || result.bytesWritten !== frame.byteLength) {
      throw new DiagnosticError('device.configureFailed', {
        cmd, status: result.status, bytes: result.bytesWritten,
      });
    }
  }

  private async configure(
    map: VllogicChannelMap,
    div: number,
    pwm: { pwm0: number; pwm1: number },
  ): Promise<void> {
    await this.send(UhsifCmd.Stop);
    await this.send(UhsifCmd.Flush);
    await this.send(UhsifCmd.MaxPayload, UHSIF_DEFAULT_PAYLOAD);
    await this.send(UhsifCmd.ChannelMask, map.mask);
    const lut = vllogicBuildLut(map.mask);
    for (let i = 0; i < 5; i++) await this.send((UhsifCmd.Lut0 + i) as UhsifCmd, lut[i]!);
    await this.send(UhsifCmd.IserdesDiv, div);
    await this.send(UhsifCmd.VbiasPwm0, pwm.pwm0);
    await this.send(UhsifCmd.VbiasPwm1, pwm.pwm1);
    await this.send(UhsifCmd.ModeNormal);
    // The specification requires >= 25 ms of PWM settling before the first sample.
    await delay(CONFIG_SETTLE_MS);
  }

  async startChannelMajor(
    cfg: CaptureConfig,
    sink: ChannelSampleSink,
    onDropout?: DropoutSink,
    options?: CaptureStartOptions,
  ): Promise<void> {
    void onDropout;
    if (this.running) throw new Error('VLLogic capture already running');
    if (options?.loop) throw new Error('VLLogic captures do not support loop mode yet');

    const div = vllogicDivForRate(cfg.samplerate);
    if (div === null) {
      throw new DiagnosticError('device.unsupportedSamplerate', { rate: cfg.samplerate });
    }
    const logical: number[] = [];
    for (let channel = 0; channel < cfg.channels; channel++) logical.push(channel);
    if (logical.length > VLLOGIC_NUM_CHANNELS) {
      throw new DiagnosticError('device.unsupportedChannels', { channels: cfg.channels });
    }
    const map = vllogicMapBuild(logical);
    const pwm = vllogicThresholdToPwm(cfg.thresholdVolts);
    if (!pwm) {
      throw new DiagnosticError('device.threshold', { volts: cfg.thresholdVolts });
    }

    await this.configure(map, div, pwm);

    this.map = map;
    this.sink = sink;
    this.emittedSamples = 0;
    this.targetSamples = Math.max(0, options?.deviceSampleLimit ?? 0);
    this.onCaptureEnd = options?.onEnd ?? null;
    this.ended = false;
    this.stopRequested = false;
    this.running = true;
    const maxSnapshots = Math.max(1, Math.floor((4092 / 4) / map.nchan));
    this.runBuffers = Array.from(
      { length: map.nchan }, () => new Uint32Array(maxSnapshots),
    );
    this.parser = new VllogicParser(map, (words, snapshots) =>
      this.acceptBatch(words, snapshots));

    // Arm the IN transfer before START so the first block is not lost to a race.
    this.loopDone = this.readLoop();
    await this.send(UhsifCmd.Start);
  }

  /**
   * Deinterleave one parser batch into per-lane runs and publish it as one store frame.
   * A 4092-byte payload is 51 snapshots at 20 lanes, so this runs the sink 20 times per
   * ~16 KiB transfer instead of 20 times per 80-byte snapshot.
   */
  private acceptBatch(words: Uint32Array, snapshots: number): void {
    const map = this.map;
    const sink = this.sink;
    if (!map || !sink || snapshots <= 0) return;
    const start = this.emittedSamples;
    const samples = snapshots * 32;
    sink.begin?.(map.logical);
    for (let i = 0; i < map.physList.length; i++) {
      const run = this.runBuffers[i]!;
      for (let s = 0; s < snapshots; s++) run[s] = words[s * map.nchan + i]!;
      const physical = map.physList[i]!;
      const logical = map.phys2log[physical]!;
      if (logical < 0) continue;
      sink.channel(logical, start, run.subarray(0, snapshots));
    }
    sink.commit(samples);
    this.emittedSamples += samples;
    if (this.targetSamples > 0 && this.emittedSamples >= this.targetSamples) {
      this.running = false;
      void this.send(UhsifCmd.Stop).catch(() => undefined);
    }
  }

  private async readLoop(): Promise<void> {
    let failure: unknown = null;
    try {
      while (this.running) {
        const result = await this.usb.transferIn(VLLOGIC_EP_IN, READ_BYTES);
        if (result.status !== 'ok') {
          throw new DiagnosticError('device.bulkStatus', { status: result.status });
        }
        const data = result.data;
        if (!data || data.byteLength === 0) continue;
        this.parser?.feed(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        if (this.targetSamples > 0 && this.emittedSamples >= this.targetSamples) break;
      }
    } catch (e) {
      if (!this.stopRequested) failure = e;
    } finally {
      this.running = false;
      this.parser?.finish();
      if (this.targetSamples > 0 && this.emittedSamples >= this.targetSamples) {
        this.endOnce();
      }
    }
    if (failure) {
      this.onError?.(failure);
      throw failure;
    }
  }

  private endOnce(): void {
    if (this.ended) return;
    this.ended = true;
    const end = this.onCaptureEnd;
    this.onCaptureEnd = null;
    end?.();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
    try {
      await this.send(UhsifCmd.Stop);
    } catch {
      // A teardown path reports through the caller's error handling; a device that is
      // already gone must not turn a stop into a second failure.
    }
    const loop = this.loopDone;
    this.loopDone = null;
    if (loop) {
      await Promise.race([loop.catch(() => undefined), delay(STOP_SETTLE_MS)]);
    }
    this.sink = null;
    this.map = null;
    this.parser = null;
  }

  terminate(): void {
    void this.stop().finally(() => {
      void this.usb.releaseInterface(0).catch(() => undefined)
        .then(() => this.usb.close().catch(() => undefined));
    });
  }
}
