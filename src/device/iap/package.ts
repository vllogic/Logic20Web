// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Inspect an `.iap` package before a single byte is sent.
 *
 * The package is one continuous AES-128-CBC stream over
 * `info[256] + code_pad + data_pad`. Decrypting it locally lets the page catch
 * the two failure modes a transfer-only uploader misses:
 *
 *   - a package for the other product (USB Sniffer 2, magic 0x20260705) or for a
 *     different board revision;
 *   - a truncated/corrupted package. The firmware silently skips every write when
 *     block 0 fails, so "all transfers answered OK" is not evidence that anything
 *     was written.
 *
 * The AES key is public by design (see constants.ts). This function is a
 * pre-flight check, not a signature check.
 */

import { crc32 } from './crc32.js';
import { aes128CbcDecrypt } from './aes.js';
import {
  IAP_AES_IV,
  IAP_AES_KEY,
  IAP_BLOCK_SIZE,
  IAP_DATA_H7P20_LR4_8K,
  IAP_DATA_H7P20_RAW,
  IAP_DATA_INVALID,
  IAP_HW_MASK,
  IAP_INFO_SIZE,
  IAP_MAGIC,
  IAP_MAX_CODE_DATA,
  IAP_MAX_IMAGE,
  IAP_SNIFFER2_MAGIC,
} from './constants.js';
import { parseIapInfo, type IapInfo } from './info.js';

export type PackageKind = 'logic20' | 'sniffer2' | 'unknown';

export type PackageProblem =
  | 'size'
  | 'blocks'
  | 'decrypt'
  | 'magic-sniffer2'
  | 'magic-unknown'
  | 'hw-mask'
  | 'info-crc'
  | 'layout'
  | 'capacity'
  | 'data-type'
  | 'code-crc'
  | 'data-crc'
  | 'manifest-mismatch';

export interface PackageCheck {
  ok: boolean;
  kind: PackageKind;
  sha256: string;
  bytes: number;
  blocks: number;
  info?: IapInfo;
  problems: PackageProblem[];
}

const align256 = (n: number): number => (n + 255) & ~255;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice();
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return hex(new Uint8Array(digest));
}

function decrypt(bytes: Uint8Array): Uint8Array {
  return aes128CbcDecrypt(bytes, IAP_AES_KEY, IAP_AES_IV);
}

/** Decrypt and validate a whole package. Never throws for malformed input. */
export async function inspectPackage(bytes: Uint8Array): Promise<PackageCheck> {
  const problems: PackageProblem[] = [];
  const sha256 = await sha256Hex(bytes);
  const blocks = Math.floor(bytes.length / IAP_BLOCK_SIZE);

  if (bytes.length === 0 || bytes.length % IAP_BLOCK_SIZE !== 0) problems.push('size');
  if (blocks < 2) problems.push('blocks');

  let plain: Uint8Array;
  try {
    plain = decrypt(bytes);
  } catch {
    return { ok: false, kind: 'unknown', sha256, bytes: bytes.length, blocks, problems: [...problems, 'decrypt'] };
  }

  let info: IapInfo;
  try {
    info = parseIapInfo(plain.subarray(0, IAP_INFO_SIZE));
  } catch {
    return { ok: false, kind: 'unknown', sha256, bytes: bytes.length, blocks, problems: [...problems, 'layout'] };
  }

  let kind: PackageKind = 'unknown';
  if (info.magic === IAP_MAGIC) kind = 'logic20';
  else if (info.magic === IAP_SNIFFER2_MAGIC) {
    kind = 'sniffer2';
    problems.push('magic-sniffer2');
  } else {
    problems.push('magic-unknown');
  }

  if ((info.hardwareVersionMask & IAP_HW_MASK) === 0) problems.push('hw-mask');
  if (!info.infoCrcOk) problems.push('info-crc');

  const codeStart = IAP_INFO_SIZE;
  const dataStart = codeStart + align256(info.codeLength);
  const expectedBytes = dataStart + align256(info.dataLength);
  if (info.codeLength <= 0 || expectedBytes !== bytes.length) problems.push('layout');
  if (info.codeLength + info.dataLength > IAP_MAX_CODE_DATA
    || IAP_INFO_SIZE + align256(info.codeLength) + align256(info.dataLength) > IAP_MAX_IMAGE) {
    problems.push('capacity');
  }

  const typeKnown = info.dataType === IAP_DATA_INVALID
    || info.dataType === IAP_DATA_H7P20_RAW
    || info.dataType === IAP_DATA_H7P20_LR4_8K;
  if (!typeKnown
    || (info.dataLength > 0 && info.dataType === IAP_DATA_INVALID)
    || (info.dataLength === 0 && info.dataType !== IAP_DATA_INVALID)) {
    problems.push('data-type');
  }

  if (info.codeLength > 0 && codeStart + info.codeLength <= plain.length) {
    if (crc32(plain.subarray(codeStart, codeStart + info.codeLength)) !== info.codeCrc32) problems.push('code-crc');
  } else {
    if (!problems.includes('layout')) problems.push('layout');
  }
  if (info.dataLength > 0 && dataStart + info.dataLength <= plain.length) {
    if (crc32(plain.subarray(dataStart, dataStart + info.dataLength)) !== info.dataCrc32) problems.push('data-crc');
  } else if (info.dataLength < 0 || dataStart + info.dataLength > plain.length) {
    if (!problems.includes('layout')) problems.push('layout');
  }

  return { ok: problems.length === 0, kind, sha256, bytes: bytes.length, blocks, info, problems };
}

export { align256 };
