// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Standalone /ota/ page controller.
 *
 * It shares the protocol modules in src/device/iap with the analyzer, but no UI,
 * store, worker or i18n catalogue: this page is deployed on its own under /ota/.
 */

import {
  IAP_HW_MASK,
  IAP_INFO_SIZE,
  IAP_MAGIC,
  IAP_PID,
  IAP_PRODUCT,
  IAP_SNIFFER2_MAGIC,
  IAP_VID,
} from '../../src/device/iap/constants.js';
import type { IapInfo } from '../../src/device/iap/info.js';
import { align256, inspectPackage, type PackageCheck, type PackageProblem } from '../../src/device/iap/package.js';
import { parseManifest, type OtaManifest } from '../../src/device/iap/manifest.js';
import { openIapDevice, type IapTransport } from '../../src/device/iap/transport.js';
import { runIapUpdate, type IapUpdateFailure } from '../../src/device/iap/update.js';
import { compareFirmware, formatFirmware } from '../../src/device/iap/version.js';
import { t, type Key, type Lang } from './strings.js';

type Phase =
  | 'idle' | 'connecting' | 'connected' | 'checking' | 'ready'
  | 'uploading' | 'resetting' | 'verifying' | 'done' | 'failed';

interface DeviceView {
  device: USBDevice;
  transport: IapTransport;
  product: string;
  info: IapInfo | null;
}

interface PackageView {
  name: string;
  source: 'local' | 'bundled';
  bytes: Uint8Array;
  check: PackageCheck;
}

interface ResultView {
  ok: boolean;
  title: string;
  body: string;
  action: 'retry' | 'reconnect' | 'none';
}

const usb: USB | null = 'usb' in navigator ? navigator.usb : null;
const BASE = import.meta.env.BASE_URL;

const PROBLEM_KEYS: Record<PackageProblem, Key> = {
  size: 'problem_size',
  blocks: 'problem_blocks',
  decrypt: 'problem_decrypt',
  'magic-sniffer2': 'problem_magicSniffer2',
  'magic-unknown': 'problem_magicUnknown',
  'hw-mask': 'problem_hwMask',
  'info-crc': 'problem_infoCrc',
  layout: 'problem_layout',
  capacity: 'problem_capacity',
  'data-type': 'problem_dataType',
  'code-crc': 'problem_codeCrc',
  'data-crc': 'problem_dataCrc',
  'manifest-mismatch': 'problem_manifest',
};

let lang: Lang = readPref('lang') === 'en' ? 'en' : 'zh';
let device: DeviceView | null = null;
let pkg: PackageView | null = null;
let manifest: OtaManifest | null = null;
let phase: Phase = 'idle';
let busy = false;
let result: ResultView | null = null;
let ackDowngrade = false;
let deviceError = '';
let packageError = '';
let packageLoad = 0;
let progress = { done: 0, total: 0 };
const logs: string[] = [];

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

function readPref(key: string): string | null {
  try { return localStorage.getItem(`logic20-ota-${key}`); } catch { return null; }
}

function writePref(key: string, value: string): void {
  try { localStorage.setItem(`logic20-ota-${key}`, value); } catch { /* storage unavailable */ }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(value: number): string {
  if (value >= 1048576) return `${(value / 1048576).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

function log(message: string): void {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  logs.push(`[${time}] ${message}`);
  if (logs.length > 400) logs.splice(0, logs.length - 400);
  const box = $('log-box');
  box.hidden = false;
  $('log').textContent = logs.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}

function applyStaticStrings(): void {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t(lang, 'title');
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    element.textContent = t(lang, element.dataset.i18n as Key);
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    element.title = t(lang, element.dataset.i18nTitle as Key);
    element.setAttribute('aria-label', element.title);
  }
  $('lang').textContent = t(lang, 'langLabel');
}

function showBanner(title: string, body: string): void {
  const banner = $('banner');
  banner.hidden = false;
  $('banner-title').textContent = title;
  $('banner-body').textContent = body;
}

function renderBanner(): void {
  const banner = $('banner');
  banner.hidden = true;
  if (!window.isSecureContext) {
    showBanner(t(lang, 'bannerInsecureTitle'), t(lang, 'bannerInsecureBody'));
  } else if (!usb) {
    showBanner(t(lang, 'bannerNoWebUsbTitle'), t(lang, 'bannerNoWebUsbBody'));
  }
}

function renderDevice(): void {
  const connected = device !== null;
  $('device-empty').hidden = connected;
  $('device-info').hidden = !connected;
  $('device-pill').hidden = !connected;
  $('connect').toggleAttribute('disabled', !usb || busy || connected);
  $('device-error').hidden = !deviceError;
  $('device-error').textContent = deviceError;

  if (!device) return;
  const info = device.info;
  $('device-name').textContent = device.product;
  $('device-serial').textContent = device.device.serialNumber ? `S/N ${device.device.serialNumber}` : '';

  if (info) {
    const other = info.magic === IAP_SNIFFER2_MAGIC;
    const invalid = !other && (info.magic !== IAP_MAGIC || !info.infoCrcOk);
    if (other || invalid) {
      const note = other
        ? t(lang, 'deviceOtherProduct', { name: 'USB Sniffer 2' })
        : t(lang, 'deviceInvalidFirmware');
      $('device-version').textContent = other ? '—' : t(lang, 'deviceInvalidFirmware');
      $('device-date').textContent = '—';
      $('device-size').textContent = '—';
      $('device-code').textContent = '—';
      $('device-code-hash').textContent = '—';
      $('device-data-hash').textContent = '—';
      $('device-note').hidden = false;
      $('device-note').textContent = note;
    } else {
      const imageBytes = IAP_INFO_SIZE + align256(info.codeLength) + align256(info.dataLength);
      const fallback = matchingPackageHashes(info);
      $('device-version').textContent = formatFirmware(info.firmwareVersion);
      $('device-date').textContent = info.buildDate || '—';
      $('device-size').textContent = `${formatBytes(imageBytes)} (${imageBytes.toLocaleString()} B)`;
      $('device-code').textContent = `${formatBytes(info.codeLength)} (${info.codeLength.toLocaleString()} B)`;
      $('device-code-hash').textContent = info.codeHash || fallback?.code || t(lang, 'notRecorded');
      $('device-data-hash').textContent = info.dataHash || fallback?.data || t(lang, 'notRecorded');
      $('device-note').hidden = true;
      $('device-note').textContent = '';
    }
  } else {
    $('device-version').textContent = t(lang, 'deviceNoInfo');
    $('device-date').textContent = '—';
    $('device-size').textContent = '—';
    $('device-code').textContent = '—';
    $('device-code-hash').textContent = '—';
    $('device-data-hash').textContent = '—';
    $('device-note').hidden = true;
    $('device-note').textContent = '';
  }
}

/**
 * The device may run a package packed before code_hash/data_hash were populated.
 * If its code/data CRCs match the selected package, those hashes describe the
 * running image and can fill the empty fields; otherwise leave "not recorded".
 */
function matchingPackageHashes(info: IapInfo): { code: string; data: string } | null {
  const candidate = pkg?.check.info;
  if (!candidate || candidate.magic !== IAP_MAGIC || !candidate.infoCrcOk) return null;
  if (candidate.firmwareVersion !== info.firmwareVersion
    || candidate.codeLength !== info.codeLength
    || candidate.dataLength !== info.dataLength
    || candidate.codeCrc32 !== info.codeCrc32
    || candidate.dataCrc32 !== info.dataCrc32) return null;
  return { code: candidate.codeHash, data: candidate.dataHash };
}

function versionRelation(): -1 | 0 | 1 | null {
  if (!device?.info || !pkg?.check.info) return null;
  if (device.info.magic !== IAP_MAGIC || pkg.check.info.magic !== IAP_MAGIC) return null;
  return compareFirmware(pkg.check.info.firmwareVersion, device.info.firmwareVersion);
}

function renderPackage(): void {
  $('drop').hidden = pkg !== null;
  $('file-info').hidden = pkg === null;
  $('package-error').hidden = !packageError;
  $('package-error').textContent = packageError;

  $('bundled-box').hidden = manifest === null || phase === 'checking' || pkg?.source === 'bundled';
  $('bundled').toggleAttribute('disabled', busy || phase === 'checking');
  if (manifest) {
    $('bundled-label').textContent = t(lang, 'bundledLabel', {
      version: formatFirmware(manifest.latest.version),
      date: manifest.latest.date,
    });
  }

  if (!pkg) return;
  const info = pkg.check.info;
  const validInfo = info && info.magic === IAP_MAGIC && info.infoCrcOk ? info : null;
  $('file-name').textContent = pkg.name;
  $('file-source').hidden = false;
  $('file-source').textContent = t(lang, pkg.source === 'bundled' ? 'sourceBundled' : 'sourceLocal');
  $('file-version').textContent = validInfo ? formatFirmware(validInfo.firmwareVersion) : '—';
  $('file-date').textContent = validInfo ? (validInfo.buildDate || '—') : '—';
  $('file-size').textContent = `${formatBytes(pkg.bytes.length)} (${pkg.bytes.length.toLocaleString()} B)`;
  $('file-code').textContent = validInfo
    ? `${formatBytes(validInfo.codeLength)} (${validInfo.codeLength.toLocaleString()} B)`
    : '—';
  $('file-code-hash').textContent = validInfo ? (validInfo.codeHash || t(lang, 'notRecorded')) : '—';
  $('file-data-hash').textContent = validInfo ? (validInfo.dataHash || t(lang, 'notRecorded')) : '—';
  $('file-sha').textContent = pkg.check.sha256;

  const box = $('precheck');
  box.className = 'precheck';
  box.replaceChildren();
  box.hidden = false;
  if (phase === 'checking') {
    box.classList.add('neutral');
    box.textContent = t(lang, 'precheckRunning');
  } else if (pkg.check.ok) {
    box.classList.add('ok');
    box.textContent = t(lang, 'precheckOk');
  } else {
    box.classList.add('bad');
    const title = document.createElement('p');
    title.textContent = t(lang, 'precheckFail');
    const list = document.createElement('ul');
    for (const problem of new Set(pkg.check.problems)) {
      const item = document.createElement('li');
      item.textContent = t(lang, PROBLEM_KEYS[problem]);
      list.append(item);
    }
    box.append(title, list);
  }

  const relation = versionRelation();
  const note = $('version-note');
  const ackRow = $('ack-row');
  if (relation === null) {
    note.hidden = true;
    ackRow.hidden = true;
  } else {
    note.hidden = false;
    note.classList.toggle('warn', relation === -1);
    note.textContent = relation === 0 ? t(lang, 'sameVersion')
      : relation > 0 ? t(lang, 'newerVersion')
        : t(lang, 'olderVersion');
    ackRow.hidden = relation !== -1;
    input('ack').checked = ackDowngrade;
  }
  $('file-change').toggleAttribute('disabled', busy);
}

function paintProgress(): void {
  const visible = phase === 'uploading' || phase === 'resetting' || phase === 'verifying' || phase === 'done';
  $('progress').hidden = !visible;
  if (!visible) return;
  const total = progress.total || 1;
  let percent: number;
  if (phase === 'uploading') {
    // 0..1% is the preparation/start stage, 1..98% the write, 99% the reset and
    // re-enumeration wait. The bar reaches 100% only after the device confirms.
    percent = 1 + Math.min(1, progress.done / total) * 97;
  } else if (phase === 'done') {
    percent = 100;
  } else {
    percent = 99;
  }
  $('bar-fill').style.width = `${percent.toFixed(1)}%`;
  $('progress').setAttribute('aria-valuenow', String(Math.round(percent)));
}

function renderResult(): void {
  const box = $('result');
  box.hidden = result === null;
  if (!result) return;
  box.className = `result ${result.ok ? 'ok' : 'fail'}`;
  $('result-title').textContent = result.title;
  $('result-body').textContent = result.body;
  const button = $('result-btn');
  button.hidden = result.action === 'none';
  if (result.action !== 'none') {
    button.textContent = result.action === 'retry' ? t(lang, 'retry') : t(lang, 'reconnect');
  }
}

function renderUpdate(): void {
  const relation = versionRelation();
  const info = pkg?.check.info;
  const wrongProduct = device?.info?.magic === IAP_SNIFFER2_MAGIC;
  let ready = '';
  let canStart = false;

  if (!device) ready = t(lang, 'readyNeedDevice');
  else if (wrongProduct) ready = t(lang, 'deviceOtherProduct', { name: 'USB Sniffer 2' });
  else if (!pkg) ready = t(lang, 'readyNeedPackage');
  else if (phase === 'checking') ready = t(lang, 'precheckRunning');
  else if (!pkg.check.ok || !info) ready = t(lang, 'readyBadPackage');
  else if (relation === -1 && !ackDowngrade) ready = t(lang, 'readyNeedAck');
  else {
    ready = t(lang, 'readyOk', {
      version: formatFirmware(info.firmwareVersion),
      product: device.product,
    });
    canStart = true;
  }

  $('ready').textContent = ready;
  $('ready').hidden = busy || result !== null;
  const success = result?.ok === true;
  const showStart = !busy && (result === null || success);
  $('start').hidden = !showStart;
  $('start').textContent = relation === 0 ? t(lang, 'reupgrade') : t(lang, 'start');
  $('start').toggleAttribute('disabled', !showStart || !canStart);

  paintProgress();
  renderResult();
  $('log-box').hidden = logs.length === 0;
}

function render(): void {
  renderBanner();
  renderDevice();
  renderPackage();
  renderUpdate();
}

async function adoptDevice(candidate: USBDevice): Promise<void> {
  if (busy) return;
  result = null;
  const name = candidate.productName?.trim() ?? '';
  if (name && !/logic20/i.test(name)) {
    deviceError = t(lang, 'deviceOtherProduct', { name });
    render();
    return;
  }
  if (device && device.device !== candidate) {
    const previous = device;
    device = null;
    await previous.transport.close();
  }
  phase = 'connecting';
  deviceError = '';
  packageError = '';
  render();

  try {
    const transport = await openIapDevice(candidate);
    let info: IapInfo | null = null;
    try {
      info = await transport.info();
    } catch (e) {
      log(`InfoGet failed: ${messageOf(e)}`);
    }
    if (info?.magic === IAP_SNIFFER2_MAGIC) {
      await transport.close();
      deviceError = t(lang, 'deviceOtherProduct', { name: 'USB Sniffer 2' });
      phase = pkg ? 'ready' : 'idle';
      render();
      return;
    }
    device = { device: candidate, transport, product: name || IAP_PRODUCT, info };
    phase = pkg ? 'ready' : 'connected';
    log(`Connected ${device.product}${candidate.serialNumber ? `, ${candidate.serialNumber}` : ''}`);
    if (info) {
      if (info.magic === IAP_MAGIC && info.infoCrcOk) {
        log(`InfoGet: fw ${formatFirmware(info.firmwareVersion)}, code ${info.codeLength}`);
      } else {
        log('InfoGet: invalid firmware info');
      }
    } else {
      log('InfoGet: no valid firmware info (an update is still possible)');
    }
  } catch (e) {
    deviceError = t(lang, 'openFailed', { message: messageOf(e) });
    phase = pkg ? 'ready' : 'idle';
    log(deviceError);
  }
  render();
}

async function connectDevice(): Promise<void> {
  if (!usb || busy) return;
  try {
    const chosen = await usb.requestDevice({ filters: [{ vendorId: IAP_VID, productId: IAP_PID }] });
    await adoptDevice(chosen);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return;
    deviceError = t(lang, 'selectFailed', { message: messageOf(e) });
    render();
  }
}

async function disconnectDevice(): Promise<void> {
  const current = device;
  device = null;
  phase = pkg ? 'ready' : 'idle';
  deviceError = '';
  result = null;
  if (current) await current.transport.close();
  render();
}

async function readAgain(): Promise<void> {
  if (!device || busy) return;
  try {
    device.info = await device.transport.info();
    deviceError = '';
    log(device.info
      ? (device.info.magic === IAP_MAGIC && device.info.infoCrcOk
        ? `InfoGet: fw ${formatFirmware(device.info.firmwareVersion)}`
        : 'InfoGet: invalid firmware info')
      : 'InfoGet: no valid firmware info');
  } catch (e) {
    deviceError = t(lang, 'infoFailed', { message: messageOf(e) });
    log(deviceError);
  }
  render();
}

async function inspectBytes(
  bytes: Uint8Array,
  name: string,
  source: 'local' | 'bundled',
  seq: number,
  expectedSha?: string,
): Promise<void> {
  phase = 'checking';
  packageError = '';
  result = null;
  ackDowngrade = false;
  render();
  try {
    const check = await inspectPackage(bytes);
    if (seq !== packageLoad) return;
    if (expectedSha && check.sha256 !== expectedSha && !check.problems.includes('manifest-mismatch')) {
      check.problems.push('manifest-mismatch');
      check.ok = false;
    }
    pkg = { name, source, bytes, check };
    phase = 'ready';
    log(`Package ${name}: ${bytes.length} bytes, SHA-256 ${check.sha256}`);
    for (const problem of check.problems) log(`Package problem: ${problem}`);
  } catch (e) {
    if (seq !== packageLoad) return;
    pkg = null;
    packageError = t(lang, 'packageReadFailed', { message: messageOf(e) });
    phase = device ? 'connected' : 'idle';
    log(packageError);
  }
  render();
}

async function loadLocalFile(file: File): Promise<void> {
  if (busy) return;
  const seq = ++packageLoad;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (seq !== packageLoad) return;
    await inspectBytes(bytes, file.name, 'local', seq);
  } catch (e) {
    if (seq !== packageLoad) return;
    packageError = t(lang, 'packageReadFailed', { message: messageOf(e) });
    render();
  }
}

async function loadBundled(): Promise<void> {
  if (busy) return;
  if (!manifest) {
    packageError = t(lang, 'manifestMissing');
    render();
    return;
  }
  const seq = ++packageLoad;
  phase = 'checking';
  packageError = '';
  result = null;
  ackDowngrade = false;
  render();
  try {
    const url = new URL(`firmware/${manifest.latest.file}`, new URL(BASE, location.href)).href;
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (seq !== packageLoad) return;
    log(`Bundled package ${manifest.latest.file}: ${bytes.length} bytes`);
    await inspectBytes(bytes, manifest.latest.file, 'bundled', seq, manifest.latest.sha256);
  } catch (e) {
    if (seq !== packageLoad) return;
    pkg = null;
    packageError = t(lang, 'fetchFailed', { message: messageOf(e) });
    phase = device ? 'connected' : 'idle';
    log(packageError);
    render();
  }
}

async function rediscover(old: USBDevice): Promise<IapTransport | null> {
  if (!usb) return null;
  const serial = old.serialNumber;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let devices: USBDevice[] = [];
    try { devices = await usb.getDevices(); } catch { devices = []; }
    for (const candidate of devices) {
      if (candidate === old || candidate.vendorId !== IAP_VID || candidate.productId !== IAP_PID) continue;
      const sameSerial = serial ? candidate.serialNumber === serial : false;
      if (!sameSerial && !/logic20/i.test(candidate.productName ?? '')) continue;
      let transport: IapTransport | null = null;
      try {
        transport = await openIapDevice(candidate);
        const info = await transport.info();
        if (info) return transport;
      } catch { /* still enumerating */ }
      try { await transport?.close(); } catch { /* already gone */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  log('Device did not re-enumerate within 10 s');
  return null;
}

function failureText(failure: IapUpdateFailure, message: string | undefined): string {
  if (failure === 'transfer') return t(lang, 'failureTransfer', { message: message ?? '' });
  if (failure === 'reset-unseen') return t(lang, 'failureResetUnseen');
  return t(lang, 'failureUnconfirmed');
}

async function start(): Promise<void> {
  if (busy || phase === 'checking' || !device || !pkg || !pkg.check.ok || !pkg.check.info) return;
  const expected = pkg.check.info;
  if (!expected) return;
  const relation = versionRelation();
  if (relation === -1 && !ackDowngrade) return;

  const active = device;
  const current = pkg;
  busy = true;
  result = null;
  phase = 'uploading';
  progress = { done: 0, total: current.check.blocks };
  log(`Update started: ${current.name}, ${current.bytes.length} bytes, ${current.check.blocks} blocks`);

  try {
    const outcome = await runIapUpdate({
      transport: active.transport,
      expected,
      rediscover: () => rediscover(active.device),
    }, current.bytes, {
      onPhase: (next) => {
        phase = next === 'writing' ? 'uploading' : next;
        render();
      },
      onProgress: (done, total) => {
        progress.done = done;
        progress.total = total;
        paintProgress();
      },
      onLog: (message) => log(message),
    });

    if (outcome.next) {
      device = {
        device: outcome.next.device,
        transport: outcome.next,
        product: outcome.next.device.productName?.trim() || active.product,
        info: outcome.current ?? null,
      };
    } else if (outcome.failure === 'reset-unseen') {
      device = null;
    }

    if (outcome.ok && outcome.current) {
      phase = 'done';
      result = {
        ok: true,
        title: t(lang, 'resultOkTitle'),
        body: t(lang, 'resultOkBody', {
          version: formatFirmware(outcome.current.firmwareVersion),
          date: outcome.current.buildDate || '—',
        }),
        action: 'none',
      };
      log('Update confirmed by the device');
    } else {
      phase = 'failed';
      const failure = outcome.failure ?? 'transfer';
      result = {
        ok: false,
        title: t(lang, 'resultFailTitle'),
        body: failureText(failure, outcome.message),
        action: failure === 'reset-unseen' || !device ? 'reconnect' : 'retry',
      };
      log(`Update failed: ${failure}${outcome.message ? ` (${outcome.message})` : ''}`);
    }
  } catch (e) {
    phase = 'failed';
    result = {
      ok: false,
      title: t(lang, 'resultFailTitle'),
      body: t(lang, 'failureTransfer', { message: messageOf(e) }),
      action: device ? 'retry' : 'reconnect',
    };
    log(`Update failed: ${messageOf(e)}`);
  } finally {
    busy = false;
    render();
  }
}

async function loadManifest(): Promise<void> {
  try {
    const response = await fetch(new URL('firmware.json', new URL(BASE, location.href)).href, { cache: 'no-cache' });
    if (!response.ok) return;
    const parsed = parseManifest(await response.json());
    if (parsed && parsed.product === IAP_PRODUCT && parsed.magic === IAP_MAGIC
      && (parsed.hwMask & IAP_HW_MASK) !== 0) {
      manifest = parsed;
    } else {
      manifest = null;
      log('firmware.json: not a Logic20 manifest');
    }
  } catch {
    manifest = null;
  }
  render();
}

async function copyText(text: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent ?? '';
    button.textContent = t(lang, 'copied');
    setTimeout(() => { button.textContent = old; }, 1200);
  } catch {
    log(t(lang, 'copyFailed'));
  }
}

function wire(): void {
  $('connect').addEventListener('click', () => { void connectDevice(); });
  $('change').addEventListener('click', () => { void connectDevice(); });
  $('disconnect').addEventListener('click', () => { void disconnectDevice(); });
  $('read-again').addEventListener('click', () => { void readAgain(); });
  $('bundled').addEventListener('click', () => { void loadBundled(); });
  $('file-change').addEventListener('click', () => {
    input('file').value = '';
    input('file').click();
  });
  input('file').addEventListener('change', () => {
    const file = input('file').files?.[0];
    if (file) void loadLocalFile(file);
  });
  $('ack').addEventListener('change', () => {
    ackDowngrade = input('ack').checked;
    render();
  });
  $('start').addEventListener('click', () => { void start(); });
  $('result-btn').addEventListener('click', () => {
    if (!result) return;
    const action = result.action;
    result = null;
    render();
    if (action === 'retry') void start();
    else if (action === 'reconnect') void connectDevice();
  });
  $('lang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    writePref('lang', lang);
    applyStaticStrings();
    render();
  });
  $('theme').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    writePref('theme', next);
  });
  $('copy-sha').addEventListener('click', () => {
    if (pkg) void copyText(pkg.check.sha256, $('copy-sha'));
  });
  $('copy-log').addEventListener('click', (event) => {
    event.preventDefault();
    void copyText(logs.join('\n'), $('copy-log'));
  });

  const dropInto = (element: HTMLElement): void => {
    element.addEventListener('dragover', (event) => {
      event.preventDefault();
      $('card-file').classList.add('over');
    });
    element.addEventListener('dragleave', () => $('card-file').classList.remove('over'));
    element.addEventListener('drop', (event) => {
      event.preventDefault();
      $('card-file').classList.remove('over');
      const file = event.dataTransfer?.files?.[0];
      if (file) void loadLocalFile(file);
    });
  };
  dropInto($('drop'));
  dropInto($('file-info'));

  window.addEventListener('beforeunload', (event) => {
    if (!busy) return;
    event.preventDefault();
    event.returnValue = t(lang, 'leaveWarning');
  });

  usb?.addEventListener('disconnect', (event) => {
    const changed = (event as { device?: USBDevice }).device;
    if (!device || changed !== device.device) return;
    if (busy) {
      log('Device disconnected during the update');
      // A reset is expected to remove it; runIapUpdate re-opens what comes back.
      // For any other disconnect the old handle is dead, so do not offer a retry
      // on it.
      device = null;
      return;
    }
    device = null;
    phase = pkg ? 'ready' : 'idle';
    deviceError = t(lang, 'deviceGone');
    result = null;
    render();
  });
  usb?.addEventListener('connect', (event) => {
    const added = (event as { device?: USBDevice }).device;
    if (!added || busy || device) return;
    if (added.vendorId !== IAP_VID || added.productId !== IAP_PID) return;
    if (!/logic20/i.test(added.productName ?? '')) return;
    void adoptDevice(added);
  });
}

async function autoAdopt(target: USB): Promise<void> {
  try {
    const known = (await target.getDevices()).filter((candidate) => candidate.vendorId === IAP_VID
      && candidate.productId === IAP_PID
      && /logic20/i.test(candidate.productName ?? ''));
    if (known[0]) await adoptDevice(known[0]);
  } catch { /* optional */ }
}

async function init(): Promise<void> {
  applyStaticStrings();
  wire();
  render();

  await loadManifest();
  if (manifest) await loadBundled();
  if (!usb) return;
  // Do not delay the load event on a browser call that can wait for the USB
  // service; the page is already interactive and this runs in the background.
  void autoAdopt(usb);
}

await init();
