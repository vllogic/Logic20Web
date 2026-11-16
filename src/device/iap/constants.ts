// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Logic20 in-application programming (IAP) constants.
 *
 * The device exposes a vendor control endpoint while the application runs:
 *
 *   0xE0 IN    InfoGet, index 0, returns the 256-byte `union iap_firmware_info`
 *   0xE1 OUT   FwWrite, index = 256-byte block number, one encrypted block
 *   0xE2 OUT   Reset, value = delay in ms
 *
 * The package is AES-128-CBC (one continuous stream) over
 * `info[256] + code_pad + data_pad`; the device verifies the info CRC on block 0
 * and code/data CRC on the last block, then commits the info block atomically.
 * Source of truth: logic_analyzer `usb3.ch32h417/V3F/User/iap.{h,c}` and
 * `tools/iap_pack.py`. Slot A (boot + this IAP service) is never written.
 */

/** Application USB identity. The product string, not bcdDevice, tells products apart. */
export const IAP_VID = 0x1209;
export const IAP_PID = 0x6688;
export const IAP_PRODUCT = 'Logic20';

/** `IAP_CONST_CHARACTER` for Logic20; USB Sniffer 2 keeps its own 0x20260705. */
export const IAP_MAGIC = 0x20260820;
export const IAP_SNIFFER2_MAGIC = 0x20260705;
/** `IAP_HARDWARE_VERSION` bit 0. A package for another board is rejected. */
export const IAP_HW_MASK = 0x1;

export const IAP_INFO_SIZE = 256;
export const IAP_BLOCK_SIZE = 256;

/** Slot A is fixed at 0x08000000..0x0800A000; these are the dynamic region bounds. */
export const IAP_INFO_ADDR = 0x0800a000;
export const IAP_CODE_ADDR = 0x0800a100;
/** The last 8 KiB holds calibration data and must not be overwritten by an update. */
export const IAP_CAP_END = 0x080ee000;
/** code + data capacity (the info block lives before CODE_ADDR). */
export const IAP_MAX_CODE_DATA = IAP_CAP_END - IAP_CODE_ADDR;
/** info + aligned code + aligned data capacity, as the device checks it on block 0. */
export const IAP_MAX_IMAGE = IAP_CAP_END - IAP_INFO_ADDR;

export const IAP_REQ_INFO = 0xe0;
export const IAP_REQ_WRITE = 0xe1;
export const IAP_REQ_RESET = 0xe2;

/** Firmware data types (`enum iap_firmware_data_type_t`). */
export const IAP_DATA_INVALID = 0;
export const IAP_DATA_H7P20_RAW = 1;
export const IAP_DATA_H7P20_LR4_8K = 2;

/**
 * AES-128 key/IV, the same constants as `iap_pack.py` and the firmware.
 *
 * They are deliberately public in this project: the package is encrypted to keep
 * raw flash images from being read/dropped in by hand, not to authenticate a
 * release. The page uses them only to inspect a package *before* sending it; this
 * is not a trust anchor and must not be described as one.
 */
export const IAP_AES_KEY = hexBytes('2abc65d7e4726e72364cf9272a061aaf');
export const IAP_AES_IV = hexBytes('08050726253e5fab2fc3c726964a6d5d');

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
