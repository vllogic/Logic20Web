// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Firmware versions in the IAP info block: the low 24 bits are three bytes,
 * each written as its two hexadecimal digits (BCD). The high byte is reserved.
 *
 *   0x00002611 -> "0.26.11"
 *   0x00019901 -> "1.99.1"
 *   0x00010001 -> "1.0.1"
 *
 * This value is read over 0xE0, not from bcdDevice.
 */

export function formatFirmware(value: number): string {
  const low = value & 0xffffff;
  const a = (low >>> 16) & 0xff;
  const b = (low >>> 8) & 0xff;
  const c = low & 0xff;
  return `${a.toString(16)}.${b.toString(16)}.${c.toString(16)}`;
}

/** -1 when a < b, 0 when equal, 1 when a > b. */
export function compareFirmware(a: number, b: number): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
