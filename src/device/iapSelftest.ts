// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Offline checks for the Logic20 IAP package and update flow.
 *
 * Everything here runs without a device. The bundled .iap is real (the release
 * package shipped with /ota/), so the parser and CRC code are checked against
 * bytes produced by tools/iap_pack.py, not against a hand-written mock.
 *
 *   npm test -- --filter iap
 */

import { crc32 } from './iap/crc32.js';
import { aes128CbcDecrypt, aes128CbcEncrypt } from './iap/aes.js';
import {
  IAP_AES_IV,
  IAP_AES_KEY,
  IAP_HW_MASK,
  IAP_MAGIC,
  IAP_MAX_CODE_DATA,
  IAP_SNIFFER2_MAGIC,
} from './iap/constants.js';
import { buildInfoBlock, parseIapInfo, type IapInfo } from './iap/info.js';
import { align256, inspectPackage } from './iap/package.js';
import { parseManifest } from './iap/manifest.js';
import { compareFirmware, formatFirmware } from './iap/version.js';
import { runIapUpdate } from './iap/update.js';
import type { IapTransport } from './iap/transport.js';

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}

const results: Result[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

interface NodeProc {
  cwd?(): string;
  getBuiltinModule?(name: string): unknown;
  exit?(code: number): never;
}

const proc = (globalThis as { process?: NodeProc }).process;
const cwd = proc?.cwd?.() ?? '';
const fs = proc?.getBuiltinModule?.('fs') as { readFileSync(path: string): Uint8Array } | undefined;

function readRepoFile(path: string): Uint8Array | null {
  if (!fs) return null;
  try {
    return new Uint8Array(fs.readFileSync(`${cwd}/${path}`));
  } catch {
    return null;
  }
}

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let value = seed >>> 0;
  for (let i = 0; i < length; i++) {
    value = (Math.imul(value, 1103515245) + 12345) >>> 0;
    out[i] = (value >>> 16) & 0xff;
  }
  return out;
}

function pad(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(align256(data.length));
  out.fill(0xff);
  out.set(data);
  return out;
}

async function seal(info: Uint8Array, code: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const codePad = pad(code);
  const dataPad = pad(data);
  const plain = new Uint8Array(256 + codePad.length + dataPad.length);
  plain.set(info, 0);
  plain.set(codePad, 256);
  plain.set(dataPad, 256 + codePad.length);
  return aes128CbcEncrypt(plain, IAP_AES_KEY, IAP_AES_IV);
}

function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

interface InfoOptions {
  magic?: number;
  firmwareVersion?: number;
  code?: Uint8Array;
  data?: Uint8Array;
  codeLength?: number;
  dataLength?: number;
  dataType?: number;
  codeCrc32?: number;
  dataCrc32?: number;
  codeHash?: string;
  dataHash?: string;
}

function hash8(text: string): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < Math.min(8, text.length); i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function makeInfo(options: InfoOptions = {}): { block: Uint8Array; info: IapInfo; code: Uint8Array; data: Uint8Array } {
  const code = options.code ?? bytes(300, 0x1111);
  const data = options.data ?? bytes(100, 0x2222);
  const block = buildInfoBlock({
    magic: options.magic ?? IAP_MAGIC,
    hardwareVersionMask: 1,
    firmwareVersion: options.firmwareVersion ?? 0x900,
    buildDate: '2026-11-16',
    codeLength: options.codeLength ?? code.length,
    dataLength: options.dataLength ?? data.length,
    dataType: options.dataType ?? 2,
    codeCrc32: options.codeCrc32 ?? crc32(code),
    dataCrc32: options.dataCrc32 ?? crc32(data),
    ...(options.codeHash ? { codeHash: hash8(options.codeHash) } : {}),
    ...(options.dataHash ? { dataHash: hash8(options.dataHash) } : {}),
  });
  return { block, info: parseIapInfo(block), code, data };
}

class FakeTransport implements IapTransport {
  readonly device = {} as unknown as USBDevice;
  readonly written = new Map<number, Uint8Array>();
  infoValue: IapInfo | null;
  failIndex = -1;
  failRemaining = 0;
  resetCalled = false;
  closed = false;

  constructor(info: IapInfo | null) {
    this.infoValue = info;
  }

  async info(): Promise<IapInfo | null> {
    return this.infoValue;
  }

  async writeBlock(index: number, block: Uint8Array): Promise<void> {
    if (index === this.failIndex && this.failRemaining > 0) {
      this.failRemaining--;
      throw new Error('simulated transfer error');
    }
    this.written.set(index, block.slice());
  }

  async reset(): Promise<void> {
    this.resetCalled = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

async function main(): Promise<void> {
  check('CRC-32 matches zlib vectors', crc32(new Uint8Array()) === 0 && crc32(ascii('123456789')) === 0xcbf43926,
    `empty=0x${crc32(new Uint8Array()).toString(16)} check=0x${crc32(ascii('123456789')).toString(16)}`);

  const nistKey = fromHex('2b7e151628aed2a6abf7158809cf4f3c');
  const nistIv = fromHex('000102030405060708090a0b0c0d0e0f');
  const nistPlain = fromHex(
    '6bc1bee22e409f96e93d7e117393172a'
    + 'ae2d8a571e03ac9c9eb76fac45af8e51'
    + '30c81c46a35ce411e5fbc1191a0a52ef'
    + 'f69f2445df4f9b17ad2b417be66c3710');
  const nistCipher = fromHex(
    '7649abac8119b246cee98e9b12e9197d'
    + '5086cb9b507219ee95db113a917678b2'
    + '73bed6b8e3c1743b7116e69e22229516'
    + '3ff1caa1681fac09120eca307586e1a7');
  const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length
    && a.every((value, index) => value === b[index]);
  const nistEncrypted = aes128CbcEncrypt(nistPlain, nistKey, nistIv);
  const nistDecrypted = aes128CbcDecrypt(nistCipher, nistKey, nistIv);
  check('AES-128-CBC matches NIST SP 800-38A', equal(nistEncrypted, nistCipher) && equal(nistDecrypted, nistPlain),
    `encrypt=${equal(nistEncrypted, nistCipher)} decrypt=${equal(nistDecrypted, nistPlain)}`);

  check('firmware versions format as three hexadecimal bytes', formatFirmware(0x00002611) === '0.26.11'
    && formatFirmware(0x00019901) === '1.99.1' && formatFirmware(0x00010001) === '1.0.1'
    && formatFirmware(0x00000824) === '0.8.24',
  `${formatFirmware(0x00002611)} ${formatFirmware(0x00019901)} ${formatFirmware(0x00010001)} ${formatFirmware(0x00000824)}`);
  check('firmware versions compare numerically', compareFirmware(0x824, 0x820) === 1
    && compareFirmware(0x820, 0x820) === 0 && compareFirmware(0x800, 0x824) === -1, '0x824 > 0x820 > 0x800');

  const manifestBytes = readRepoFile('ota/public/firmware.json');
  const manifest = manifestBytes
    ? parseManifest(JSON.parse(new TextDecoder().decode(manifestBytes)))
    : null;
  check('bundled manifest parses', manifest !== null,
    manifest ? `${manifest.latest.file} v${formatFirmware(manifest.latest.version)}` : 'missing or invalid');

  check('bundled manifest identifies Logic20',
    manifest !== null && manifest.product === 'Logic20' && manifest.magic === IAP_MAGIC
    && manifest.hwMask === IAP_HW_MASK,
    manifest ? `product=${manifest.product} magic=0x${manifest.magic.toString(16)} hw=${manifest.hwMask}` : 'no manifest');

  check('manifest rejects path traversal and bad hashes', parseManifest({
    schema: 1,
    product: 'Logic20',
    magic: '0x20260820',
    hwMask: 1,
    latest: {
      version: '0x824', date: '2026-11-12', file: '../x.iap', size: 1, blocks: 1,
      sha256: '0'.repeat(64), codeLength: 1, dataLength: 0, dataType: 0,
    },
  }) === null, 'file must be a bare .iap name');

  if (manifest) {
    const raw = readRepoFile(`ota/public/firmware/${manifest.latest.file}`);
    check('bundled .iap is present', raw !== null, manifest.latest.file);
    if (raw) {
      const checked = await inspectPackage(raw);
      check('bundled .iap is a valid Logic20 package', checked.ok && checked.kind === 'logic20',
        `ok=${checked.ok} kind=${checked.kind} problems=${checked.problems.join(',') || 'none'}`);
      check('bundled .iap matches the manifest hash and size',
        checked.sha256 === manifest.latest.sha256 && raw.length === manifest.latest.size
        && checked.blocks === manifest.latest.blocks,
        `sha=${checked.sha256.slice(0, 12)}… size=${raw.length} blocks=${checked.blocks}`);
      if (checked.info) {
        check('bundled .iap info matches the manifest',
          checked.info.firmwareVersion === manifest.latest.version
          && checked.info.buildDate === manifest.latest.date
          && checked.info.codeLength === manifest.latest.codeLength
          && checked.info.dataLength === manifest.latest.dataLength
          && checked.info.dataType === manifest.latest.dataType
          && checked.info.codeHash === manifest.latest.codeHash
          && checked.info.dataHash === manifest.latest.dataHash,
          `fw=0x${checked.info.firmwareVersion.toString(16)} date=${checked.info.buildDate}`
          + ` code=${checked.info.codeLength} data=${checked.info.dataLength} type=${checked.info.dataType}`
          + ` codeHash=${checked.info.codeHash} dataHash=${checked.info.dataHash}`);
        check('bundled .iap info CRC and code/data CRC are valid',
          checked.info.infoCrcOk
          && !checked.problems.includes('code-crc') && !checked.problems.includes('data-crc'),
          `infoCrc=${checked.info.infoCrcOk} code=0x${checked.info.codeCrc32.toString(16)} data=0x${checked.info.dataCrc32.toString(16)}`);
      } else {
        check('bundled .iap carries an info block', false, 'no info');
      }
    }
  }

  const made = makeInfo({ codeHash: 'a855b02C', dataHash: '47357b4C' });
  check('info parser uses the iap.h offsets', made.info.codeCrc32 === crc32(made.code)
    && made.info.dataCrc32 === crc32(made.data) && made.info.buildDate === '2026-11-16'
    && made.info.codeHash === 'a855b02C' && made.info.dataHash === '47357b4C'
    && made.info.infoCrcOk, `code=0x${made.info.codeCrc32.toString(16)} data=0x${made.info.dataCrc32.toString(16)}`
    + ` hashes=${made.info.codeHash}/${made.info.dataHash}`);

  const packageBytes = await seal(made.block, made.code, made.data);
  const synthetic = await inspectPackage(packageBytes);
  check('a synthetic Logic20 package passes', synthetic.ok && synthetic.kind === 'logic20'
    && synthetic.blocks === packageBytes.length / 256, `blocks=${synthetic.blocks} problems=${synthetic.problems.join(',') || 'none'}`);

  const sniffer = makeInfo({ magic: IAP_SNIFFER2_MAGIC });
  const snifferCheck = await inspectPackage(await seal(sniffer.block, sniffer.code, sniffer.data));
  check('a USB Sniffer 2 package is rejected', !snifferCheck.ok && snifferCheck.kind === 'sniffer2'
    && snifferCheck.problems.includes('magic-sniffer2'), snifferCheck.problems.join(','));

  const unknown = makeInfo({ magic: 0x12345678 });
  const unknownCheck = await inspectPackage(await seal(unknown.block, unknown.code, unknown.data));
  check('an unknown magic is rejected', !unknownCheck.ok && unknownCheck.problems.includes('magic-unknown'),
    unknownCheck.problems.join(','));

  const badCode = makeInfo({ codeCrc32: crc32(made.code) ^ 1 });
  const badCodeCheck = await inspectPackage(await seal(badCode.block, badCode.code, badCode.data));
  check('a wrong code CRC is rejected', !badCodeCheck.ok && badCodeCheck.problems.includes('code-crc'),
    badCodeCheck.problems.join(','));

  const badInfo = makeInfo();
  badInfo.block[252] ^= 1;
  const badInfoCheck = await inspectPackage(await seal(badInfo.block, badInfo.code, badInfo.data));
  check('a wrong info CRC is rejected', !badInfoCheck.ok && badInfoCheck.problems.includes('info-crc'),
    badInfoCheck.problems.join(','));

  const oversized = makeInfo({ codeLength: IAP_MAX_CODE_DATA + 256 });
  const oversizedCheck = await inspectPackage(await seal(oversized.block, oversized.code, oversized.data));
  check('a package past the dynamic region is rejected',
    !oversizedCheck.ok && oversizedCheck.problems.includes('capacity'), oversizedCheck.problems.join(','));

  const wrongType = makeInfo({ dataType: 0 });
  const wrongTypeCheck = await inspectPackage(await seal(wrongType.block, wrongType.code, wrongType.data));
  check('attached FPGA data with the invalid type is rejected',
    !wrongTypeCheck.ok && wrongTypeCheck.problems.includes('data-type'), wrongTypeCheck.problems.join(','));

  const wrongLayout = makeInfo({ codeLength: 300 + 256 });
  const wrongLayoutCheck = await inspectPackage(await seal(wrongLayout.block, wrongLayout.code, wrongLayout.data));
  check('a package whose lengths do not match is rejected',
    !wrongLayoutCheck.ok && wrongLayoutCheck.problems.includes('layout'), wrongLayoutCheck.problems.join(','));

  const first = new FakeTransport(null);
  const after = new FakeTransport(made.info);
  const outcome = await runIapUpdate({
    transport: first,
    expected: made.info,
    rediscover: async () => after,
  }, packageBytes);
  check('update writes every block, resets and confirms',
    outcome.ok && first.written.size === packageBytes.length / 256 && first.resetCalled && first.closed
    && outcome.next === after && outcome.current?.firmwareVersion === made.info.firmwareVersion,
    `ok=${outcome.ok} blocks=${first.written.size} reset=${first.resetCalled} next=${outcome.next === after}`);

  const firstBlock = first.written.get(0);
  check('the transport receives the package bytes unchanged',
    firstBlock !== undefined && firstBlock.every((byte, index) => byte === packageBytes[index]),
    `block0=${firstBlock?.length ?? 0} B`);

  const old = makeInfo({ firmwareVersion: 0x800 });
  const stale = new FakeTransport(old.info);
  const staleOutcome = await runIapUpdate({
    transport: new FakeTransport(null),
    expected: made.info,
    rediscover: async () => stale,
  }, packageBytes);
  check('a device still running the old image is not reported as success',
    !staleOutcome.ok && staleOutcome.failure === 'unconfirmed' && staleOutcome.next === stale,
    `failure=${staleOutcome.failure}`);

  const missing = await runIapUpdate({
    transport: new FakeTransport(null),
    expected: made.info,
    rediscover: async () => null,
  }, packageBytes);
  check('a device that never returns is a reset failure',
    !missing.ok && missing.failure === 'reset-unseen', `failure=${missing.failure}`);

  const flaky = new FakeTransport(null);
  flaky.failIndex = 2;
  flaky.failRemaining = 1;
  const flakyOutcome = await runIapUpdate({
    transport: flaky,
    expected: made.info,
    rediscover: async () => new FakeTransport(made.info),
  }, packageBytes);
  check('one transfer error is retried', flakyOutcome.ok && flaky.written.size === packageBytes.length / 256,
    `ok=${flakyOutcome.ok} blocks=${flaky.written.size}`);

  const dead = new FakeTransport(null);
  dead.failIndex = 2;
  dead.failRemaining = 99;
  const deadOutcome = await runIapUpdate({
    transport: dead,
    expected: made.info,
    rediscover: async () => new FakeTransport(made.info),
  }, packageBytes);
  check('a persistent transfer error stops after the retries',
    !deadOutcome.ok && deadOutcome.failure === 'transfer' && dead.written.size === 2,
    `failure=${deadOutcome.failure} blocks=${dead.written.size}`);

  const failed = results.filter((entry) => !entry.pass).length;
  console.log(results.map((entry) =>
    `${entry.pass ? 'PASS' : 'FAIL'}  ${entry.name}\n        ${entry.detail}`).join('\n'));
  console.log(`\n${results.length - failed}/${results.length} passed`);
  proc?.exit?.(failed === 0 ? 0 : 1);
}

void main();
