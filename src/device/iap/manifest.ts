// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Parser for `ota/firmware.json`, the manifest published beside the page.
 *
 * The manifest is generated from the `.iap` that ships in `ota/public/firmware/`
 * (scripts/gen-ota-manifest.mjs), so the page never invents a version or a hash:
 * the file is the source of truth. Fetching it is optional; a user can always
 * pick a local package.
 */

export interface OtaLatest {
  version: number;
  date: string;
  codeHash: string;
  dataHash: string;
  file: string;
  size: number;
  blocks: number;
  sha256: string;
  codeLength: number;
  dataLength: number;
  dataType: number;
}

export interface OtaManifest {
  schema: number;
  product: string;
  magic: number;
  hwMask: number;
  latest: OtaLatest;
}

const FILE = /^[A-Za-z0-9._-]+\.iap$/;
const SHA256 = /^[0-9a-f]{64}$/;

function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = value.startsWith('0x') || value.startsWith('0X')
      ? Number.parseInt(value.slice(2), 16)
      : Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validate a manifest; returns null rather than throwing on a bad/missing file. */
export function parseManifest(value: unknown): OtaManifest | null {
  const root = object(value);
  if (!root) return null;
  const latest = object(root.latest);
  if (!latest) return null;

  const schema = int(root.schema);
  const magic = int(root.magic);
  const hwMask = int(root.hwMask);
  const version = int(latest.version);
  const size = int(latest.size);
  const blocks = int(latest.blocks);
  const codeLength = int(latest.codeLength);
  const dataLength = int(latest.dataLength);
  const dataType = int(latest.dataType);
  const file = latest.file;
  const sha256 = latest.sha256;
  const date = latest.date;
  const codeHash = typeof latest.codeHash === 'string' ? latest.codeHash : '';
  const dataHash = typeof latest.dataHash === 'string' ? latest.dataHash : '';

  if (schema !== 1 || typeof root.product !== 'string' || magic === null || hwMask === null) return null;
  if (version === null || size === null || blocks === null || codeLength === null
    || dataLength === null || dataType === null) return null;
  if (typeof file !== 'string' || !FILE.test(file)) return null;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
  if (typeof date !== 'string' || date.length > 12) return null;

  return {
    schema,
    product: root.product,
    magic,
    hwMask,
    latest: {
      version,
      date,
      codeHash,
      dataHash,
      file,
      size,
      blocks,
      sha256,
      codeLength,
      dataLength,
      dataType,
    },
  };
}
