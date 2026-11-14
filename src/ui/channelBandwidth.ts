// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Logic20 channel-selection bandwidth policy.
 *
 * Two limits apply:
 *
 *  - the internal capture FIFO. The hardware envelope is 4800 Mbit/s; this app refuses
 *    anything above 4500 Mbit/s and force-deselects channels until the set fits.
 *  - the USB 3 link and the host scheduler. The measured ceiling is 2560 Mbit/s; going
 *    above it only warns, because the board can still capture and the page may keep up.
 *
 * The transport validates the same numbers; the ordering rules live here so the offline
 * tests can exhaust them without a board.
 */

import {
  VLLOGIC_FIFO_HARD_MBPS,
  VLLOGIC_FIFO_MBPS,
  VLLOGIC_LINK_MBPS,
  aboveLinkLimit,
  exceedsHardLimit,
  maxChannelsForBandwidth,
  selectionBandwidthMbps,
} from '../device/vllogicBandwidth.js';

export {
  VLLOGIC_FIFO_HARD_MBPS,
  VLLOGIC_FIFO_MBPS,
  VLLOGIC_LINK_MBPS,
  aboveLinkLimit,
  exceedsHardLimit,
  maxChannelsForBandwidth,
  selectionBandwidthMbps,
};

export interface ChannelSelection {
  readonly channel: number;
  /**
   * Logical selection time. Channels selected by the same action (a whole row's "select
   * all") share one value; a later pick always gets a larger one.
   */
  readonly selectedAt: number;
}

export interface TrimInput {
  readonly selected: readonly ChannelSelection[];
  readonly rateHz: number;
  readonly limitMbps?: number;
  /**
   * Channels referenced by a trigger, bus or decoder. They are closed last, but still
   * closed when the unprotected channels alone cannot get under the limit.
   */
  readonly protectedChannels?: ReadonlySet<number>;
}

export interface TrimResult {
  /** Kept channels, ascending by logical index (the transport's wire set). */
  readonly kept: number[];
  /** Channels closed by the limit, in the order they were closed. */
  readonly closed: number[];
}

/**
 * Close the oldest unprotected channels first until the set fits.
 *
 * Ordering: unprotected before protected; inside one class, earlier `selectedAt` first,
 * and equal timestamps close the higher logical channel first. One lane is always kept.
 */
export function trimChannelSelection(input: TrimInput): TrimResult {
  const limit = input.limitMbps ?? VLLOGIC_FIFO_HARD_MBPS;
  const protectedSet = input.protectedChannels ?? new Set<number>();
  const remaining = [...input.selected];
  const closed: number[] = [];
  while (remaining.length > 1 &&
      selectionBandwidthMbps(remaining.length, input.rateHz) > limit) {
    let victim = -1;
    for (let i = 0; i < remaining.length; i++) {
      if (victim < 0 || closesBefore(remaining[i]!, remaining[victim]!, protectedSet)) victim = i;
    }
    closed.push(remaining[victim]!.channel);
    remaining.splice(victim, 1);
  }
  return {
    kept: remaining.map((entry) => entry.channel).sort((a, b) => a - b),
    closed,
  };
}

function closesBefore(a: ChannelSelection, b: ChannelSelection, protectedSet: ReadonlySet<number>): boolean {
  const aProtected = protectedSet.has(a.channel) ? 1 : 0;
  const bProtected = protectedSet.has(b.channel) ? 1 : 0;
  if (aProtected !== bProtected) return aProtected < bProtected;
  if (a.selectedAt !== b.selectedAt) return a.selectedAt < b.selectedAt;
  return a.channel > b.channel;
}

/** A short list for the notice, e.g. "D7, D6, D5". */
export function formatChannelList(channels: readonly number[]): string {
  return channels.map((channel) => `D${channel}`).join(', ');
}
