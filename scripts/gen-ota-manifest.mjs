#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Generate ota/public/firmware.json from the .iap package(s) shipped in
 * ota/public/firmware/. The package is the source of truth: version, date,
 * lengths, block count and SHA-256 are read from its decrypted info block, so
 * the page can never advertise a hash that does not belong to the file.
 *
 * The key/IV are the public constants of tools/iap_pack.py and the firmware;
 * this script only proves the package decrypts and its CRCs match.
 */

import { createDecipheriv, createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'ota/public/firmware');
const OUT = join(ROOT, 'ota/public/firmware.json');

const KEY = Buffer.from('2abc65d7e4726e72364cf9272a061aaf', 'hex');
const IV = Buffer.from('08050726253e5fab2fc3c726964a6d5d', 'hex');
const MAGIC = 0x20260820;
const HW_MASK = 0x1;
const BLOCK = 256;
const CODE_ADDR = 0x0800a100;
const INFO_ADDR = 0x0800a000;
const CAP_END = 0x080ee000;
const MAX_CODE_DATA = CAP_END - CODE_ADDR;
const MAX_IMAGE = CAP_END - INFO_ADDR;
const align256 = (n) => (n + 255) & ~255;

let crcTable = null;
function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function decrypt(cipher) {
  const decipher = createDecipheriv('aes-128-cbc', KEY, IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}

function inspect(buffer, name) {
  if (!buffer.length || buffer.length % BLOCK !== 0) {
    throw new Error(`${name}: size ${buffer.length} is not a multiple of ${BLOCK}`);
  }
  const plain = decrypt(buffer);
  const u32 = (offset) => plain.readUInt32LE(offset);
  const magic = u32(0);
  const hwMask = u32(8);
  const version = u32(12);
  const codeLength = u32(28);
  const dataLength = u32(32);
  const dataType = u32(36);
  const codeCrc32 = u32(40);
  const dataCrc32 = u32(44);
  const infoCrc32 = u32(252);
  const date = plain.subarray(16, 28).toString('ascii').replace(/\0.*$/, '').trim();
  const codeHash = plain.subarray(48, 56).toString('ascii').replace(/\0.*$/, '').trim();
  const dataHash = plain.subarray(56, 64).toString('ascii').replace(/\0.*$/, '').trim();

  if (magic !== MAGIC) throw new Error(`${name}: magic 0x${magic.toString(16)} is not Logic20 0x20260820`);
  if ((hwMask & HW_MASK) === 0) throw new Error(`${name}: hardware mask 0x${hwMask.toString(16)} does not match`);
  if (crc32(plain.subarray(0, 252)) !== infoCrc32) throw new Error(`${name}: info CRC mismatch`);
  const codeStart = BLOCK;
  const dataStart = codeStart + align256(codeLength);
  if (dataStart + align256(dataLength) !== buffer.length) {
    throw new Error(`${name}: info lengths do not match the file size`);
  }
  if (codeLength <= 0 || codeLength + dataLength > MAX_CODE_DATA) {
    throw new Error(`${name}: code + data exceed the dynamic region`);
  }
  if (BLOCK + align256(codeLength) + align256(dataLength) > MAX_IMAGE) {
    throw new Error(`${name}: aligned image exceeds the dynamic region`);
  }
  if (![0, 1, 2].includes(dataType)
    || (dataLength > 0 && dataType === 0)
    || (dataLength === 0 && dataType !== 0)) {
    throw new Error(`${name}: invalid FPGA data type ${dataType} for ${dataLength} bytes`);
  }
  if (crc32(plain.subarray(codeStart, codeStart + codeLength)) !== codeCrc32) {
    throw new Error(`${name}: code CRC mismatch`);
  }
  if (dataLength && crc32(plain.subarray(dataStart, dataStart + dataLength)) !== dataCrc32) {
    throw new Error(`${name}: FPGA data CRC mismatch`);
  }

  return {
    file: name,
    version,
    date,
    size: buffer.length,
    blocks: buffer.length / BLOCK,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    codeHash,
    dataHash,
    codeLength,
    dataLength,
    dataType,
  };
}

async function main() {
  const names = (await readdir(DIR)).filter((name) => name.endsWith('.iap')).sort();
  if (names.length === 0) throw new Error(`no .iap package in ${DIR}`);
  const packages = [];
  for (const name of names) {
    const buffer = await readFile(join(DIR, name));
    packages.push(inspect(buffer, name));
  }
  packages.sort((a, b) => b.version - a.version || b.date.localeCompare(a.date) || b.file.localeCompare(a.file));
  const latest = packages[0];
  if (packages.length > 1) {
    console.log(`[ota] ${packages.length} packages found; latest is ${latest.file} (0x${latest.version.toString(16)})`);
  }

  const manifest = {
    schema: 1,
    product: 'Logic20',
    magic: '0x20260820',
    hwMask: HW_MASK,
    latest: {
      version: `0x${latest.version.toString(16)}`,
      date: latest.date,
      codeHash: latest.codeHash,
      dataHash: latest.dataHash,
      file: latest.file,
      size: latest.size,
      blocks: latest.blocks,
      sha256: latest.sha256,
      codeLength: latest.codeLength,
      dataLength: latest.dataLength,
      dataType: latest.dataType,
    },
  };
  await writeFile(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
  const low = latest.version & 0xffffff;
  const v = `${((low >>> 16) & 0xff).toString(16)}.${((low >>> 8) & 0xff).toString(16)}.${(low & 0xff).toString(16)}`;
  console.log(`[ota] firmware.json: ${latest.file} v${v}`
    + ` ${latest.date}, ${latest.blocks} blocks, ${latest.size} bytes`);
  console.log(`[ota] sha256 ${latest.sha256}`);
}

main().catch((error) => {
  console.error(`[ota] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
