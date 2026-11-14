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
 * 160 MHz capture is 400 MB/s. Reads are pipelined instead of serial: the endpoint
 * always has `depth` transferIn calls outstanding, so a completed buffer is consumed
 * while the next reads are already queued. The geometry follows libsigrok's vllogic
 * driver, whose receive ring is 16 x 256 KiB (vllogic.h:34-35); WebUSB cannot express
 * an URB ring, but the same "always keep reads queued" rule is what keeps the device's
 * FIFO draining. See `vllogicReadTuning()` for the bring-up overrides.
 */

import { DiagnosticError } from '../diagnostics.js';
import type {
  CaptureConfig, CaptureStartOptions, ChannelSampleSink, Device, DropoutSink,
} from './types.js';
import {
  UHSIF_DEFAULT_PAYLOAD,
  UHSIF_PAY_MAX,
  UhsifCmd,
  VLLOGIC_BCD_LOGIC20,
  VLLOGIC_BCD_LOGIC20_ALT,
  VLLOGIC_EP_IN,
  VLLOGIC_EP_OUT,
  VLLOGIC_PRODUCT,
  VLLOGIC_NUM_CHANNELS,
  VLLOGIC_RATES,
  VLLOGIC_THRESHOLD_PRESETS,
  VllogicParser,
  vllogicBuildCommand,
  vllogicBuildLut,
  vllogicDivForRate,
  vllogicMapBuild,
  vllogicMaxChannels,
  vllogicThresholdToPwm,
  type VllogicChannelMap,
  type VllogicParserStats,
} from './vllogicProtocol.js';

/**
 * Read geometry. libsigrok's vllogic driver keeps 16 x 256 KiB IN URBs in flight
 * (libsigrok/src/hardware/vllogic-logic/vllogic.h:34-35). WebUSB has no URB ring, but
 * the rule is the same: the endpoint must always have a read queued, or the device's
 * FIFO backs up and the whole capture stretches. 8 x 256 KiB = 2 MiB in flight is the
 * browser equivalent for the page-thread consumer; override it for bring-up with
 * `?vllogic-read=<bytes>&vllogic-depth=<n>` and compare `[vllogic]` output.
 */
const DEFAULT_READ_BYTES = 256 * 1024;
const DEFAULT_READ_DEPTH = 8;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_READ_DEPTH = 32;
const CONFIG_SETTLE_MS = 35;
const STOP_SETTLE_MS = 750;
/**
 * A Logic20 starts streaming within a few milliseconds of START, so a second of
 * silence means the board is wedged (it still answers commands and sends nothing on
 * the bulk endpoint, the same failure the SLogic transport reports as device.noData).
 */
const DEFAULT_FIRST_BLOCK_MS = 1000;
const MIN_FIRST_BLOCK_MS = 20;
const MAX_FIRST_BLOCK_MS = 60_000;
/**
 * Optional pre-START drain. WebUSB cannot cancel a transferIn, so libsigrok's
 * `sync_drain(32 x 5 ms)` has no direct form here. Instead one read is issued and
 * raced against this idle window; data completing inside it is discarded, and the
 * read that survives the window becomes the capture's first armed read. 0 disables it.
 */
const DEFAULT_DRAIN_IDLE_MS = 20;
const MAX_DRAIN_IDLE_MS = 200;
const MAX_DRAIN_READS = 64;

/** How many reads are kept queued, how large each one is, and how START is armed. */
export interface VllogicReadTuning {
  readonly bytes: number;
  readonly depth: number;
  /** Milliseconds START may go without a data block before the capture is failed. */
  readonly firstBlockMs: number;
  /** Idle window that ends the optional pre-START drain; 0 disables the drain. */
  readonly drainIdleMs: number;
}

/** What the optional pre-START drain saw. Filled even when the drain is disabled. */
export interface VllogicDrainStats {
  enabled: boolean;
  /** Completed reads discarded before START. */
  reads: number;
  bytes: number;
  /** True when the read that outlived the idle window became the capture's first read. */
  preArmed: boolean;
  ms: number;
}

/**
 * Resolve the read geometry, honouring the bring-up query parameters. Values outside
 * the safe range fall back to the defaults rather than silently starving the endpoint.
 */
export function vllogicReadTuning(search?: string): VllogicReadTuning {
  const defaults: VllogicReadTuning = {
    bytes: DEFAULT_READ_BYTES,
    depth: DEFAULT_READ_DEPTH,
    firstBlockMs: DEFAULT_FIRST_BLOCK_MS,
    drainIdleMs: DEFAULT_DRAIN_IDLE_MS,
  };
  let raw = search;
  if (raw === undefined) raw = typeof location === 'undefined' ? '' : location.search;
  try {
    const params = new URLSearchParams(raw);
    const bytes = Number(params.get('vllogic-read'));
    const depth = Number(params.get('vllogic-depth'));
    const firstBlockMs = Number(params.get('vllogic-firstblock'));
    // 0 is a valid drain value (disabled), so an absent parameter must not become 0.
    const drainParam = params.get('vllogic-drain');
    const drainIdleMs = drainParam === null ? Number.NaN : Number(drainParam);
    return {
      bytes: Number.isInteger(bytes) && bytes >= 4096 && bytes <= MAX_READ_BYTES
        ? bytes : defaults.bytes,
      depth: Number.isInteger(depth) && depth >= 1 && depth <= MAX_READ_DEPTH
        ? depth : defaults.depth,
      firstBlockMs: Number.isInteger(firstBlockMs) && firstBlockMs >= MIN_FIRST_BLOCK_MS &&
        firstBlockMs <= MAX_FIRST_BLOCK_MS ? firstBlockMs : defaults.firstBlockMs,
      drainIdleMs: Number.isInteger(drainIdleMs) && drainIdleMs >= 0 &&
        drainIdleMs <= MAX_DRAIN_IDLE_MS ? drainIdleMs : defaults.drainIdleMs,
    };
  } catch {
    return defaults;
  }
}

interface CompletedRead {
  readonly sequence: number;
  readonly result?: USBInTransferResult;
  readonly error?: unknown;
  readonly bytes: number;
  readonly startedAt: number;
  readonly completedAt: number;
}

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
  private configuredDiv = 0;
  private configuredMask = 0;
  private firstBlockChecked = false;
  /** True once a data block (not just a command ACK) has arrived for this capture. */
  private firstBlockSeen = false;
  private firstBlockTimer: ReturnType<typeof setTimeout> | null = null;
  private reportedDropBlocks = 0;
  private dropoutSink: DropoutSink | null = null;
  /** Bumped by every start; a stopped-but-stuck old read loop must not touch a new one. */
  private captureEpoch = 0;
  /**
   * Resolves readLoop's completion wait. WebUSB cannot cancel a transferIn, so a board
   * that stops sending leaves the loop parked; stop() calls this to break the wait
   * instead of leaving the capture object hung for the rest of the page session.
   */
  private wakeLoop: (() => void) | null = null;
  /** True once the current read loop has left its wait and started tearing down. */
  loopCompleted = false;

  /** Pipelined read geometry; see vllogicReadTuning(). */
  readonly readTuning: VllogicReadTuning;
  /** Parser counters from the last capture, kept after stop() clears the parser. */
  parserStats: VllogicParserStats | null = null;
  /** Pre-START drain result for the bench page. */
  readonly drainStats: VllogicDrainStats = {
    enabled: false, reads: 0, bytes: 0, preArmed: false, ms: 0,
  };
  /** Receive-loop counters, reported once per capture. */
  readonly readStats = {
    transfers: 0,
    bytes: 0,
    shortReads: 0,
    sumTransferMs: 0,
    maxTransferMs: 0,
    peakInFlight: 0,
    startedAt: 0,
    reported: false,
  };

  private constructor(private readonly usb: USBDevice, tuning?: VllogicReadTuning) {
    this.name = usb.productName || 'Logic20';
    this.serial = usb.serialNumber ?? '';
    this.readTuning = tuning ?? vllogicReadTuning();
  }

  /** Open and claim interface 0. Interface 1 is the DLDO interface and is never touched. */
  static async open(usb: USBDevice, tuning?: VllogicReadTuning): Promise<VllogicDevice> {
    // The PID is shared with the USB Sniffer 2 (bcdDevice 0x0602, UHSIF v2.3).
    // Opening it with the v2.2 parser produces CRC failures and random junk.
    const bcd = ((usb.deviceVersionMajor & 0xFF) << 8) | (usb.deviceVersionMinor & 0xFF);
    const known = bcd === VLLOGIC_BCD_LOGIC20 || bcd === VLLOGIC_BCD_LOGIC20_ALT ||
      (bcd === 0 && usb.productName === VLLOGIC_PRODUCT);
    if (!known) {
      throw new DiagnosticError('device.unexpectedDevice', {
        bcd: `0x${bcd.toString(16).padStart(4, '0')}`,
        product: usb.productName || '(none)',
      });
    }
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
    return new VllogicDevice(usb, tuning);
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
    this.configuredDiv = div;
    this.configuredMask = map.mask;
    // The specification requires >= 25 ms of PWM settling before the first sample.
    await delay(CONFIG_SETTLE_MS);
  }

  async startChannelMajor(
    cfg: CaptureConfig,
    sink: ChannelSampleSink,
    onDropout?: DropoutSink,
    options?: CaptureStartOptions,
  ): Promise<void> {
    if (this.running) throw new Error('VLLogic capture already running');
    if (options?.loop) throw new Error('VLLogic captures do not support loop mode yet');

    const div = vllogicDivForRate(cfg.samplerate);
    if (div === null) {
      throw new DiagnosticError('device.unsupportedSamplerate', { rate: cfg.samplerate });
    }
    const widthLimit = vllogicMaxChannels(cfg.samplerate);
    if (cfg.channels > widthLimit) {
      throw new DiagnosticError('device.unsupportedChannels', { channels: cfg.channels });
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
    this.firstBlockChecked = false;
    this.firstBlockSeen = false;
    this.reportedDropBlocks = 0;
    this.loopCompleted = false;
    this.dropoutSink = onDropout ?? null;
    // A payload is 4092 words, so this many snapshots can arrive before a flush.
    const maxSnapshots = Math.max(1, Math.floor(UHSIF_PAY_MAX / map.nchan));
    this.runBuffers = Array.from(
      { length: map.nchan }, () => new Uint32Array(maxSnapshots),
    );
    const epoch = ++this.captureEpoch;
    this.parser = new VllogicParser(map, (words, snapshots) => {
      if (epoch === this.captureEpoch) this.acceptBatch(words, snapshots);
    });

    // Optional pre-START drain: discard whatever the endpoint still holds and hand the
    // read that outlives the idle window to the capture loop as its first in-flight
    // read. Disabled by default (see vllogicReadTuning); the bench page compares it.
    const preArm = await this.drainBeforeStart(epoch);

    // Arm the IN transfer before START so the first block is not lost to a race.
    // The loop can fail from the background (first-block check, USB error); onError
    // reports it, and the catch keeps that rejection from surfacing as unhandled.
    this.loopDone = this.readLoop(epoch, preArm);
    void this.loopDone.catch(() => undefined);
    await this.send(UhsifCmd.Start);
    this.armFirstBlockWatchdog(epoch, cfg);
  }

  /**
   * Drain the IN endpoint without cancelling a read. One transferIn is raced against
   * `drainIdleMs`: data finishing inside the window is stale and discarded, and the
   * read that survives it is returned for readLoop to adopt. This is the WebUSB-safe
   * form of libsigrok's sync_drain() before START.
   */
  private async drainBeforeStart(
    epoch: number,
  ): Promise<{ request: Promise<USBInTransferResult> } | null> {
    const stats = this.drainStats;
    stats.enabled = this.readTuning.drainIdleMs > 0;
    stats.reads = 0;
    stats.bytes = 0;
    stats.preArmed = false;
    stats.ms = 0;
    const idle = this.readTuning.drainIdleMs;
    if (!stats.enabled || epoch !== this.captureEpoch) return null;
    const startedAt = performance.now();
    for (let i = 0; i < MAX_DRAIN_READS; i++) {
      if (this.stopRequested || epoch !== this.captureEpoch) break;
      let request: Promise<USBInTransferResult>;
      try {
        request = this.usb.transferIn(VLLOGIC_EP_IN, this.readTuning.bytes);
      } catch {
        break;
      }
      // The rejection handler stays attached, so a read that readLoop never adopts
      // cannot surface as an unhandled rejection.
      const outcome = await Promise.race([
        request.then(
          (result) => ({ kind: 'done' as const, result }),
          () => ({ kind: 'error' as const }),
        ),
        delay(idle).then(() => ({ kind: 'idle' as const })),
      ]);
      if (outcome.kind === 'error') break;
      if (outcome.kind === 'idle') {
        stats.preArmed = true;
        stats.ms = performance.now() - startedAt;
        // Wrap the promise: an async function would otherwise await it here and lose
        // the pending read that readLoop must adopt.
        return { request };
      }
      stats.reads += 1;
      stats.bytes += outcome.result.status === 'ok' && outcome.result.data
        ? outcome.result.data.byteLength : 0;
    }
    stats.ms = performance.now() - startedAt;
    return null;
  }

  /**
   * Deinterleave one parser batch into per-lane runs and publish it as one store frame.
   * A 4092-word payload is 204 snapshots at 20 lanes, so this runs the sink 20 times per
   * ~16 KiB transfer instead of 20 times per 80-byte snapshot.
   */
  private acceptBatch(words: Uint32Array, snapshots: number): void {
    const map = this.map;
    const sink = this.sink;
    if (!map || !sink || snapshots <= 0) return;
    // Data is flowing: the board is not wedged, whatever happens to this batch.
    this.firstBlockSeen = true;
    this.clearFirstBlockWatchdog();
    const parser = this.parser;
    if (parser !== null && !this.firstBlockChecked) {
      const header = parser.lastHeader;
      if (header !== null) {
        this.firstBlockChecked = true;
        if (header.div !== this.configuredDiv || header.mask !== this.configuredMask ||
            header.mode !== 0 || !header.capturing) {
          throw new DiagnosticError('device.headerMismatch', {
            div: header.div,
            expectedDiv: this.configuredDiv,
            mask: header.mask.toString(16),
            expectedMask: this.configuredMask.toString(16),
            mode: header.mode,
            capturing: header.capturing ? '1' : '0',
          });
        }
      }
    }
    if (parser !== null && parser.stats.dropBlocks > this.reportedDropBlocks) {
      this.reportedDropBlocks = parser.stats.dropBlocks;
      // The device swallowed snapshots without placing a marker in the stream.
      // The exact count is unknown, so report the position with zero length; the
      // app's dropout sink marks the span and keeps time aligned as far as it can.
      this.dropoutSink?.(this.emittedSamples, 0);
    }
    // Pipelined reads can deliver buffers that straddle the sample limit. Keep whole
    // snapshots only, so the sink still commits a 32-sample multiple.
    if (this.targetSamples > 0) {
      const remaining = this.targetSamples - this.emittedSamples;
      if (remaining <= 0) return;
      snapshots = Math.min(snapshots, Math.ceil(remaining / 32));
    }
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
      // The data is complete: publish the end now. Pipelined reads may still be
      // outstanding, and waiting for them in readLoop's finally would delay onEnd
      // until a stopped board's reads drain (or timeout) for no benefit.
      this.endOnce();
      void this.send(UhsifCmd.Stop).catch(() => undefined);
    }
  }

  /**
   * Pipelined receive loop.
   *
   * `depth` `transferIn` calls stay outstanding at all times. A completion is first
   * recorded by sequence number and its replacement is armed *before* the consumer
   * runs, so parsing/writing a buffer can never leave the endpoint without a read.
   * Completions are consumed strictly in submission order: the USB endpoint delivers
   * bytes in order, but promise reactions are not required to, and the UHSIF parser is
   * stateful across buffers.
   *
   * This is the WebUSB form of libsigrok's 16 x 256 KiB URB ring (vllogic.h:34-35).
   *
   * `preArm` is the read that the optional pre-START drain left pending. It becomes
   * sequence 0, so the drain does not cost an extra read or leave a reader behind.
   */
  private async readLoop(
    epoch: number,
    preArm?: { request: Promise<USBInTransferResult> } | null,
  ): Promise<void> {
    const { bytes: readBytes, depth } = this.readTuning;
    const stats = this.readStats;
    stats.transfers = 0;
    stats.bytes = 0;
    stats.shortReads = 0;
    stats.sumTransferMs = 0;
    stats.maxTransferMs = 0;
    stats.peakInFlight = 0;
    stats.startedAt = performance.now();
    stats.reported = false;

    const alive = (): boolean => epoch === this.captureEpoch;
    const completed = new Map<number, CompletedRead>();
    const inFlight = new Set<Promise<void>>();
    let nextSequence = 0;
    let submitted = 0;
    let wake: (() => void) | null = null;
    let failure: unknown;
    let closed = false;

    const notify = (): void => {
      const resume = wake;
      wake = null;
      if (resume !== null && this.wakeLoop === resume) this.wakeLoop = null;
      resume?.();
    };
    const wantsMore = (): boolean => this.running &&
      (this.targetSamples === 0 || this.emittedSamples < this.targetSamples);

    const track = (
      sequence: number, request: Promise<USBInTransferResult>, startedAt: number,
    ): void => {
      let task!: Promise<void>;
      task = request.then(
        (result) => {
          inFlight.delete(task);
          const completedAt = performance.now();
          const bytes = result.status === 'ok' && result.data ? result.data.byteLength : 0;
          stats.bytes += bytes;
          if (bytes > 0 && bytes < 4096) stats.shortReads += 1;
          stats.sumTransferMs += completedAt - startedAt;
          stats.maxTransferMs = Math.max(stats.maxTransferMs, completedAt - startedAt);
          stats.peakInFlight = Math.max(stats.peakInFlight, inFlight.size + 1);
          completed.set(sequence, {
            sequence, result, bytes, startedAt, completedAt,
          });
          // Refill before notifying: the consumer must never be the reason the
          // endpoint sits idle.
          arm();
          notify();
        },
        (error) => {
          inFlight.delete(task);
          completed.set(sequence, {
            sequence, error, bytes: 0, startedAt, completedAt: performance.now(),
          });
          notify();
        },
      );
      inFlight.add(task);
    };

    const arm = (): void => {
      if (closed || !alive() || inFlight.size >= depth || !wantsMore()) return;
      const sequence = submitted++;
      const startedAt = performance.now();
      stats.transfers += 1;
      let request: Promise<USBInTransferResult>;
      try {
        request = this.usb.transferIn(VLLOGIC_EP_IN, readBytes);
      } catch (error) {
        completed.set(sequence, {
          sequence, error, bytes: 0, startedAt, completedAt: performance.now(),
        });
        notify();
        return;
      }
      track(sequence, request, startedAt);
    };

    if (preArm) {
      stats.transfers += 1;
      track(submitted++, preArm.request, performance.now());
    }
    for (let i = inFlight.size; i < depth; i++) arm();

    try {
      for (;;) {
        if (!alive()) break;
        while (!completed.has(nextSequence)) {
          if (inFlight.size === 0 || !this.running) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (epoch === this.captureEpoch) this.wakeLoop = resolve;
          });
        }
        const item = completed.get(nextSequence);
        if (!item) break;
        completed.delete(nextSequence++);
        if (item.error !== undefined) throw item.error;
        const result = item.result;
        if (!result || result.status !== 'ok') {
          // A forced stop can surface as a stalled/short completion; that is the
          // teardown path, not a capture failure.
          if (this.stopRequested || !this.running) break;
          throw new DiagnosticError('device.bulkStatus', { status: result?.status ?? 'none' });
        }
        const data = result.data;
        if (data && data.byteLength > 0) {
          this.parser?.feed(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
        if (!this.running && inFlight.size === 0 && completed.size === 0) break;
      }
    } catch (e) {
      if (!this.stopRequested) failure = e;
    } finally {
      closed = true;
      // A read loop that outlived stop() by more than its settle window belongs to an
      // older capture. It must not clear the new capture's running flag, publish its
      // end or overwrite its statistics.
      const current = epoch === this.captureEpoch;
      if (current) {
        this.loopCompleted = true;
        this.running = false;
        this.clearFirstBlockWatchdog();
        this.wakeLoop = null;
      }
      // A finite capture that already delivered its budget has no tail to collect:
      // the board stops sending after STOP, so these reads never complete. Finalise
      // the statistics now instead of paying the settle window for them.
      const complete = this.targetSamples > 0 && this.emittedSamples >= this.targetSamples;
      if (!complete) {
        // The device has been (or is being) stopped, so outstanding reads complete as
        // short reads. Bound the wait: a wedged board must not keep the loop alive.
        await Promise.race([Promise.allSettled([...inFlight]), delay(STOP_SETTLE_MS)]);
      }
      if (!current) return;
      this.parser?.finish();
      this.parserStats = this.parser?.stats ?? null;
      this.reportReadStats();
      if (failure === undefined && this.targetSamples > 0 &&
          this.emittedSamples >= this.targetSamples) {
        this.endOnce();
      }
    }
    if (failure !== undefined && epoch === this.captureEpoch) {
      this.onError?.(failure);
      throw failure;
    }
  }

  /** One line per capture, so a slow run can be attributed without a profiler. */
  private reportReadStats(): void {
    const stats = this.readStats;
    if (stats.reported || stats.transfers === 0 || typeof location === 'undefined') return;
    stats.reported = true;
    const ms = performance.now() - stats.startedAt;
    const mb = stats.bytes / 1e6;
    const mbPerSecond = ms > 0 ? (mb / ms) * 1000 : 0;
    console.info(
      `[vllogic] ${stats.transfers} reads of ${(this.readTuning.bytes / 1024).toFixed(0)} KiB, ` +
      `${mb.toFixed(1)} MB in ${ms.toFixed(0)} ms (${mbPerSecond.toFixed(1)} MB/s), ` +
      `avg ${(stats.sumTransferMs / stats.transfers).toFixed(2)} ms, ` +
      `max ${stats.maxTransferMs.toFixed(1)} ms, short ${stats.shortReads}, ` +
      `inflight peak ${stats.peakInFlight}/${this.readTuning.depth}`,
    );
    const p = this.parserStats;
    if (p) {
      console.info(
        `[vllogic] payload=${p.payloadWords} junk=${p.junkBytes} crcFail=${p.crcFail} ` +
        `badLen=${p.badLen} maskMismatch=${p.maskMismatch} drop=${p.dropBlocks} ` +
        `seqJumps=${p.seqJumps} partial=${p.partialSnapshots}`,
      );
    }
  }

  /**
   * Fail a capture whose board never starts streaming: a Logic20 ACKs every command
   * and sends nothing on the bulk endpoint when it is wedged, so the page would sit on
   * "Capturing" forever. Reuse `device.noData`, the same user-facing state the SLogic
   * transport reports (and the failure notice already knows how to render).
   */
  private armFirstBlockWatchdog(epoch: number, cfg: CaptureConfig): void {
    this.clearFirstBlockWatchdog();
    const ms = this.readTuning.firstBlockMs;
    if (!(ms > 0)) return;
    this.firstBlockTimer = setTimeout(() => {
      this.firstBlockTimer = null;
      if (epoch !== this.captureEpoch || !this.running || this.firstBlockSeen) return;
      const error = new DiagnosticError('device.noData', {
        device: this.name,
        deadline: Math.round(ms),
        channels: cfg.channels,
        rate: cfg.samplerate / 1e6,
      });
      this.running = false;
      this.onError?.(error);
      // Leave the parked read loop now; the board has already been told to stop, and
      // its outstanding transferIn calls cannot be cancelled.
      this.wakeLoop?.();
      void this.send(UhsifCmd.Stop).catch(() => undefined);
    }, ms);
  }

  private clearFirstBlockWatchdog(): void {
    if (this.firstBlockTimer === null) return;
    clearTimeout(this.firstBlockTimer);
    this.firstBlockTimer = null;
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
    this.clearFirstBlockWatchdog();
    // A board that stopped streaming leaves readLoop parked on its completion wait.
    // Waking it here is what turns stop() from "give up after 750 ms" into teardown.
    this.wakeLoop?.();
    try {
      await this.send(UhsifCmd.Stop);
    } catch {
      // A teardown path reports through the caller's error handling; a device that is
      // already gone must not turn a stop into a second failure.
    }
    const loop = this.loopDone;
    this.loopDone = null;
    if (loop) {
      // A finite capture that already delivered its budget has nothing left to wait
      // for: the board stops sending, so its outstanding reads never complete and the
      // full settle window would be spent on a read that cannot arrive. A manual stop
      // keeps the window, because the tail in flight is still worth collecting.
      const complete = this.targetSamples > 0 && this.emittedSamples >= this.targetSamples;
      await Promise.race([loop.catch(() => undefined), delay(complete ? 0 : STOP_SETTLE_MS)]);
    }
    this.sink = null;
    this.map = null;
    this.parser = null;
    this.dropoutSink = null;
  }

  terminate(): void {
    void this.stop().finally(() => {
      void this.usb.releaseInterface(0).catch(() => undefined)
        .then(() => this.usb.close().catch(() => undefined));
    });
  }
}
