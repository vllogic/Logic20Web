// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * The IAP update sequence: write every 256-byte block, reset, then *prove* the
 * device is running the package that was sent.
 *
 * The proof is the info block the device commits on its last block: firmware
 * version, code CRC and data CRC must equal the package's. That is stronger than
 * counting ACKed control transfers, and it also covers a reflash of the same
 * version, where a version-only comparison would be blind.
 *
 * Nothing in this file touches the DOM, so the fake transport in iapSelftest can
 * drive the whole flow, including the failure branches.
 */

import { IAP_MAGIC } from './constants.js';
import type { IapInfo } from './info.js';
import type { IapTransport } from './transport.js';

export type IapUpdatePhase = 'writing' | 'resetting' | 'verifying';
export type IapUpdateFailure = 'transfer' | 'reset-unseen' | 'unconfirmed';

export interface IapUpdateOutcome {
  ok: boolean;
  failure?: IapUpdateFailure;
  message?: string;
  /** What the device reported after the reset (when it came back). */
  current?: IapInfo;
  /** The freshly opened transport after the reset, for the page to adopt. */
  next?: IapTransport;
}

export interface IapUpdateHooks {
  onPhase?(phase: IapUpdatePhase): void;
  onProgress?(done: number, total: number): void;
  onLog?(message: string): void;
}

export interface IapUpdateTarget {
  transport: IapTransport;
  expected: IapInfo;
  /** Re-open the device after 0xE2; null when it did not come back in time. */
  rediscover(): Promise<IapTransport | null>;
}

const RETRIES = 2;
const RETRY_DELAY_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function sameImage(a: IapInfo, b: IapInfo): boolean {
  return a.magic === IAP_MAGIC
    && a.firmwareVersion === b.firmwareVersion
    && a.codeLength === b.codeLength
    && a.dataLength === b.dataLength
    && a.dataType === b.dataType
    && a.codeCrc32 === b.codeCrc32
    && a.dataCrc32 === b.dataCrc32;
}

export async function runIapUpdate(
  target: IapUpdateTarget,
  packageBytes: Uint8Array,
  hooks: IapUpdateHooks = {},
): Promise<IapUpdateOutcome> {
  const { transport, expected, rediscover } = target;
  if (packageBytes.length === 0 || packageBytes.length % 256 !== 0) {
    return { ok: false, failure: 'transfer', message: 'package length is not a multiple of 256 bytes' };
  }
  const total = packageBytes.length / 256;
  hooks.onPhase?.('writing');

  for (let i = 0; i < total; i++) {
    const block = packageBytes.subarray(i * 256, (i + 1) * 256);
    const pct = Math.round(((i + 1) / total) * 100);
    let lastError = '';
    let sent = false;
    for (let attempt = 0; attempt <= RETRIES && !sent; attempt++) {
      try {
        await transport.writeBlock(i, block);
        sent = true;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < RETRIES) {
          hooks.onLog?.(`write ${pct}% failed (${lastError}); retrying`);
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
    if (!sent) {
      return {
        ok: false,
        failure: 'transfer',
        message: lastError || 'write failed',
      };
    }
    hooks.onProgress?.(i + 1, total);
    if ((i + 1) % 64 === 0 || i + 1 === total) {
      hooks.onLog?.(`wrote ${pct}%`);
    }
  }

  hooks.onPhase?.('resetting');
  await transport.reset(300);
  await transport.close();

  hooks.onPhase?.('verifying');
  const next = await rediscover();
  if (!next) {
    return {
      ok: false,
      failure: 'reset-unseen',
      message: 'the device did not re-enumerate within 10 s of the reset',
    };
  }

  let current: IapInfo | null = null;
  try {
    current = await next.info();
  } catch (e) {
    return {
      ok: false,
      failure: 'unconfirmed',
      message: e instanceof Error ? e.message : String(e),
      next,
    };
  }
  if (!current) {
    return {
      ok: false,
      failure: 'unconfirmed',
      message: 'the device came back but reports no valid firmware info',
      next,
    };
  }
  if (!current.infoCrcOk || !sameImage(current, expected)) {
    return {
      ok: false,
      failure: 'unconfirmed',
      message: 'the device reports a different version or CRC than the package',
      current,
      next,
    };
  }
  return { ok: true, current, next };
}
