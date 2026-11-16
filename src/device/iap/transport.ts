// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * WebUSB transport for the Logic20 IAP control endpoint (EP0 only).
 *
 * The application firmware also runs from RAM, so an update can be issued while
 * the analyzer is alive; there is no BOOT jumper to enter. Only the dynamic
 * Slot B region is written by 0xE1; Slot A is fixed.
 *
 * `selectConfiguration(1)` is deliberately conditional: issuing SET_CONFIGURATION
 * again after EP1 has been used can wedge this CH32 USB stack. EP0 vendor
 * requests do not need `claimInterface`, so a failure there is not fatal.
 */

import {
  IAP_BLOCK_SIZE,
  IAP_INFO_SIZE,
  IAP_REQ_INFO,
  IAP_REQ_RESET,
  IAP_REQ_WRITE,
} from './constants.js';
import { parseIapInfo, type IapInfo } from './info.js';

export interface IapTransport {
  readonly device: USBDevice;
  /** Current info block, or null when the device has no valid info (still updatable). */
  info(): Promise<IapInfo | null>;
  writeBlock(index: number, block: Uint8Array): Promise<void>;
  reset(delayMs: number): Promise<void>;
  close(): Promise<void>;
}

export class IapTransportError extends Error {
  constructor(readonly stage: 'open' | 'info' | 'write' | 'reset', message: string) {
    super(message);
    this.name = 'IapTransportError';
  }
}

class UsbIapTransport implements IapTransport {
  constructor(readonly device: USBDevice) {}

  async info(): Promise<IapInfo | null> {
    let result: USBInTransferResult;
    try {
      result = await this.device.controlTransferIn({
        requestType: 'vendor',
        recipient: 'device',
        request: IAP_REQ_INFO,
        value: 0,
        index: 0,
      }, IAP_INFO_SIZE);
    } catch (e) {
      throw new IapTransportError('info', messageOf(e));
    }
    if (result.status !== 'ok' || !result.data || result.data.byteLength < IAP_INFO_SIZE) return null;
    const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, IAP_INFO_SIZE).slice();
    const magic = new DataView(bytes.buffer).getUint32(0, true);
    if (magic === 0) return null;
    return parseIapInfo(bytes);
  }

  async writeBlock(index: number, block: Uint8Array): Promise<void> {
    if (block.length !== IAP_BLOCK_SIZE) {
      throw new IapTransportError('write', `write block is ${block.length} bytes, expected ${IAP_BLOCK_SIZE}`);
    }
    let result: USBOutTransferResult;
    try {
      result = await this.device.controlTransferOut({
        requestType: 'vendor',
        recipient: 'device',
        request: IAP_REQ_WRITE,
        value: 0,
        index,
      }, block.slice());
    } catch (e) {
      throw new IapTransportError('write', messageOf(e));
    }
    if (result.status !== 'ok') {
      throw new IapTransportError('write', `USB ${result.status}`);
    }
  }

  async reset(delayMs: number): Promise<void> {
    try {
      await this.device.controlTransferOut({
        requestType: 'vendor',
        recipient: 'device',
        request: IAP_REQ_RESET,
        value: delayMs,
        index: 0,
      });
    } catch {
      // The device is expected to reset before the status stage completes.
    }
  }

  async close(): Promise<void> {
    try { await this.device.releaseInterface(0); } catch { /* never claimed / already gone */ }
    try { await this.device.close(); } catch { /* already gone */ }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Open a device the user has already granted to this origin. */
export async function openIapDevice(device: USBDevice): Promise<IapTransport> {
  try {
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    try { await device.claimInterface(0); } catch { /* EP0 does not need it */ }
  } catch (e) {
    throw new IapTransportError('open', messageOf(e));
  }
  return new UsbIapTransport(device);
}
