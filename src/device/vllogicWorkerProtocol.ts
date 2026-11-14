// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Messages between the page and the thread that owns a Logic20.
 *
 * The split is the same one libsigrok makes: the read loop reaps and resubmits transfers
 * on a thread whose only job is that callback, while the page draws, allocates and
 * collects garbage. WebUSB cannot cancel a transferIn, so a page-side read loop is only
 * as punctual as the page thread; at 320 MB/s a 30 ms GC pause overflows the board FIFO
 * even with 16 MiB of reads queued.
 *
 * `batch` carries channel-major words, already coalesced to a display cadence in the
 * worker. The buffers are transferred, not copied, and the page writes them straight
 * into its planar store.
 */

import type { CaptureConfig } from './types.js';
import type { VllogicReadTuning } from './vllogic.js';
import type { VllogicParserStats } from './vllogicProtocol.js';
import type { DiagnosticVars } from '../diagnostics.js';

export interface VllogicDeviceFilter {
  vendorId: number;
  productId: number;
  serial?: string;
}

export type VllogicToWorker =
  | { kind: 'open'; filter: VllogicDeviceFilter; tuning: VllogicReadTuning }
  | { kind: 'start'; cfg: CaptureConfig; deviceSampleLimit: number }
  | { kind: 'stop' }
  | { kind: 'terminate' }
  /** The page finished with batch `id`'s buffer; it is transferred back for reuse. */
  | { kind: 'ack'; id: number; buffer: ArrayBuffer };

/** Receive-loop counters, cloned out of the worker for the page's `[vllogic]` line. */
export interface VllogicReadStatsMessage {
  transfers: number;
  bytes: number;
  shortReads: number;
  sumTransferMs: number;
  maxTransferMs: number;
  peakInFlight: number;
  /** Wall time from the read loop's start to the stats message. */
  elapsedMs: number;
}

/**
 * One coalesced channel-major frame. All channels share one transferred buffer;
 * `offsets[i]`/`lengths[i]` locate channel `channels[i]`'s words inside it. One allocation
 * and one transferable per frame instead of one per channel keeps the worker's garbage
 * out of the read loop's way.
 */
export interface VllogicBatchMessage {
  kind: 'batch';
  /** Echoed in the ack that returns the buffer to the worker's pool. */
  id: number;
  channels: number[];
  startSample: number;
  buffer: ArrayBuffer;
  offsets: number[];
  lengths: number[];
  samples: number;
}

export type VllogicFromWorker =
  | { kind: 'opened'; name: string; serial: string }
  | { kind: 'started' }
  | VllogicBatchMessage
  | { kind: 'dropout'; position: number; missing: number }
  | { kind: 'ended' }
  | { kind: 'stopped' }
  | {
      kind: 'stats';
      read: VllogicReadStatsMessage;
      parser: VllogicParserStats | null;
      drain: { enabled: boolean; reads: number; bytes: number; preArmed: boolean; ms: number };
    }
  | {
      kind: 'error';
      message: string;
      code?: string;
      vars?: DiagnosticVars;
      payload?: string;
    };
