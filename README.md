# iRMC Live Viewer

Experimental HTML5 live KVM viewer for Fujitsu iRMC S3 systems that use the old Java Mahogany AVR applet.

This project reverse-engineers enough of the Mahogany stream to display the remote console in a browser, send keyboard events, issue selected power actions, and inspect/debug the video stream. It is not a complete replacement for the Java applet yet.

## Features

- Browser-based live console at `http://127.0.0.1:8090`
- JNLP/session parsing, with optional fresh JNLP fetch using iRMC HTTP digest auth
- Keyboard toolbar and virtual keyboard
- Power controls
- Text mode rendering for BIOS/bootloader screens
- Update rectangle overlay, stats, and replay recording
- Video options/probes for hardware compression, force-8bpp, and BSE low-bandwidth modes
- Diagnostic pcap stream extraction/decoder helpers

## Requirements

- Node.js 18 or newer
- `curl` available on `PATH` if you want the viewer to fetch a fresh JNLP session
- Network access to the iRMC web interface

No browser plugin or Java runtime is required for the HTML viewer.

## Quick Start

Run with a fresh iRMC session fetched from the web UI:

```sh
./irmc-live-viewer
```

The wrapper asks for the iRMC host, web port, username, password, and local viewer port. It can save the non-secret defaults to `~/.config/irmc-live-viewer/config.env` for next time; the password is never saved by the wrapper.

The underscore alias also works:

```sh
./irmc_live_viewer
```

The wrapper starts the local viewer and serves it at:

```text
http://127.0.0.1:8090/
```

You can also point it at an existing JNLP file:

```sh
IRMC_JNLP=/path/to/avr.jnlp node server.js
```

Or run directly:

```sh
IRMC_HOST=<irmc-ip> IRMC_USER=admin IRMC_PASS='your-password' npm start
```

## Configuration

Environment variables:

- `IRMC_HOST`: iRMC host/IP. Required when fetching a fresh JNLP.
- `IRMC_USER`: iRMC username. Defaults to `admin`.
- `IRMC_PASS`: iRMC password. If omitted, the wrapper prompts when `IRMC_HOST` is set.
- `IRMC_SCHEME`: `http` or `https`. Defaults to `http`.
- `IRMC_PORT`: iRMC web port used when fetching a fresh JNLP. Defaults to no explicit port when running `server.js` directly; the wrapper prompts with `80` or `443`.
- `IRMC_VIEWER_PORT`: local viewer port. Defaults to `8090`.
- `IRMC_JNLP`: explicit JNLP path.
- `IRMC_RENDER_EVERY`: render every N decoded frames. Defaults to `1`.
- `IRMC_RECORDING_LIMIT`: replay buffer frame count. Defaults to `240`.
- `IRMC_HARDWARE_COMPRESSION`: set startup hardware-compression flag to `1` or `0`. On tested iRMC S3 firmware this appears enabled by default; toggling it off after it has been on may increase bandwidth demand.
- `IRMC_FORCE_8BPP`: set startup force-8bpp flag when experimental force-8bpp is enabled.
- `IRMC_ALLOW_EXPERIMENTAL_FORCE8`: set to `1` to allow force-8bpp.
- `IRMC_ALLOW_EXPERIMENTAL_BSE`: set to `0` to disable BSE low-bandwidth modes.
- `IRMC_BSE_MODE`: startup BSE mode, `0`, `1`, or `2`.

## Protocol Notes

See [docs/protocol.md](docs/protocol.md) for the current reverse-engineered Mahogany command map, video modes, frame formats, BSE notes, and known unknowns.

## Safety Notes

Do not commit real `avr.jnlp` files, cookies, packet captures, or logs from your environment. They can contain session tokens, network details, or credentials. The `.gitignore` excludes the common local artifacts.

Power actions are sent directly to the iRMC. The UI asks for confirmation before sending them, but treat them as real out-of-band server controls.

## Status

This is an experimental viewer built from live reverse engineering against iRMC S3 firmware. The main HLC path, text mode, and 3bpp/8bpp BSE low-bandwidth paths work on tested firmware. SSP and some less common enhance variants are still under active investigation.
