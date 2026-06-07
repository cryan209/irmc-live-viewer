# Fujitsu iRMC S3 Mahogany Protocol Notes

These notes document the parts of the Fujitsu iRMC S3 "Mahogany" AVR/KVM protocol that this project currently understands.

The protocol is reverse engineered from:

- live iRMC S3 sessions
- downloaded `avr.jnlp` launch files
- packet captures
- the Java applet class names and bytecode

This is not an official specification. Treat offsets and field meanings as working notes.

## Transport And Session

The Java applet is launched from a JNLP file. The JNLP provides arguments such as:

- `ipaddress`
- `username`
- `httpdata`
- `VncPort`
- language/session values

The viewer connects directly to `ipaddress:VncPort`, usually TCP port `80`, and then speaks a binary protocol on that socket. The `httpdata` value from the JNLP is effectively session/auth material and must be treated as secret.

The viewer can either:

- parse an existing JNLP file, or
- fetch a fresh JNLP from the iRMC web interface using HTTP digest auth.

## Byte Order

Observed integer fields are little-endian unless noted otherwise.

Common helpers:

- `u8`: unsigned byte
- `u16le`: little-endian unsigned 16-bit
- `u32le`: little-endian unsigned 32-bit
- `i16le`: little-endian signed 16-bit
- `i32le`: little-endian signed 32-bit

## Client Startup

After receiving the server handshake command `0xc8`, the client sends:

| Command | Name | Payload | Notes |
| --- | --- | --- | --- |
| `0xdd` | Client handshake/auth block | structured auth block | Contains username and JNLP `httpdata`; password field is blank in observed applet flow. |
| `0xf7` | `InformBSEMode` | `u32le mode` | `0` none, `1` 3bpp BSE, `2` 8bpp BSE. |
| `0xf3` | `InformHLevelCompression` | `u8 enabled` | Java UI calls this "Hardware Compression". On tested firmware it appears enabled by default. `1` selects HLC enhance frames; `0` selects raw enhance frames. |
| `0xf6` | `InformForce8BPPMode` | `u8 enabled` | Java exposes a reduce-bandwidth/force-8bpp concept; observed to stop the stream on tested firmware. |
| `0xd3` | `RequestPrimaryControl` | `u8 0` | Requests primary console control. |
| `0xf2` | `Invalidate` | region list | Requests repaint. This project sends a large full-screen region on startup. |

This project intentionally avoids sending `0xf1` (`RequestVesaMode`) in the current startup path. In live testing, sending it caused spurious/double video mode resets on one iRMC S3.

## Client Commands

### `0xd1` Keyboard State

Payload:

| Offset | Type | Meaning |
| --- | --- | --- |
| `0` | `u16le` | USB HID key code |
| `2` | `u8` | `1` key down, `0` key up |
| `3` | `u8` | reserved/zero |

The viewer sends key combinations by sending key-down events in order, then key-up events in reverse order.

### Mouse Input

Mouse command IDs and payloads were confirmed from the Java applet classes:

| Command | Java class | Payload | Notes |
| --- | --- | --- | --- |
| `0xb1` | `ClientAbsoluteMode` | `u8 enabled` | The viewer sends `1` before absolute mouse input. |
| `0xb2` | `ClientRelativeMode` | `u8 flags` | Bit `0` is relative mode, bit `4` is hide mouse. The viewer sends `0` for absolute mode with no hide. |
| `0xb3` | `ButtonStateAtAbsolute` | `i32le x`, `i32le y`, `u8 count`, button states | Absolute button/wheel state at framebuffer coordinates. Java passes short-sized coordinate values, but `ButtonStateAtAbsolute.writeBuffer()` writes them with `BufferMgr.write(int)`, so the wire fields are 32-bit. |
| `0xb4` | `ButtonStateAtRelative` | `i32le dx`, `i32le dy`, `u8 count`, button states | Relative button/wheel state; not used by the viewer yet. |
| `0xb5` | `MouseMove` | `i32le x`, `i32le y` | Absolute or relative depending on active mouse mode. Java's `MouseMove.writeBuffer()` uses `BufferMgr.write(int)`, so the command is 9 bytes total. |

The applet sends three button states in left, right, middle order. Each button state is one byte:

```text
0x80 = not pressed, wheel centered
0x81 = pressed, wheel centered
```

For wheel events, the third button state uses `((64 + wheelRotation) << 1) | middlePressed`. Browser wheel deltas are currently normalized to `-1` or `1`.

Mouse input is experimental in this viewer. On tested firmware, high-rate absolute move packets can cause video updates to stop, so browser mouse input is disabled by default and coalesced/throttled when enabled.

The applet default settings are `mouse.mode=1` (absolute) and `synch.mouse.mode.chg=1`, so it sends `ClientAbsoluteMode(true)` and `ClientRelativeMode(false, hide=false)` when entering absolute mouse mode.

### `0xd3` Request Primary Control

Payload currently sent as one zero byte.

### `0xd8` Disconnect

Payload currently sent as `u32le 1` before closing the socket.

### `0xef` Sequence Ack

Payload:

| Offset | Type | Meaning |
| --- | --- | --- |
| `0` | `3 bytes` | reserved bytes, usually echoed/preserved when available |
| `3` | `u32le` | sequence number |

The server sends `0xef` sequence messages and BSE/SSP frame messages with sequence numbers. The client replies with `0xef`.

### `0xf2` Invalidate

Payload:

| Offset | Type | Meaning |
| --- | --- | --- |
| `0` | `u16le` | number of regions |
| `2` | repeated `u16le` | left, top, right, bottom |

The viewer uses `0xf2` to request a fresh repaint after startup or video option changes.

### `0xf3` Inform H-Level Compression

Payload: `u8 enabled`.

Applet/resource naming maps this to "Hardware Compression". On tested firmware the stream appears to start in the same state as `enabled=1`.

Observed mapping:

| Value | Effective stream | Observed `0xe3` blt type | Notes |
| --- | --- | --- | --- |
| `1` | HLC compressed enhance | `-32270` / `498` | Default on tested firmware. Small cursor/update frames can be under 1 KiB. |
| `0` | raw enhance | `-32272` / `496` | Greatly increases bandwidth; full-screen repaint frames around 1-2 MiB were observed at 1024x768x32. |

Treat this as an encoder-path selector, not a generic hardware feature toggle. The viewer labels it as HLC compression and asks for confirmation before switching to raw enhance from the browser UI.

### `0xf6` Inform Force 8bpp

Payload: `u8 enabled`.

The Java applet has a force-8bpp/reduce-bandwidth setting, but live behavior was inconsistent during testing. `0xf6 01` has been observed to stop the stream on tested firmware, including while BSE modes are active.

Use `0xf7 01` for 3bpp BSE and `0xf7 02` for 8bpp BSE. Treat `0xf6` as an experimental applet compatibility flag, not the normal low-bandwidth selector.

### `0xf7` Inform BSE Mode

Payload: `u32le mode`.

| Mode | Meaning | Observed effect |
| --- | --- | --- |
| `0` | None | Normal Enhance/HLC stream. |
| `1` | 3bpp BSE | Working BSE low-bandwidth mode on tested firmware. |
| `2` | 8bpp BSE | Working BSE low-bandwidth mode on tested firmware. |

The UI exposes probe buttons that temporarily switch to BSE modes, measure the stream, and restore the previous mode.

## Server Commands

Known command IDs:

| Command | Name | Support | Notes |
| --- | --- | --- | --- |
| `0x40` | `OemLocalMonitorState` | skipped | Payload currently skipped. |
| `0x89` | `StorageStatus` | skipped | Fixed-length status block. |
| `0xc5` | `MultiUserState` | parsed | Includes power/status flags and user info lengths. |
| `0xc6` | `ServerDisconnect` | skipped | Observed as short message. |
| `0xc7` | `OemCurrentLocalMonitorState` | skipped | Payload currently skipped. |
| `0xc8` | `ServerHandshake` | parsed | Triggers client auth block. |
| `0xc9` | `FirmwareVersion` | parsed | `u32le length` followed by string. |
| `0xd5` | `InformKeyIndicators` | skipped | 3-byte payload. |
| `0xde` | `OemMsg` | skipped | Length-prefixed OEM message. |
| `0xe0` | `LowBandwidthSSPBitBlt` | skipped/acked | Envelope parsed; image codec not decoded yet. |
| `0xe1` | `InformVesaMode` | parsed | Video mode width/height/bpp. |
| `0xe2` | `BitBlt` | parsed/rendered | Raw 8bpp and text mode variants. |
| `0xe3` | `EnhanceBitBlt` | parsed/rendered partly | Main graphical update path. |
| `0xe4` | `StandbyPower` | skipped | Fixed payload. |
| `0xe5` | `InformCPUUtilization` | skipped | Six `u32le` counters/timestamps. |
| `0xe6` | `SetPalette` | parsed | Updates 8bpp palette. |
| `0xe7` | `BSEBitBlt` | parsed/rendered | 3bpp and 8bpp BSE work on tested firmware. |
| `0xea` | `SetTextCursor` | parsed/rendered | Text cursor position and scan lines. |
| `0xeb` | `SpecialGraphicsBit` | skipped | 4-byte payload. |
| `0xec` | `MatroxGraphicsCursor` | skipped | Fixed cursor block. |
| `0xed` | `SSPBitBlt` | skipped/acked | Envelope parsed; image codec not decoded yet. |
| `0xee` | `GraphicsRegisterValue` | unknown/skipped in helper | Not fully handled by live viewer. |
| `0xef` | `SequenceNumber` | parsed/acked | Server sequence ping. |
| `0xf8` | `NativeMessage` | skipped | Length-prefixed native message. |

## Video Mode: `0xe1 InformVesaMode`

Payload currently parsed as:

| Offset | Type | Meaning |
| --- | --- | --- |
| `0` | `u16le` | mode or reserved |
| `2` | `u16le` | width |
| `4` | `u16le` | height |
| `6` | `u16le` | bpp |

Observed examples:

- `1024x768 32bpp`
- `800x600 32bpp`
- `640x400 0bpp` text mode
- `640x400 8bpp`

When `bpp === 0`, the viewer treats the stream as text mode and renders from text cells, attributes, supplied font data, and cursor messages.

## Palette: `0xe6 SetPalette`

Parsed as:

| Field | Type | Notes |
| --- | --- | --- |
| attribute count | `u16le` | followed by `count * 2` bytes currently skipped |
| palette count | `u16le` | number of palette entries |
| entries | repeated 4 bytes | `index`, `red`, `green`, `blue` |

The palette is used for 8bpp graphical frames.

## BitBlt: `0xe2`

Envelope:

| Field | Type | Meaning |
| --- | --- | --- |
| blt type | `i16le` | signed when high bit set |
| font height | `u8` | used by text modes |
| font width | `u8` | used by text modes |
| source rect | 4 x `i16le` | x, y, width, height |
| dest rect | 4 x `i16le` | x, y, width, height |
| data size | `u32le` | bytes following |
| data | bytes | format depends on blt type |

Known `BitBlt` types from the Java applet:

| Type | Meaning | Viewer support |
| --- | --- | --- |
| `256` | raw graphical BitBlt | 8bpp raw supported |
| `257`-`264` | text mode updates | supported |
| `499` | special 4bpp mode | not fully decoded |

### Text Mode

Text mode types are interpreted as bitfields, except type `264`:

- bit `1`: ASCII cell bytes present
- bit `2`: attribute bytes present
- bit `4`: font data present
- `264`: combined ASCII+attribute pairs

The viewer keeps an in-memory text grid with:

- ASCII cell buffer
- attribute cell buffer
- font bitmap buffer
- cursor position and scan lines from `0xea`

It renders CP437-style fallback glyphs if the server has not supplied a useful glyph.

## EnhanceBitBlt: `0xe3`

Envelope:

| Field | Type | Meaning |
| --- | --- | --- |
| blt type | `i16le` | signed if high bit set |
| tile width | `u8` | usually a power of two |
| tile height | `u8` | usually a power of two |
| triplet code | `u32le`, low byte used | RLE escape code |
| repeat code | `u32le`, low byte used | RLE escape code |
| raw size | `u32le` | uncompressed size |
| scrunch size | `u32le` | compressed payload size |
| snoop map | `64 * 2 * i32le` | low/high tile activation maps per tile row |
| data | `scrunch size` bytes | codec-specific payload |

The snoop map identifies active tiles. For each row, tiles `0..31` are in `snoopLow[row]`; tiles `32..63` are in `snoopHigh[row]`.

Known enhance blt types from the Java applet:

| Signed | Unsigned-ish | Java method | Viewer support |
| --- | --- | --- | --- |
| `-32272` | `496` | `enhanceBitBlt` | raw enhance supported |
| `-32270` | `498` | `enhanceBitBltHLC` | supported |
| `-32269` | `499` | `enhanceBitBlt4bpp` | not fully decoded |
| `-32267` | `501` | `enhanceBitBltForce8bppHLC` | not fully decoded |

### Enhance Raw

The raw enhance path copies pixel bytes for active tiles.

This path is selected by `0xf3 00` on tested firmware. It can emit very large full-screen updates. Example observed frame lengths after switching from HLC to raw enhance at 1024x768x32:

```text
0xe3 -32272 raw enhance, len 2097685
0xe3 496 raw enhance, len 1049109
```

For `bpp > 8`, pixels are observed as BGR byte order:

```text
blue, green, red
```

For `bpp <= 8`, each byte is a palette index.

### Enhance HLC

HLC uses the same active tile map but compresses color planes with an RLE byte reader.

This path is selected by `0xf3 01` and appears to be the default on tested firmware.

For `bpp > 8`, payload starts with channel sizes:

| Offset | Type | Meaning |
| --- | --- | --- |
| `0` | `u32le` | blue stream length |
| `4` | `u32le` | green stream length |
| `8` | `u32le` | reserved/unused in current decoder |
| `12` | bytes | blue stream |
| `12 + blueLen` | bytes | green stream |
| `12 + blueLen + greenLen` | bytes | red stream if `bpp > 16` |

Each plane is read independently using the RLE reader below. The decoded bytes become B, G, and R.

For `bpp <= 8`, a single RLE stream yields palette indexes.

### Enhance RLE

The applet-style RLE reader uses two escape bytes:

- `tripletCode`: next byte repeats three times
- `repeatCode`: next byte is a count marker

Current behavior:

```text
if byte == tripletCode:
  remaining = 3
  value = next byte
else if byte == repeatCode:
  count = next byte
  if count == 1:
    remaining = 1
    value = tripletCode
  else if count == 0:
    remaining = 1
    value = repeatCode
  else:
    remaining = count + 1
    value = next byte
else:
  remaining = 1
  value = byte
```

Each call returns `value` and decrements `remaining`.

## BSEBitBlt: `0xe7`

Envelope:

| Field | Type | Meaning |
| --- | --- | --- |
| blt type | `u32le` | `3`, `8`, `16`, etc. |
| compressed length | `u32le` | bytes following |
| uncompressed length | `u32le` | expected expanded byte count |
| top | `u8` | tile row |
| left | `u8` | tile column |
| bottom | `u8` | tile row |
| right | `u8` | tile column |
| sequence | `u32le` | ack with `0xef` |
| data | bytes | BSE payload |

The Java applet constants identify:

| blt type | Meaning | Viewer support |
| --- | --- | --- |
| `0` | no BSE | not used as an image mode |
| `3` | 3bpp BSE | supported on tested firmware |
| `8` | 8bpp BSE | supported on tested firmware |
| `16` | 16bpp BSE | not decoded |
| `18` | true 8bpp | not decoded |

BSE coordinates are 32-pixel tiles:

```text
x0 = left << 5
y0 = top << 5
x1 = (right + 1) << 5
y1 = (bottom + 1) << 5
```

### BSE RLE

BSE uses a fixed escape scheme:

- `0x55`: next byte repeats three times
- `0xaa`: repeat escape

Behavior:

```text
if byte == 0x55:
  remaining = 3
  value = next byte
else if byte == 0xaa:
  count = next byte
  if count == 1:
    remaining = 1
    value = 0x55
  else if count == 0:
    remaining = 1
    value = 0xaa
  else:
    remaining = count + 1
    value = next byte
else:
  remaining = 1
  value = byte
```

### 3bpp BSE

The Java applet maps the three bitplanes into 24-bit color using shifts:

```text
[7, 15, 23]
```

The viewer decodes these bitplanes and applies "intense" color expansion when mask bits are fully set. This mode works on tested iRMC S3 firmware.

### 8bpp BSE

The Java applet maps eight bitplanes into 24-bit color using shifts:

```text
[6, 7, 12, 13, 14, 15, 22, 23]
```

The viewer decodes this mode and it works on tested iRMC S3 firmware.

## SSP Low-Bandwidth Frames: `0xe0` and `0xed`

Envelope:

| Field | Type | Meaning |
| --- | --- | --- |
| compressed length | `u32le` | bytes following |
| uncompressed length | `u32le` | expected expanded byte count |
| top | `u8` | tile row or block top |
| left | `u8` | tile column or block left |
| bottom | `u8` | tile row or block bottom |
| right | `u8` | tile column or block right |
| sequence | `u32le` | ack with `0xef` |
| data | bytes | not decoded yet |

The viewer currently parses and ACKs these frames but does not render them. They are counted as unsupported BSE/SSP frames.

## MultiUser / Power State: `0xc5`

This message contains a flags field and variable-length user names. The viewer currently extracts:

| Flag | Meaning in viewer |
| --- | --- |
| `0x10000000` | power control enabled |
| `0x08000000` | power on |
| `0x04000000` | agent connected |

These flags were inferred from live behavior and Java applet UI state.

## Power Control: Client `0x41`

The viewer sends single-byte OEM power actions:

| Action | Value |
| --- | --- |
| off | `0` |
| on | `1` |
| cycle | `2` |
| reset | `3` |
| nmi | `4` |
| shutdown | `5` |
| button | `14` |
| reboot | `15` |

These are real out-of-band server controls.

## Debugging Fields

The viewer exposes several protocol/debug counters in the UI:

- `encoding`: last rendered or unsupported encoding path
- `enhance types`: counts of completed `0xe3` enhance frame types
- `pending`: command currently waiting for more bytes
- `rx buffered`: bytes buffered for the pending command
- `bse skipped`: unsupported BSE/SSP frames
- `updates`: update rectangles generated by last decoded frame
- `recording`: replay buffer size

## Known Unknowns

Still incomplete:

- `0xe0 LowBandwidthSSPBitBlt` image codec
- `0xed SSPBitBlt` image codec
- `0xe3` 4bpp enhance mode (`-32269`/`499`)
- `0xe3` force-8bpp HLC mode (`-32267`/`501`)
- exact semantics of several OEM/storage/native messages
- exact behavior differences between firmware versions

## Operational Notes

- JNLP files and `httpdata` expire and are sensitive.
- Packet captures can contain auth/session material.
- `0xf3 00` is a valid raw-enhance mode switch, but it can produce very large frames and should be used deliberately.
- 3bpp and 8bpp BSE low-bandwidth modes are implemented, but SSP low-bandwidth frames can still put the stream into formats this viewer does not render yet.
- If the stream appears frozen, check `pending`, `rx buffered`, and `enhance types` before assuming the iRMC stopped sending data.
