#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 vllogic.com
"""Reproduce the Logic20 START-before-drain problem with pyusb.

WebUSB cannot cancel a pending transferIn, so the browser transport has no direct
equivalent of libsigrok's `sync_drain(rx, 32, 5)` before START. This probe measures
what is actually sitting on the IN endpoint when a capture starts, for three
strategies:

  web       - configure without reading IN, then START and read (the browser today)
  drain     - configure, read until the endpoint is idle for `--idle-ms`, then START
  c-driver  - wait for every command ACK, drain 32 x 5 ms like vllogic_usb.c, then START

Each cycle captures for `--duration-ms` and sends STOP without draining, which is the
state the next cycle inherits. It reports, per cycle: bytes/blocks read while draining
before START (ACKs vs stale data blocks), the first block after START, its header, and
the arrival latency. Run it with no browser tab capturing: pyusb claims interface 0.

    python3 src/device/tools/vllogic_drain_probe.py --mode web --cycles 3
    python3 src/device/tools/vllogic_drain_probe.py --mode drain --json /tmp/drain.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field

import usb.core
import usb.util

VID = 0x1209
PID = 0x6688
IFACE = 0
EP_IN = 0x81
EP_OUT = 0x01
HDR = 16
BLK_MAGIC16 = 0x6CC6
PAY_MIN = 120
PAY_MAX = 4092

# Downstream command numbers, see uhsif.h / vllogicProtocol.ts.
CMD_START = 0x01
CMD_STOP = 0x02
CMD_FLUSH = 0x03
CMD_MODE_NORMAL = 0x04
CMD_CHANNEL_MASK = 0x10
CMD_ISERDES_DIV = 0x20
CMD_MAX_PAYLOAD = 0x22
CMD_VBIAS_PWM0 = 0x30
CMD_VBIAS_PWM1 = 0x31
CMD_LUT0 = 0x40

RATES = {
    20_000_000: 120, 40_000_000: 60, 80_000_000: 30, 100_000_000: 24,
    160_000_000: 15, 200_000_000: 12, 400_000_000: 6, 800_000_000: 3,
    1_200_000_000: 2,
}
PERM = [1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10, 13, 12, 15, 14, 16, 17, 18, 19]


def crc16(w1: int, w2: int, w3: int) -> int:
    crc = 0xFFFF
    for word in (w1, w2, w3):
        for i in range(4):
            crc ^= ((word >> (i * 8)) & 0xFF) << 8
            for _ in range(8):
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def command(cmd: int, param: int = 0) -> bytes:
    w0 = (crc16(cmd, param, 0) << 16) | 0xC7F3
    return b''.join(word.to_bytes(4, 'little') for word in (w0, cmd, param, 0))


def build_lut(mask: int) -> list[int]:
    enabled = [ch for ch in range(20) if mask & (1 << ch)]
    nxt = [0] * 32
    if enabled:
        for i in range(len(enabled) - 1):
            nxt[enabled[i]] = enabled[i + 1]
        nxt[enabled[-1]] = enabled[0]
    raw = bytearray(20)
    for entry in range(32):
        value = nxt[entry] & 0x1F
        bit = entry * 5
        byte_idx, bit_off = bit >> 3, bit & 7
        raw[byte_idx] |= (value << bit_off) & 0xFF
        if bit_off > 3 and byte_idx + 1 < 20:
            raw[byte_idx + 1] |= value >> (8 - bit_off)
    return [int.from_bytes(raw[i * 4:i * 4 + 4], 'little') for i in range(5)]


def map_for(channels: int) -> tuple[int, int]:
    mask = 0
    for logical in range(channels):
        mask |= 1 << PERM[logical]
    return mask, channels


def u32(buf: bytes, off: int) -> int:
    return int.from_bytes(buf[off:off + 4], 'little')


@dataclass
class Block:
    kind: str           # 'ack' | 'data' | 'badlen' | 'crc'
    seq: int = 0
    mask: int = 0
    div: int = 0
    mode: int = 0
    capturing: int = 0
    drop: int = 0
    words: int = 0
    bytes: int = 0
    crc_ok: bool = False

    def as_dict(self) -> dict:
        return {
            'kind': self.kind, 'seq': self.seq, 'mask': f'{self.mask:05x}',
            'div': self.div, 'mode': self.mode, 'capturing': self.capturing,
            'drop': self.drop, 'words': self.words, 'bytes': self.bytes,
            'crc': self.crc_ok,
        }


def parse_blocks(buf: bytes) -> list[Block]:
    """Best-effort block walk; enough to classify what the endpoint held."""
    out: list[Block] = []
    off = 0
    while off + HDR <= len(buf):
        if u32(buf, off) & 0xFFFF != BLK_MAGIC16:
            nxt = buf.find(b'\xc6', off + 1)
            if nxt < 0:
                break
            off = nxt
            continue
        w0, w1, w2, w3 = (u32(buf, off + i * 4) for i in range(4))
        plen = (w3 >> 12) & 0xFFF
        blk = Block(
            kind='crc',
            seq=(w3 >> 24) & 0xFF,
            mask=w1 & 0xFFFFF,
            div=(w2 >> 15) & 0x7F,
            mode=(w3 >> 10) & 3,
            capturing=(w2 >> 23) & 1,
            drop=(w2 >> 22) & 1,
            words=plen,
            crc_ok=(w0 >> 16) == crc16(w1, w2, w3),
        )
        if blk.crc_ok:
            if plen == 0:
                blk.kind = 'ack'
            elif plen < PAY_MIN or plen > PAY_MAX:
                blk.kind = 'badlen'
            else:
                blk.kind = 'data'
        size = HDR + plen * 4
        blk.bytes = size
        out.append(blk)
        off += size
    return out


def summarize(blocks: list[Block]) -> dict:
    return {
        'acks': sum(1 for b in blocks if b.kind == 'ack'),
        'data': sum(1 for b in blocks if b.kind == 'data'),
        'bad': sum(1 for b in blocks if b.kind in ('crc', 'badlen')),
        'words': sum(b.words for b in blocks if b.kind == 'data'),
    }


@dataclass
class Cycle:
    index: int
    pre_start_reads: int = 0
    pre_start_bytes: int = 0
    pre_start_blocks: list[Block] = field(default_factory=list)
    first_block: Block | None = None
    first_block_ms: float | None = None
    first_read_bytes: int = 0
    capture_bytes: int = 0
    capture_blocks: list[Block] = field(default_factory=list)
    drain_ms: float = 0.0
    config_ms: float = 0.0
    stop_ms: float = 0.0
    post_stop: list[Block] = field(default_factory=list)
    post_stop_bytes: int = 0
    last_data_seq: int | None = None
    first_data_drop: int | None = None
    last_data_drop: int | None = None
    read_lengths: list[int] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def first_data_seq(self) -> int | None:
        for blk in self.capture_blocks:
            if blk.kind == 'data':
                return blk.seq
        return None

    def as_dict(self) -> dict:
        stale = [b for b in self.pre_start_blocks if b.kind == 'data']
        return {
            'index': self.index,
            'configMs': round(self.config_ms, 2),
            'drainMs': round(self.drain_ms, 2),
            'stopMs': round(self.stop_ms, 2),
            'preStart': {
                'reads': self.pre_start_reads,
                'bytes': self.pre_start_bytes,
                **summarize(self.pre_start_blocks),
                'staleDataSeqs': [b.seq for b in stale],
                'staleCapturing': sorted({b.capturing for b in stale}),
            },
            'first': self.first_block.as_dict() if self.first_block else None,
            'firstMs': None if self.first_block_ms is None else round(self.first_block_ms, 2),
            'firstReadBytes': self.first_read_bytes,
            'lastDataSeq': self.last_data_seq,
            'firstDataSeq': self.first_data_seq(),
            'firstDataDrop': self.first_data_drop,
            'lastDataDrop': self.last_data_drop,
            'capture': {
                'bytes': self.capture_bytes,
                **summarize(self.capture_blocks),
                'seqs': [b.seq for b in self.capture_blocks if b.kind == 'data'][:8],
            },
            'readLengths': {
                'count': len(self.read_lengths),
                'min': min(self.read_lengths) if self.read_lengths else 0,
                'avg': round(sum(self.read_lengths) / len(self.read_lengths))
                if self.read_lengths else 0,
                'max': max(self.read_lengths) if self.read_lengths else 0,
            },
            'postStop': {
                'bytes': self.post_stop_bytes,
                **summarize(self.post_stop),
                'staleCapturing': sorted({b.capturing for b in self.post_stop if b.kind == 'data'}),
            },
            'errors': self.errors,
        }


class Probe:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.dev = usb.core.find(idVendor=VID, idProduct=PID)
        if self.dev is None:
            raise SystemExit('Logic20 not found (1209:6688)')
        try:
            self.dev.set_configuration()
        except usb.core.USBError:
            pass
        try:
            if self.dev.is_kernel_driver_active(IFACE):
                self.dev.detach_kernel_driver(IFACE)
        except (NotImplementedError, usb.core.USBError):
            pass
        usb.util.claim_interface(self.dev, IFACE)
        self.mask, _ = map_for(args.channels)
        self.div = RATES[args.rate]

    def close(self) -> None:
        try:
            self.write_cmd(CMD_STOP)
        except usb.core.USBError:
            pass
        try:
            usb.util.release_interface(self.dev, IFACE)
        except usb.core.USBError:
            pass
        usb.util.dispose_resources(self.dev)

    def write_cmd(self, cmd: int, param: int = 0) -> None:
        self.dev.write(EP_OUT, command(cmd, param), timeout=1000)

    def read(self, timeout_ms: int, size: int = 256 * 1024) -> bytes | None:
        try:
            return bytes(self.dev.read(EP_IN, size, timeout=timeout_ms))
        except usb.core.USBTimeoutError:
            return None
        except usb.core.USBError as exc:
            if 'timed out' in str(exc).lower():
                return None
            raise

    def configure(self, cycle: Cycle, wait_ack: bool) -> None:
        if self.args.tail_read_ms > 0:
            # The WebUSB tail drain: keep consuming after the budget so the board FIFO
            # does not overflow before STOP lands.
            tail_deadline = time.monotonic() + self.args.tail_read_ms / 1000
            while time.monotonic() < tail_deadline:
                buf = self.read(50)
                if buf is None:
                    continue
                cycle.capture_bytes += len(buf)
                blocks = parse_blocks(buf)
                cycle.capture_blocks.extend(blocks)
                for blk in blocks:
                    if blk.kind == 'data':
                        cycle.last_data_drop = blk.drop

        if self.args.tail_stall_ms > 0:
            # Model the end of a WebUSB capture: the host stops reading once its budget
            # is full, but the board keeps sampling until STOP takes effect.
            time.sleep(self.args.tail_stall_ms / 1000)

        t0 = time.monotonic()
        self.write_cmd(CMD_STOP)
        if wait_ack:
            self.wait_ack(cycle)
        self.write_cmd(CMD_FLUSH)
        if wait_ack:
            self.wait_ack(cycle)
        self.write_cmd(CMD_MAX_PAYLOAD, PAY_MAX)
        if wait_ack:
            self.wait_ack(cycle)
        self.write_cmd(CMD_CHANNEL_MASK, self.mask)
        if wait_ack:
            self.wait_ack(cycle)
        for i, word in enumerate(build_lut(self.mask)):
            self.write_cmd(CMD_LUT0 + i, word)
            if wait_ack:
                self.wait_ack(cycle)
        self.write_cmd(CMD_ISERDES_DIV, self.div)
        if wait_ack:
            self.wait_ack(cycle)
        self.write_cmd(CMD_VBIAS_PWM0, 19)
        if wait_ack:
            self.wait_ack(cycle)
        self.write_cmd(CMD_VBIAS_PWM1, 0)
        if wait_ack:
            self.wait_ack(cycle)
        self.write_cmd(CMD_MODE_NORMAL)
        if wait_ack:
            self.wait_ack(cycle)
        time.sleep(0.035)  # PWM settling
        cycle.config_ms = (time.monotonic() - t0) * 1000

    def wait_ack(self, cycle: Cycle) -> None:
        """Wait for one ACK block like sync_wait_ack(), without touching the payload."""
        deadline = time.monotonic() + 0.1
        while time.monotonic() < deadline:
            buf = self.read(20, 4096)
            if buf is None:
                return
            cycle.pre_start_bytes += len(buf)
            blocks = parse_blocks(buf)
            cycle.pre_start_blocks.extend(blocks)
            if any(b.kind == 'ack' for b in blocks):
                return

    def drain_idle(self, cycle: Cycle, idle_ms: int, max_reads: int = 64) -> None:
        """Read until one read times out; every completed read is stale and discarded."""
        t0 = time.monotonic()
        for _ in range(max_reads):
            buf = self.read(idle_ms, 256 * 1024)
            if buf is None:
                break
            if not buf:
                continue
            cycle.pre_start_reads += 1
            cycle.pre_start_bytes += len(buf)
            cycle.pre_start_blocks.extend(parse_blocks(buf))
        cycle.drain_ms = (time.monotonic() - t0) * 1000

    def run_cycle(self, index: int) -> Cycle:
        cycle = Cycle(index=index)
        wait_ack = self.args.mode == 'c-driver'
        self.configure(cycle, wait_ack)

        if self.args.mode == 'c-driver':
            # sync_drain(rx, 32, 5)
            for _ in range(32):
                buf = self.read(5, 4096)
                if buf is None or not buf:
                    break
                cycle.pre_start_reads += 1
                cycle.pre_start_bytes += len(buf)
                cycle.pre_start_blocks.extend(parse_blocks(buf))

        self.write_cmd(CMD_START)
        started = time.monotonic()
        first = self.read(1000)
        cycle.first_block_ms = (time.monotonic() - started) * 1000
        if first is None:
            cycle.errors.append('no block within 1000 ms of START')
        else:
            cycle.first_read_bytes = len(first)
            blocks = parse_blocks(first)
            if blocks:
                cycle.first_block = blocks[0]
                cycle.capture_bytes += len(first)
                cycle.capture_blocks.extend(blocks)
                for blk in blocks:
                    if blk.kind == 'data' and cycle.first_data_drop is None:
                        cycle.first_data_drop = blk.drop

        stall_ms = self.args.stall_ms if index <= self.args.stall_cycles else 0
        if stall_ms > 0:
            # Model the host falling behind (a busy page thread or a stop that leaves
            # the queue full): the endpoint and the device FIFO accumulate blocks.
            time.sleep(stall_ms / 1000)

        deadline = time.monotonic() + self.args.duration_ms / 1000
        while time.monotonic() < deadline:
            buf = self.read(200)
            if buf is None:
                continue
            cycle.read_lengths.append(len(buf))
            cycle.capture_bytes += len(buf)
            blocks = parse_blocks(buf)
            cycle.capture_blocks.extend(blocks)
            for blk in blocks:
                if blk.kind == 'data':
                    if cycle.first_data_drop is None:
                        cycle.first_data_drop = blk.drop
                    cycle.last_data_drop = blk.drop
                    cycle.last_data_seq = blk.seq

        if self.args.tail_read_ms > 0:
            # The WebUSB tail drain: keep consuming after the budget so the board FIFO
            # does not overflow before STOP lands.
            tail_deadline = time.monotonic() + self.args.tail_read_ms / 1000
            while time.monotonic() < tail_deadline:
                buf = self.read(50)
                if buf is None:
                    continue
                cycle.capture_bytes += len(buf)
                blocks = parse_blocks(buf)
                cycle.capture_blocks.extend(blocks)
                for blk in blocks:
                    if blk.kind == 'data':
                        cycle.last_data_drop = blk.drop

        if self.args.tail_stall_ms > 0:
            # Model the end of a WebUSB capture: the host stops reading once its budget
            # is full, but the board keeps sampling until STOP takes effect.
            time.sleep(self.args.tail_stall_ms / 1000)

        t0 = time.monotonic()
        self.write_cmd(CMD_STOP)
        cycle.stop_ms = (time.monotonic() - t0) * 1000
        # Deliberately do not drain: the next cycle inherits whatever remains, which is
        # exactly the state WebUSB cannot clean up before START without a pending read.
        time.sleep(0.02)
        # What STOP left on the wire: <16 bytes means the board stopped promptly.
        while True:
            buf = self.read(10)
            if buf is None or not buf:
                break
            cycle.post_stop_bytes += len(buf)
            cycle.post_stop.extend(parse_blocks(buf))
        return cycle

    def run(self) -> dict:
        cycles = [self.run_cycle(i + 1) for i in range(self.args.cycles)]
        return {
            'mode': self.args.mode,
            'rateHz': self.args.rate,
            'channels': self.args.channels,
            'durationMs': self.args.duration_ms,
            'idleMs': self.args.idle_ms,
            'stallMs': self.args.stall_ms,
            'stallCycles': self.args.stall_cycles,
            'tailStallMs': self.args.tail_stall_ms,
            'tailReadMs': self.args.tail_read_ms,
            'cycles': [c.as_dict() for c in cycles],
        }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--mode', choices=['web', 'drain', 'c-driver'], default='web')
    ap.add_argument('--cycles', type=int, default=3)
    ap.add_argument('--rate', type=int, default=20_000_000)
    ap.add_argument('--channels', type=int, default=4)
    ap.add_argument('--duration-ms', type=int, default=200)
    ap.add_argument('--stall-ms', type=int, default=0,
                    help='stop reading for this long before STOP, building a backlog')
    ap.add_argument('--stall-cycles', type=int, default=9999,
                    help='apply --stall-ms to the first N cycles only (default: all)')
    ap.add_argument('--tail-stall-ms', type=int, default=0,
                    help='stop reading this long before STOP, like a full capture budget')
    ap.add_argument('--tail-read-ms', type=int, default=0,
                    help='keep draining this long before STOP (the WebUSB tail drain)')
    ap.add_argument('--idle-ms', type=int, default=20)
    ap.add_argument('--json', type=str, default='')
    args = ap.parse_args()
    if args.rate not in RATES:
        raise SystemExit(f'rate must be one of {sorted(RATES)}')
    if not 1 <= args.channels <= 20:
        raise SystemExit('channels must be 1..20')

    probe = Probe(args)
    try:
        report = probe.run()
    finally:
        probe.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print(f'\nwrote {args.json}', file=sys.stderr)


if __name__ == '__main__':
    main()
