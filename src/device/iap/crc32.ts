// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * CRC-32 as the CH32H417 IAP service computes it: reflected polynomial
 * 0xEDB88320, init 0xFFFFFFFF, final XOR 0xFFFFFFFF (equivalent to zlib.crc32).
 *
 * The firmware has no built-in CRC helper on the host side, so this is the one
 * piece the page must implement itself. The table is built once on first use.
 */

let table: Uint32Array | null = null;

function makeTable(): Uint32Array {
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    out[i] = c >>> 0;
  }
  return out;
}

/** CRC-32 over `data`; returns an unsigned 32-bit value. */
export function crc32(data: Uint8Array): number {
  const t = table ?? (table = makeTable());
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ t[(crc ^ data[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
