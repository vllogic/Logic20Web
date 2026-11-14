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
 * The production app runs this transport inside a Dedicated Worker
 * (`vllogicWorker.ts`); the class itself is thread-agnostic. The device is SuperSpeed and
 * a 20-lane 120 MHz capture is 300 MB/s. Reads are pipelined instead of serial: the
 * endpoint always has `depth` transferIn calls outstanding, so a completed buffer is
 * consumed while the next reads are already queued. The geometry follows libsigrok's vllogic
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
  VLLOGIC_EP_IN,
  VLLOGIC_EP_OUT,
  VLLOGIC_PRODUCT,
  VLLOGIC_NUM_CHANNELS,
  VLLOGIC_RATES,
  VLLOGIC_THRESHOLD_PRESETS,
  VllogicParser,
  vllogicBuildCommand,
  vllogicBuildLut,
  vllogicMapBuild,
  vllogicRateFor,
  vllogicThresholdToPwm,
  VllogicDecimator,
  type VllogicChannelMap,
  type VllogicParserStats,
} from './vllogicProtocol.js';
import {
  VLLOGIC_FIFO_HARD_MBPS,
  exceedsHardLimit,
  selectionBandwidthMbps,
} from './vllogicBandwidth.js';

/**
 * Read geometry. libsigrok's vllogic driver keeps 16 x 256 KiB IN URBs in flight
 * (libsigrok/src/hardware/vllogic-logic/vllogic.h:34-35). WebUSB has no URB ring, but
 * the rule is the same: the endpoint must always have a read queued, or the device's
 * FIFO backs up and the whole capture stretches. 64 x 256 KiB is the browser
 * equivalent for the page-thread consumer; override it for bring-up with
 * `?vllogic-read=<bytes>&vllogic-depth=<n>` and compare `[vllogic]` output.
 *
 * Measured 2026-11-14 at 16 CH / 160 MHz (320 MB/s, 0.2 s, six cycles each): depth 8
 * latched drop in 3 of 6 captures, depth 16 in 2 of 6, depth 32 in 0 of 6. The drop
 * positions were spread through the middle of the capture (24-72% of the budget), so
 * this is the page thread briefly losing its schedule, not a tail overflow: more
 * reads in flight absorb that pause. The 0.5 s stress run still dropped with 32, so
 * 64 is the current default; on desktop Linux that needs usbfs_memory_mb raised to 64,
 * because the kernel's default 16 MiB budget is exactly 64 x 256 KiB and any other
 * usbfs allocation pushes the queue over it. Desktop Linux therefore defaults to 32
 * reads (8 MiB), and `?vllogic-depth=64` remains available after raising the budget.
 *
 * Each transferIn asks for 256 KiB and, on Chromium/Linux, completes with ~230-256 KiB
 * (278 reads carried ~64 MB at depth 32; only the last read is short). The 16 KiB
 * figure elsewhere is the UHSIF block granularity, not the completion length. So 32
 * reads is a request window of ~8 MiB, about 25 ms at 320 MB/s.
 */
const DEFAULT_READ_BYTES = 256 * 1024;
const DEFAULT_READ_DEPTH = 64;
/** Desktop Linux: fit inside the default 16 MiB usbfs budget with headroom. */
const DEFAULT_READ_DEPTH_LINUX = 32;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_READ_DEPTH = 64;
const CONFIG_SETTLE_MS = 35;
const STOP_SETTLE_MS = 750;
/**
 * Once a finite capture reaches its sample budget the host stops consuming, but the
 * board keeps sampling until STOP takes effect. At 320 MB/s a few milliseconds of
 * backpressure is enough to overflow the board FIFO and latch drop_flag even though
 * every delivered sample was fine. Keep draining (and discarding) for this long after
 * the budget, so the tail does not turn into a spurious drop.
 */
const TAIL_DRAIN_MS = 20;
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
 * The optional user agent exists so the offline self-test can cover the Linux default.
 */
export function vllogicReadTuning(search?: string, userAgent?: string): VllogicReadTuning {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const linux = /Linux/i.test(ua) && !/Android/i.test(ua);
  const defaults: VllogicReadTuning = {
    bytes: DEFAULT_READ_BYTES,
    depth: linux ? DEFAULT_READ_DEPTH_LINUX : DEFAULT_READ_DEPTH,
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

/**
 * A transferIn that outlived its capture. WebUSB cannot cancel it, and a stopped board
 * leaves it parked until the next capture produces bytes. The next read loop adopts it
 * (in submission order) instead of issuing a fresh set of reads; otherwise the orphaned
 * reads consume the new START ACK and its first data blocks, and the new parser waits for
 * an ACK that has already gone past.
 */
interface CarriedRead {
  readonly request: Promise<USBInTransferResult>;
  settled: boolean;
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
  // Any lane can run at any offered rate; the 4500 Mbit/s FIFO limit, not a
  // per-width ceiling, decides how many lanes fit (channelBandwidth.ts).
  readonly maxSamplerateHz: Readonly<Record<number, number>> = {
    2: 1_200_000_000,
    4: 1_200_000_000,
    8: 1_200_000_000,
    16: 1_200_000_000,
    20: 1_200_000_000,
  };
  readonly recommendedSamplerateHz: Readonly<Record<number, number>> = {
    2: 1_200_000_000,
    4: 600_000_000,
    8: 300_000_000,
    16: 150_000_000,
    20: 80_000_000,
  };
  /** Measured comparator range, see vllogicThresholdToPwm(). */
  readonly testModes = [0] as const;
  readonly thresholdRange = { min: -2.5, max: 5.0 };
  readonly thresholdPresets = VLLOGIC_THRESHOLD_PRESETS;

  onError: ((error: unknown) => void) | null = null;

  private running = false;
  private stopRequested = false;
  private loopDone: Promise<void> | null = null;
  /** The loop stop() released; start() must let it finish collecting its parked reads. */
  private previousLoop: Promise<void> | null = null;
  private parser: VllogicParser | null = null;
  private map: VllogicChannelMap | null = null;
  private sink: ChannelSampleSink | null = null;
  /** One word-run per physical lane, reused for every batch (no per-batch garbage). */
  private runBuffers: Uint32Array[] = [];
  private emittedSamples = 0;
  /** Host-side decimation for the slow rates (10/5/2.5 MHz keep every 2/4/8th). */
  private decimator: VllogicDecimator | null = null;
  /** Input snapshots consumed per output snapshot (1 when the rate is not decimated). */
  private decimateFactor = 1;
  /** Loop captures run until stop(), so stop() must not wait for a sample budget. */
  private loopMode = false;
  private decimateBuffers: Uint32Array[] = [];
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
  /** Keep reading (and discarding) for TAIL_DRAIN_MS after a finite budget is met. */
  private drainTail = false;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  /** Parked reads inherited from the previous capture; see CarriedRead. */
  private carriedReads: CarriedRead[] = [];

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
    // The PID is shared with the USB Sniffer 2, which is a different protocol.
    // Identify the board by its product string instead of bcdDevice: hosts decode
    // the same BCD value differently (desktop Chrome 8.2.x, Android 8.1.x).
    const known = (usb.productName ?? '').trim().toLowerCase() === VLLOGIC_PRODUCT.toLowerCase();
    if (!known) {
      throw new DiagnosticError('device.unexpectedDevice', {
        bcd: `${usb.deviceVersionMajor}.${usb.deviceVersionMinor}.${usb.deviceVersionSubminor}`,
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
    // The previous stop() may have returned while its loop was still recording the reads
    // it could not cancel. Let it finish before this capture takes them over.
    const previous = this.previousLoop;
    this.previousLoop = null;
    if (previous) {
      await Promise.race([previous.catch(() => undefined), delay(STOP_SETTLE_MS)]);
    }
    if (this.running) throw new Error('VLLogic capture already running');
    // Loop mode is host-side: the board streams and the store drops from the front when
    // the retention window is exceeded, so the transport only has to keep running until
    // stop() (no deviceSampleLimit).

    const rate = vllogicRateFor(cfg.samplerate);
    if (rate === null) {
      throw new DiagnosticError('device.unsupportedSamplerate', { rate: cfg.samplerate });
    }
    const selected = cfg.selectedChannels !== undefined
      ? [...cfg.selectedChannels]
      : Array.from({ length: cfg.channels }, (_, channel) => channel);
    if (selected.length === 0 || selected.length > VLLOGIC_NUM_CHANNELS) {
      throw new DiagnosticError('device.unsupportedChannels', {
        channels: selected.length, offered: `1..${VLLOGIC_NUM_CHANNELS}`,
      });
    }
    if (new Set(selected).size !== selected.length ||
        selected.some((channel) => !Number.isInteger(channel) ||
          channel < 0 || channel >= VLLOGIC_NUM_CHANNELS)) {
      throw new DiagnosticError('device.unsupportedChannels', {
        channels: selected.length, offered: `logical lanes 0..${VLLOGIC_NUM_CHANNELS - 1}`,
      });
    }
    if (exceedsHardLimit(selected.length, cfg.samplerate)) {
      throw new DiagnosticError('device.channelBandwidth', {
        channels: selected.length,
        rateMbps: Math.round(cfg.samplerate / 1e6),
        bandwidthMbps: Math.round(selectionBandwidthMbps(selected.length, cfg.samplerate)),
        limitMbps: VLLOGIC_FIFO_HARD_MBPS,
      });
    }
    // vllogicMapBuild rejects duplicates and lanes outside 0..19; it sorts by physical
    // lane, which is the payload order.
    const map = vllogicMapBuild(selected);
    const pwm = vllogicThresholdToPwm(cfg.thresholdVolts);
    if (!pwm) {
      throw new DiagnosticError('device.threshold', { volts: cfg.thresholdVolts });
    }

    await this.configure(map, rate.div, pwm);

    this.map = map;
    this.sink = sink;
    this.emittedSamples = 0;
    // Store commits are whole 32-sample snapshots, so a target that is not a multiple of
    // 32 cannot be delivered exactly. Round it down once, here, instead of clamping each
    // batch with Math.ceil and overshooting the budget by up to 31 samples. A request
    // below one snapshot still gets one, so "finite" never degenerates into "unlimited".
    const requested = Math.max(0, Math.floor(options?.deviceSampleLimit ?? 0));
    this.targetSamples = requested > 0
      ? Math.max(32, Math.floor(requested / 32) * 32)
      : 0;
    this.loopMode = options?.loop === true;
    this.onCaptureEnd = options?.onEnd ?? null;
    this.ended = false;
    this.stopRequested = false;
    this.running = true;
    this.firstBlockChecked = false;
    this.firstBlockSeen = false;
    this.reportedDropBlocks = 0;
    this.loopCompleted = false;
    this.drainTail = false;
    this.clearTailTimer();
    this.dropoutSink = onDropout ?? null;
    // A payload is 4092 words, so this many snapshots can arrive before a flush.
    const maxSnapshots = Math.max(1, Math.floor(UHSIF_PAY_MAX / map.nchan));
    this.runBuffers = Array.from(
      { length: map.nchan }, () => new Uint32Array(maxSnapshots),
    );
    this.decimator = rate.decimate > 1
      ? new VllogicDecimator(map.nchan, rate.decimate)
      : null;
    this.decimateFactor = rate.decimate;
    this.decimateBuffers = this.decimator
      ? Array.from({ length: map.nchan },
        () => new Uint32Array(Math.ceil(maxSnapshots / rate.decimate) + 1))
      : [];
    const epoch = ++this.captureEpoch;
    this.parser = new VllogicParser(map, (words, snapshots) => {
      if (epoch === this.captureEpoch) this.acceptBatch(words, snapshots);
    });
    // A previous capture's tail may still be queued and can carry the same mask. Drop
    // every data block until the board acknowledges START; its new stream starts after
    // the ACK run on a snapshot boundary.
    this.parser.armStartBarrier();

    // Optional pre-START drain: discard whatever the endpoint still holds and hand the
    // read that outlives the idle window to the capture loop as its first in-flight
    // read. Enabled by default (20 ms); `?vllogic-drain=0` disables it.
    const preArm = await this.drainBeforeStart(epoch);
    // Old reads that are still parked will be the first to see the new START ACK/data.
    // Adopt them in submission order; a read that settled before this point is stale.
    const carried = this.carriedReads.filter((read) => !read.settled);
    this.carriedReads = [];

    // Arm the IN transfer before START so the first block is not lost to a race.
    // The loop can fail from the background (first-block check, USB error); onError
    // reports it, and the catch keeps that rejection from surfacing as unhandled.
    this.loopDone = this.readLoop(epoch, preArm, carried);
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
    // snapshots only, so the sink still commits a 32-sample multiple; targetSamples was
    // aligned down to a snapshot at start, so this clamp lands exactly on the budget.
    // A decimated rate consumes `decimateFactor` input snapshots per output snapshot:
    // clamping to the output count would skip chunks and break the tail's continuity,
    // so convert the remaining output snapshots back to input snapshots first.
    if (this.targetSamples > 0) {
      const remaining = this.targetSamples - this.emittedSamples;
      if (remaining <= 0) return;
      snapshots = Math.min(
        snapshots, Math.floor(remaining / 32) * this.decimateFactor,
      );
    }
    // Deinterleave first, then decimate per channel. The decimator carries the bits
    // that do not fill a whole output word across batches, so the committed sample
    // count stays a multiple of 32.
    for (let i = 0; i < map.physList.length; i++) {
      const run = this.runBuffers[i]!;
      for (let s = 0; s < snapshots; s++) run[s] = words[s * map.nchan + i]!;
    }
    let outWords = snapshots;
    let outBuffers = this.runBuffers;
    if (this.decimator) {
      let produced = 0;
      for (let i = 0; i < map.physList.length; i++) {
        produced = this.decimator.decimate(
          i, this.runBuffers[i]!.subarray(0, snapshots), this.decimateBuffers[i]!,
        );
      }
      outWords = produced;
      outBuffers = this.decimateBuffers;
      if (outWords === 0) return;
    }
    const start = this.emittedSamples;
    const samples = outWords * 32;
    sink.begin?.(map.logical);
    for (let i = 0; i < map.physList.length; i++) {
      const physical = map.physList[i]!;
      const logical = map.phys2log[physical]!;
      if (logical < 0) continue;
      sink.channel(logical, start, outBuffers[i]!.subarray(0, outWords));
    }
    sink.commit(samples);
    this.emittedSamples += samples;
    if (this.targetSamples > 0 && this.emittedSamples >= this.targetSamples) {
      this.running = false;
      // The data is complete: publish the end now. Pipelined reads may still be
      // outstanding, and waiting for them in readLoop's finally would delay onEnd
      // until a stopped board's reads drain (or timeout) for no benefit.
      this.endOnce();
      // Keep the endpoint drained until STOP reaches the board. This is what keeps
      // the post-budget FIFO backlog from latching drop_flag on a clean capture.
      this.drainTail = true;
      this.clearTailTimer();
      const epoch = this.captureEpoch;
      this.tailTimer = setTimeout(() => {
        this.tailTimer = null;
        if (epoch === this.captureEpoch) this.drainTail = false;
      }, TAIL_DRAIN_MS);
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
    carried: readonly CarriedRead[] = [],
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
    const live: CarriedRead[] = [];
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
    const wantsMore = (): boolean => this.drainTail || (this.running &&
      (this.targetSamples === 0 || this.emittedSamples < this.targetSamples));

    const track = (
      sequence: number, request: Promise<USBInTransferResult>, startedAt: number,
      entry: CarriedRead = { request, settled: false },
    ): void => {
      live.push(entry);
      let task!: Promise<void>;
      task = request.then(
        (result) => {
          entry.settled = true;
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
          entry.settled = true;
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

    // Adopt the previous capture's parked reads first: they are at the head of the
    // endpoint queue and will receive the new START ACK before any new read.
    for (const entry of carried) {
      if (entry.settled) continue;
      stats.transfers += 1;
      track(submitted++, entry.request, performance.now(), entry);
    }
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
        if (!this.running && !this.drainTail && inFlight.size === 0 && completed.size === 0) break;
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
        // Reads that survived the stop are the next capture's head reads. Keep only
        // unsettled ones: a read that completed before the next START saw stale bytes.
        this.carriedReads = live.filter((entry) => !entry.settled);
      }
      // A finite capture that already delivered its budget has no tail to collect:
      // the board stops sending after STOP, so these reads never complete. Finalise
      // the statistics now instead of paying the settle window for them.
      const complete = this.targetSamples > 0 && this.emittedSamples >= this.targetSamples;
      if (!complete && !this.loopMode) {
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
        `preAck=${p.preAckBlocks} ` +
        `dropAtStart=${p.firstDataDrop ? 1 : 0} dropAt=${p.dropAtSnapshots} ` +
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

  private clearTailTimer(): void {
    if (this.tailTimer === null) return;
    clearTimeout(this.tailTimer);
    this.tailTimer = null;
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
    this.drainTail = false;
    this.clearTailTimer();
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
    this.previousLoop = loop;
    if (loop) {
      // A finite capture that already delivered its budget has nothing left to wait
      // for: the board stops sending, so its outstanding reads never complete and the
      // full settle window would be spent on a read that cannot arrive. A manual stop
      // keeps the window, because the tail in flight is still worth collecting.
      const complete = this.targetSamples > 0 && this.emittedSamples >= this.targetSamples;
      // A loop capture has no budget to wait for: the board stops on STOP and the
      // outstanding reads never complete, so the settle window is pure latency.
      // Even then, give the loop time to publish its parked reads for the next capture.
      const wait = complete || this.loopMode ? 50 : STOP_SETTLE_MS;
      await Promise.race([
        loop.catch(() => undefined),
        delay(wait),
      ]);
    }
    this.sink = null;
    this.map = null;
    this.parser = null;
    this.dropoutSink = null;
  }

  /**
   * Stop, release interface 0 and close the device. Unlike terminate(), the caller can
   * await this: the bench pages run many captures on one connection and must not race a
   * fixed settle timer against the release.
   */
  async release(): Promise<void> {
    try {
      await this.stop();
    } catch {
      // Teardown must still release the interface when the stop path itself failed.
    }
    try {
      await this.usb.releaseInterface(0);
    } catch {
      // Already released, or the device is gone; close() below is still worth trying.
    }
    await this.usb.close().catch(() => undefined);
  }

  terminate(): void {
    void this.release();
  }
}
