// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Coalesce a channel-major device's per-payload commits into display-paced batches.
 *
 * The transport hands over one block per UHSIF payload (4 KiB at 4 lanes, 16 KiB of
 * wire per block). Writing each of those into the planar store costs ~27 ms per second
 * of 20 MHz x 4 CH data on its own, and at 16 CH / 160 MHz the per-block sink work is
 * 70-100 ms per second. Publishing the same words in 120 Hz batches halves the store
 * cost (the bit-plane writer amortises the frame setup) and cuts the commit callback
 * count from thousands per second to ~120, which is exactly the display cadence.
 *
 * The live view is drawn from `store.length`, so a batch is visible up to 8.3 ms later
 * than before. That is below one display frame and was accepted as the trade-off.
 *
 * This sink is only used by the channel-major (VLLogic Logic20) path. The interleaved
 * SLogic path already coalesces at the transport level (8 MiB chunks).
 */

export interface ChannelMajorTarget {
  beginFrame?(channels: readonly number[]): void;
  appendChannel?(channel: number, startSample: number, words: Uint32Array): void;
  commitSamples?(samples: number): void;
}

export interface ChannelMajorSink {
  begin(channels: readonly number[]): void;
  channel(channel: number, startSample: number, words: Uint32Array): void;
  commit(samples: number): void;
}

/** Samples one 120 Hz frame's worth of commit should hold, rounded to a whole 32. */
export function displayBatchSamples(samplerate: number, hz = 120): number {
  if (!(samplerate > 0) || !(hz > 0)) return 32;
  return Math.max(32, Math.ceil(samplerate / hz / 32) * 32);
}

export class ChannelMajorCoalescer implements ChannelMajorSink {
  private channels: readonly number[] = [];
  private words: Uint32Array[] = [];
  private used: number[] = [];
  private start = 0;
  private pending = 0;
  /** Total samples published so far, for the caller's progress and byte accounting. */
  committedSamples = 0;

  constructor(
    private readonly target: ChannelMajorTarget,
    private readonly batchSamples: number,
    private readonly onCommit?: (samples: number) => void,
  ) {}

  begin(channels: readonly number[]): void {
    if (this.pending > 0) return;
    this.channels = channels;
    this.start = this.committedSamples;
    const capacity = Math.max(1, Math.ceil(this.batchSamples / 32));
    if (this.words.length !== channels.length || this.words[0]!.length < capacity) {
      this.words = channels.map(() => new Uint32Array(capacity));
    }
    if (this.used.length !== channels.length) this.used = channels.map(() => 0);
    for (let i = 0; i < this.used.length; i++) this.used[i] = 0;
  }

  channel(channel: number, startSample: number, words: Uint32Array): void {
    if (startSample !== this.start + this.pending) {
      throw new Error(
        `channel ${channel} starts at ${startSample}, expected ${this.start + this.pending}`,
      );
    }
    const index = this.channels.indexOf(channel);
    if (index < 0) return;
    const used = this.used[index]!;
    const need = used + words.length;
    let buffer = this.words[index]!;
    if (need > buffer.length) {
      const grown = new Uint32Array(Math.max(need, buffer.length * 2));
      grown.set(buffer.subarray(0, used));
      this.words[index] = grown;
      buffer = grown;
    }
    buffer.set(words, used);
    this.used[index] = need;
  }

  commit(samples: number): void {
    this.pending += samples;
    if (this.pending < this.batchSamples) return;
    this.flush();
  }

  /** Publish the buffered tail; called when the capture ends. Returns samples published. */
  flush(): number {
    if (this.pending === 0) return 0;
    const samples = this.pending;
    this.target.beginFrame?.(this.channels);
    for (let i = 0; i < this.channels.length; i++) {
      this.target.appendChannel?.(
        this.channels[i]!, this.start, this.words[i]!.subarray(0, this.used[i]!),
      );
    }
    this.target.commitSamples?.(samples);
    this.committedSamples += samples;
    this.pending = 0;
    for (let i = 0; i < this.used.length; i++) this.used[i] = 0;
    this.onCommit?.(samples);
    return samples;
  }
}
