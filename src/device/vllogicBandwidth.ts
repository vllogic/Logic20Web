// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Logic20 lane-bandwidth arithmetic shared by the transport and the UI.
 *
 * The board samples every selected lane at the chosen rate, so the load is
 * `selected x samplerate` bits per second. The internal FIFO envelope is 4800 Mbit/s;
 * this app refuses anything above 4500 Mbit/s. The measured USB 3 / host ceiling is
 * 2560 Mbit/s and is advisory only.
 */

/** Hardware FIFO envelope, Mbit/s. */
export const VLLOGIC_FIFO_MBPS = 4800;
/** Hard limit this app enforces, Mbit/s (below the FIFO envelope). */
export const VLLOGIC_FIFO_HARD_MBPS = 4500;
/** Measured USB 3 / host scheduling ceiling, Mbit/s; advisory only. */
export const VLLOGIC_LINK_MBPS = 2560;
/** Default sample rate the Logic20 page opens on, Hz (20 lanes = 1600 Mbit/s). */
export const VLLOGIC_DEFAULT_RATE_HZ = 80_000_000;

/** `count` lanes at `rateHz` each, in Mbit/s. */
export function selectionBandwidthMbps(count: number, rateHz: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(rateHz) || count <= 0 || rateHz <= 0) return 0;
  return count * rateHz / 1e6;
}

/** How many lanes of `rateHz` fit under `limitMbps` (at least 0). */
export function maxChannelsForBandwidth(rateHz: number, limitMbps: number): number {
  if (!(rateHz > 0) || !(limitMbps > 0)) return 0;
  return Math.max(0, Math.floor(limitMbps * 1e6 / rateHz));
}

export function exceedsHardLimit(count: number, rateHz: number): boolean {
  return selectionBandwidthMbps(count, rateHz) > VLLOGIC_FIFO_HARD_MBPS;
}

export function aboveLinkLimit(count: number, rateHz: number): boolean {
  return selectionBandwidthMbps(count, rateHz) > VLLOGIC_LINK_MBPS;
}
