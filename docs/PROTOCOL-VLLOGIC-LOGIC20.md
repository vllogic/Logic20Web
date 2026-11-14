<!-- Copyright (C) 2026 vllogic.com -->

# VLLogic Logic20 - UHSIF v2.2

The Logic20 is a 20-lane USB 3.0 logic analyzer streamed by the `vllogic-logic`
libsigrok driver. The web transport lives in `src/device/vllogic.ts`; the wire
format and the channel map live in `src/device/vllogicProtocol.ts`. This note
records the facts the browser implementation depends on.

## Identity and USB

| Field | Value |
| --- | --- |
| VID:PID | `0x1209:0x6688` |
| Product string | `Logic20` |
| bcdDevice | `0x0802` (some firmware variants report `0x0820`; the older `0x0602` Sniffer2 is not compatible) |
| Interface | 0 (vendor-specific, class `0xFF`); interface 1 is DLDO and must not be claimed |
| Bulk OUT | endpoint number 1 (address `0x01`) |
| Bulk IN | endpoint number 1 (address `0x81`) |
| Link | SuperSpeed 5 Gbit/s; the driver admits 400 MB/s of sustained payload |

Windows uses the firmware's MS OS 2.0/WinUSB-compatible descriptor, so no driver
install is required. On Linux the app offers the usual udev rule.

## Downstream command frame

Every command is a 16-byte bulk OUT frame, four little-endian `u32`:

```
W0 = crc16(W1, W2, W3) << 16 | 0xC7F3
W1 = command
W2 = parameter
W3 = 0
```

CRC is CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`, MSB first, no
reflection, no final XOR) over the 12 on-wire bytes of W1..W3.

Commands used at capture start:

| Command | Value | Parameter |
| --- | --- | --- |
| `STOP` | `0x02` | 0 |
| `FLUSH` | `0x03` | 0 |
| `MAX_PAYLOAD` | `0x22` | `4092` |
| `CHANNEL_MASK` | `0x10` | 20-bit physical-lane mask |
| `LUT0..LUT4` | `0x40..0x44` | five words holding the 32-entry 5-bit next-lane ring |
| `ISERDES_DIV` | `0x20` | divider (rate = 2.4 GHz / div) |
| `VBIAS_PWM0` | `0x30` | comparator PWM, positive branch |
| `VBIAS_PWM1` | `0x31` | comparator PWM, negative branch |
| `MODE_NORMAL` | `0x04` | 0 |
| `START` | `0x01` | 0 |

The device acknowledges commands with a block whose payload length is zero. The
web transport does not block on each acknowledgement: the ACKs sit at the head
of the IN stream and the block parser skips them.

## Logical to physical channels

The connector permutation is fixed:

```
logical 0..15 -> physical 1,0,3,2,5,4,7,6,9,8,11,10,13,12,15,14
logical 16..19 -> physical 16,17,18,19
```

`CHANNEL_MASK` is the OR of the physical lanes for the enabled logical channels.
The LUT is an ascending ring over those lanes; the FPGA resets it to zeroes, so
a non-ascending ring would repeat lane 0.

## Upstream block and payload

```
16-byte header (four little-endian u32)
  W0 = crc16(W1,W2,W3) << 16 | 0x6CC6
  W1 = physical channel mask
  W2 = pwm1 | div << 15 | drop << 22 | capturing << 23 | lut_check << 24
  W3 = pwm0 | vco << 8 | mode << 10 | payload_len << 12 | seq << 24
payload_len 32-bit payload words
```

`payload_len` counts 32-bit payload words and is in `[120, 4092]`; it does not have
to be a multiple of four. The payload is
**channel-major**: one `u32` per enabled physical lane, in ascending physical
lane order. Each word holds 32 consecutive samples of that lane, bit 0 first.
One complete snapshot is `nchan` words, i.e. 32 sample instants. A payload does
not have to contain a whole number of snapshots; the parser carries the
remaining words across block/transfer boundaries.

This is why the web app does not transpose samples: `PlanarSampleStore`
(`src/data/planarStore.ts`) is already channel-major and bit-packed. The
transport calls `beginFrame()`, writes each word with `appendChannel()`, and
publishes the snapshot with `commitSamples(32)`. A query between channel writes
still sees the previous complete frame.

## Starting a capture and the IN endpoint

Measured 2026-11-14 with `src/device/tools/vllogic_drain_probe.py` (pyusb, firmware
bcdDevice `0x0820`, 20 MHz x 4 CH) because WebUSB cannot reproduce the native
`sync_drain()`:

- Commands acknowledge with a 16-byte block (`payload_len = 0`). If the host does not
  read IN while configuring, the ACKs do not accumulate without bound: after START the
  capture sees roughly 9 of them, and the parser skips every one.
- `STOP` + `FLUSH` stop the stream. With the host deliberately stalled for 1.5 s
  (device FIFO overflow, `drop` latched), the endpoint still held no stale data blocks
  after the next `STOP`; only the final ACK arrived. A capture therefore never starts
  with a previous capture's payload.
- At high bandwidth a *stopped* capture still has a tail in flight. 16 lanes at
  160 MHz with a host that cannot keep up (single-threaded pyusb) left 8 data blocks
  (~128 KiB, `capturing = 1`) to read after STOP. That is the current capture's tail,
  not a stale one: the WebUSB read loop keeps consuming it during the 750 ms settle
  window, and `captureEpoch` keeps an older loop from writing into a newer capture.
- The first block after START is the START ACK, not data. The transport's first-block
  check waits for the first *data* block (`lastHeader` is only updated by payload
  blocks), so an ACK cannot trip `device.headerMismatch`.

WebUSB has no cancellable `transferIn`, so two things replace the native drain:

- `stop()` resolves the read loop's completion wait directly (`wakeLoop`); a board that
  stops sending cannot park the loop for the rest of the page session. Outstanding
  reads still get the 750 ms settle window, because they cannot be cancelled.
- A pre-START drain (`?vllogic-drain=<ms>`, default `20`) races one `transferIn`
  against an idle window. Data completing inside the window is stale and discarded;
  the read that outlives it becomes the capture's sequence-0 read, so no reader is
  left behind. The browser bench found a real reason to keep it on: after a stopped
  16 CH / 160 MHz capture the endpoint still holds the ~128 KiB tail (see above), and
  the next START would otherwise consume it as the new capture's first samples. The
  drain clears it in 1-9 reads. `?vllogic-drain=0` disables it.

A capture with no data block within 1000 ms of START fails with `device.noData`
(`?vllogic-firstblock=<ms>` overrides it, 20..60000). This is the wedged-board state:
commands are acknowledged, the bulk endpoint stays silent, and the page would
otherwise show "Capturing" forever.

## Rates and channel ceilings

The ISERDES clock is 2.4 GHz. The browser table is:

| Rate | Divider |
| --- | --- |
| 20 MHz | 120 |
| 40 MHz | 60 |
| 80 MHz | 30 |
| 100 MHz | 24 |
| 160 MHz | 15 |
| 200 MHz | 12 |
| 400 MHz | 6 |
| 800 MHz | 3 |
| 1200 MHz | 2 |

The FPGA silently drops snapshots above its channel/rate envelope, so the
profile refuses these combinations:

| Output rate | Maximum lanes |
| --- | --- |
| > 800 MHz | 2 |
| > 400 MHz | 4 |
| > 200 MHz | 8 |
| > 160 MHz | 16 |
| <= 160 MHz | 20 |

At 5 Gbit/s the sustained 400 MB/s ceiling makes 20 lanes at 160 MHz the top
20-lane rate; 16 lanes reach 200 MHz, 8 reach 400 MHz and 4 reach 800 MHz. The
default 20-lane recommendation is 100 MHz (250 MB/s), leaving headroom while the
transport still runs on the page thread.

## Comparator threshold

The measured model (calibrated 2026-10) is:

```
Vth = 2.405 - 0.0402 * pwm0 + 0.0216 * pwm1   [V]
```

`vllogicThresholdToPwm()` inverts it, including the sign/feasibility fallback.
Endpoints: `-2.5 V` -> `pwm0 = 122`, `1.65 V` -> `pwm0 = 19`, `+5.0 V` ->
`pwm1 = 120`.

## References

- libsigrok driver: `libsigrok/src/hardware/vllogic-logic/`
  (`protocol.c`, `uhsif_rx.c`, `vllogic_usb.c`)
- Firmware/RTL reference: `la_recv.c` in the h7p20 logic analyzer tree
- Parser and protocol self-test: `src/device/vllogicSelftest.ts`
