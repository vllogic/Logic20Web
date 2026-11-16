// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * The 256-byte `union iap_firmware_info` as `iap.h` lays it out.
 *
 * Field offsets matter: 36 is `data_type`, 40 is `code_crc32` and 44 is
 * `data_crc32`. The layout below is the firmware struct, not a guessed order.
 */

import { crc32 } from './crc32.js';
import { IAP_INFO_SIZE } from './constants.js';

export interface IapInfo {
  /** `const_character_0x20260705` in iap.h; 0x20260820 for Logic20. */
  magic: number;
  infoValidLength: number;
  hardwareVersionMask: number;
  firmwareVersion: number;
  buildDate: string;
  codeLength: number;
  dataLength: number;
  dataType: number;
  codeCrc32: number;
  dataCrc32: number;
  codeHash: string;
  dataHash: string;
  infoCrc32: number;
  /** Whether `infoCrc32` matches the first 252 bytes. */
  infoCrcOk: boolean;
}

const decoder = new TextDecoder('ascii');

function text(bytes: Uint8Array, start: number, end: number): string {
  const raw = bytes.subarray(start, end);
  const nul = raw.indexOf(0);
  const body = nul >= 0 ? raw.subarray(0, nul) : raw;
  return decoder.decode(body).trim();
}

/**
 * Parse a decrypted 256-byte info block. Throws when the block is too short; a
 * wrong magic or CRC is reported through the fields so callers can show what the
 * device/package actually contains.
 */
export function parseIapInfo(block: Uint8Array): IapInfo {
  if (block.length < IAP_INFO_SIZE) {
    throw new Error(`IAP info block is ${block.length} bytes, expected ${IAP_INFO_SIZE}`);
  }
  const view = new DataView(block.buffer, block.byteOffset, IAP_INFO_SIZE);
  const u32 = (offset: number): number => view.getUint32(offset, true);
  const infoCrc32 = u32(252);
  return {
    magic: u32(0),
    infoValidLength: u32(4),
    hardwareVersionMask: u32(8),
    firmwareVersion: u32(12),
    buildDate: text(block, 16, 28),
    codeLength: u32(28),
    dataLength: u32(32),
    dataType: u32(36),
    codeCrc32: u32(40),
    dataCrc32: u32(44),
    codeHash: text(block, 48, 56),
    dataHash: text(block, 56, 64),
    infoCrc32,
    infoCrcOk: crc32(block.subarray(0, 252)) === infoCrc32,
  };
}

/** The same 256 bytes a package carries, assembled from fields (used by tests). */
export function buildInfoBlock(fields: {
  magic: number;
  hardwareVersionMask: number;
  firmwareVersion: number;
  buildDate: string;
  codeLength: number;
  dataLength: number;
  dataType: number;
  codeCrc32: number;
  dataCrc32: number;
  codeHash?: Uint8Array;
  dataHash?: Uint8Array;
}): Uint8Array {
  const info = new Uint8Array(IAP_INFO_SIZE);
  const view = new DataView(info.buffer);
  view.setUint32(0, fields.magic, true);
  view.setUint32(4, IAP_INFO_SIZE, true);
  view.setUint32(8, fields.hardwareVersionMask, true);
  view.setUint32(12, fields.firmwareVersion, true);
  const date = fields.buildDate.slice(0, 12);
  for (let i = 0; i < date.length; i++) info[16 + i] = date.charCodeAt(i) & 0xff;
  view.setUint32(28, fields.codeLength, true);
  view.setUint32(32, fields.dataLength, true);
  view.setUint32(36, fields.dataType, true);
  view.setUint32(40, fields.codeCrc32, true);
  view.setUint32(44, fields.dataCrc32, true);
  if (fields.codeHash) info.set(fields.codeHash.subarray(0, 8), 48);
  if (fields.dataHash) info.set(fields.dataHash.subarray(0, 8), 56);
  view.setUint32(252, crc32(info.subarray(0, 252)), true);
  return info;
}
