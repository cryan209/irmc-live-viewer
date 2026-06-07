#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const HOST = process.env.IRMC_HOST || "";
const USER = process.env.IRMC_USER || "admin";
const PASS = process.env.IRMC_PASS || "";
const SCHEME = process.env.IRMC_SCHEME || "http";
const IRMC_PORT = process.env.IRMC_PORT || "";
const PORT = Number(process.env.IRMC_VIEWER_PORT || 8090);
const LANG = process.env.IRMC_LANG || "0";
const MS = process.env.IRMC_MS || "0";
const RENDER_EVERY = Math.max(1, Number(process.env.IRMC_RENDER_EVERY || 1));
const ALLOW_EXPERIMENTAL_FORCE8 = process.env.IRMC_ALLOW_EXPERIMENTAL_FORCE8 === "1";
const START_FORCE_8BPP = ALLOW_EXPERIMENTAL_FORCE8 && process.env.IRMC_FORCE_8BPP === "1";
const START_HARDWARE_COMPRESSION = process.env.IRMC_HARDWARE_COMPRESSION === "1" ? true : process.env.IRMC_HARDWARE_COMPRESSION === "0" ? false : null;
const ALLOW_EXPERIMENTAL_BSE = process.env.IRMC_ALLOW_EXPERIMENTAL_BSE !== "0";
const START_BSE_MODE = ALLOW_EXPERIMENTAL_BSE ? Math.max(0, Math.min(2, Number(process.env.IRMC_BSE_MODE || 0))) : 0;
const ALLOW_RAW_ENHANCE_BY_DEFAULT = process.env.IRMC_ALLOW_RAW_ENHANCE_BY_DEFAULT === "1";
const ENABLE_MOUSE_BY_DEFAULT = process.env.IRMC_ENABLE_MOUSE === "1";
const DEBUG_PACKETS = process.env.IRMC_DEBUG_PACKETS === "1";
const DEBUG_RAW_PACKETS = process.env.IRMC_DEBUG_RAW === "1";
const DEBUG_PACKET_SECRETS = process.env.IRMC_DEBUG_PACKET_SECRETS === "1";
const DEBUG_PACKET_BYTES = Math.max(0, Number(process.env.IRMC_DEBUG_PACKET_BYTES || 96));
const DEBUG_PACKET_FILE = process.env.IRMC_DEBUG_PACKET_FILE || "";
const DEBUG_PACKET_STREAM = DEBUG_PACKET_FILE ? fs.createWriteStream(DEBUG_PACKET_FILE, { flags: "a" }) : null;

const COMMAND_NAMES = {
  0x00: "Padding",
  0x40: "OemLocalMonitorState",
  0x41: "PowerControl",
  0x89: "StorageStatus",
  0xb1: "ClientAbsoluteMode",
  0xb2: "ClientRelativeMode",
  0xb3: "ButtonStateAtAbsolute",
  0xb4: "ButtonStateAtRelative",
  0xb5: "MouseMove",
  0xc5: "MultiUserState",
  0xc6: "ServerDisconnect",
  0xc7: "OemCurrentLocalMonitorState",
  0xc8: "ServerHandshake",
  0xc9: "FirmwareVersion",
  0xd1: "KeyboardState",
  0xd2: "UnknownClientD2",
  0xd3: "RequestPrimaryControl",
  0xd5: "InformKeyIndicators",
  0xd8: "Disconnect",
  0xdd: "ClientHandshake",
  0xde: "OemMsg",
  0xe0: "LowBandwidthSSPBitBlt",
  0xe1: "InformVesaMode",
  0xe2: "BitBlt",
  0xe3: "EnhanceBitBlt",
  0xe4: "StandbyPower",
  0xe5: "InformCPUUtilization",
  0xe6: "SetPalette",
  0xe7: "BSEBitBlt",
  0xea: "SetTextCursor",
  0xeb: "SpecialGraphicsBit",
  0xec: "MatroxGraphicsCursor",
  0xed: "SSPBitBlt",
  0xef: "SequenceAckOrNumber",
  0xf2: "Invalidate",
  0xf3: "InformHLevelCompression",
  0xf6: "InformForce8BPPMode",
  0xf7: "InformBSEMode",
  0xf8: "NativeMessage",
};

let state = {
  status: "starting",
  detail: "",
  width: 0,
  height: 0,
  bpp: 32,
  frames: 0,
  commands: {},
  connectedAt: null,
  jnlp: null,
  powerControlEnabled: null,
  powerOn: null,
  agentConnected: null,
  multiUserFlags: null,
  bytesIn: 0,
  stats: {
    bitrateKbps: 0,
    fps: 0,
    lastEncoding: "",
    lastEncodedBytes: 0,
    lastUpdates: 0,
    lastDecodeMs: 0,
    lastPngMs: 0,
    lastPngBytes: 0,
    frameIntervalMs: 0,
    recordingFrames: 0,
    enhanceTypes: {},
    rxBuffered: 0,
    pendingCommand: "",
  },
  updateRects: [],
  videoSettings: {
    hardwareCompression: START_HARDWARE_COMPRESSION,
    force8bpp: START_FORCE_8BPP,
    bseMode: START_BSE_MODE,
    unsupportedBseFrames: 0,
    probes: [],
  },
  observedStream: {
    mode: "unknown",
    compression: "unknown",
    bseMode: null,
    force8bpp: null,
    bpp: null,
    command: null,
    enhanceType: null,
    updatedAt: null,
  },
  mouseEnabled: ENABLE_MOUSE_BY_DEFAULT,
};

let socket = null;
let rx = Buffer.alloc(0);
let framebuffer = null;
let latestPng = null;
let latestPngRev = 0;
let handshakeSent = false;
let currentArgs = null;
let palette = Array.from({ length: 256 }, (_, i) => [i, i, i]);
let textMode = null;
let byteSamples = [];
let frameTimes = [];
let recording = [];
const RECORDING_LIMIT = Number(process.env.IRMC_RECORDING_LIMIT || 240);

const textPalette = [
  [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170],
  [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
  [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255],
  [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255],
];

function setStatus(status, detail = "") {
  state.status = status;
  state.detail = detail;
  console.log(`[${new Date().toISOString()}] ${status}${detail ? `: ${detail}` : ""}`);
}

function commandName(cmd) {
  return COMMAND_NAMES[cmd] || "Unknown";
}

function hexPreview(buf) {
  const n = Math.min(buf.length, DEBUG_PACKET_BYTES);
  const suffix = buf.length > n ? ` ...(+${buf.length - n} bytes)` : "";
  return `${buf.subarray(0, n).toString("hex")}${suffix}`;
}

function writeDebugPacket(line) {
  const out = `[${new Date().toISOString()}] ${line}`;
  console.error(out);
  if (DEBUG_PACKET_STREAM) DEBUG_PACKET_STREAM.write(`${out}\n`);
}

function logPacket(direction, buf, detail = "") {
  if (!DEBUG_PACKETS) return;
  const cmd = buf.length ? buf[0] : null;
  const cmdText = cmd === null ? "--" : `0x${cmd.toString(16).padStart(2, "0")} ${commandName(cmd)}`;
  const redacted = !DEBUG_PACKET_SECRETS && direction === "tx" && cmd === 0xdd;
  const hex = redacted ? "<redacted client handshake; set IRMC_DEBUG_PACKET_SECRETS=1 to include>" : hexPreview(buf);
  writeDebugPacket(`${direction} ${cmdText} len=${buf.length}${detail ? ` ${detail}` : ""} hex=${hex}`);
}

function logRawPacket(direction, buf) {
  if (!DEBUG_RAW_PACKETS) return;
  writeDebugPacket(`${direction}-raw len=${buf.length} hex=${hexPreview(buf)}`);
}

function le16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function i16(n) {
  const b = Buffer.alloc(2);
  b.writeInt16LE(Math.max(-32768, Math.min(32767, Number(n) || 0)), 0);
  return b;
}

function i32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Number(n) || 0)), 0);
  return b;
}

function le32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function latin1(s) {
  return Buffer.from(s || "", "latin1");
}

function latin1Padded(s, len) {
  const out = Buffer.alloc(len);
  latin1(s).copy(out, 0, 0, len);
  return out;
}

function send(buf) {
  if (socket && !socket.destroyed) {
    logPacket("tx", buf);
    logRawPacket("tx", buf);
    socket.write(buf);
  }
}

function command(id, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([id]), payload]);
}

function buildClientHandshake(args) {
  const username = latin1Padded(args.username || USER, 48);
  const password = latin1Padded("", 48);
  const passwordFull = latin1Padded(args.httpdata || "", 228);
  const key = latin1("");
  const parts = [
    Buffer.from([0xdd]),
    le32(0x5a5a5a5a),
    le32(username.length),
    le32(password.length),
    le32(4),
    le32(key.length),
    username,
    password,
    le32(0x1f),
    key,
    passwordFull,
  ];
  return Buffer.concat(parts);
}

function invalidateRegion(left, top, right, bottom) {
  // 0xf2 Invalidate: numRegions(u16) + N × (left,top,right,bottom as u16 LE)
  send(command(0xf2, Buffer.concat([le16(1), le16(left), le16(top), le16(right), le16(bottom)])));
}

function sendStartupMessages(args) {
  send(buildClientHandshake(args));
  send(command(0xf7, le32(START_BSE_MODE))); // InformBSEMode: none/3bpp/8bpp
  if (START_HARDWARE_COMPRESSION !== null) {
    if (START_HARDWARE_COMPRESSION || ALLOW_RAW_ENHANCE_BY_DEFAULT) {
      send(command(0xf3, Buffer.from([START_HARDWARE_COMPRESSION ? 1 : 0])));
      state.videoSettings.hardwareCompression = START_HARDWARE_COMPRESSION;
    } else {
      setStatus("video-setting", "ignored startup raw enhance request; set IRMC_ALLOW_RAW_ENHANCE_BY_DEFAULT=1 to allow");
      state.videoSettings.hardwareCompression = null;
    }
  }
  if (START_FORCE_8BPP) send(command(0xf6, Buffer.from([1])));
  send(command(0xd3, Buffer.from([0]))); // RequestPrimaryControl
  // NOTE: do NOT send 0xf1 (RequestVesaMode) — Java client doesn't send it and it causes a spurious double VideoMode reset
  invalidateRegion(0, 0, 2048, 2048); // Invalidate full screen; use large region since we don't know dimensions yet
}

function sendSequenceAck(seq, reserved) {
  const r = reserved ? Buffer.from(reserved) : Buffer.alloc(3);
  send(command(0xef, Buffer.concat([r, le32(seq)])));
}

function sendKeyState(hid, down) {
  const payload = Buffer.concat([
    le16(hid),
    Buffer.from([down ? 1 : 0, 0]),
  ]);
  send(command(0xd1, payload));
  state.keyEvents = (state.keyEvents || 0) + 1;
}

function sendKeyCombo(hids) {
  const unique = [...new Set(hids.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 0x10000))];
  for (const hid of unique) sendKeyState(hid, true);
  for (const hid of unique.slice().reverse()) sendKeyState(hid, false);
}

function clampMouseCoord(n, max) {
  return Math.max(0, Math.min(Math.max(0, max - 1), Math.round(Number(n) || 0)));
}

function mouseButtonStates(buttons = 0, wheel = 0) {
  const left = (buttons & 1) !== 0;
  const right = (buttons & 2) !== 0;
  const middle = (buttons & 4) !== 0;
  const wheelPos = Math.max(0, Math.min(127, 64 + Math.max(-63, Math.min(63, Math.round(Number(wheel) || 0)))));
  return [
    0x80 | (left ? 1 : 0),
    0x80 | (right ? 1 : 0),
    ((wheelPos << 1) & 0xfe) | (middle ? 1 : 0),
  ];
}

function sendMouseAbsoluteMode() {
  if (state.mouseAbsoluteModeSent) return;
  send(command(0xb1, Buffer.from([1]))); // ClientAbsoluteMode(true)
  send(command(0xb2, Buffer.from([0]))); // ClientRelativeMode(false, hide=false)
  state.mouseAbsoluteModeSent = true;
}

function sendMouseMove(x, y) {
  if (!state.width || !state.height) return;
  sendMouseAbsoluteMode();
  const mx = clampMouseCoord(x, state.width);
  const my = clampMouseCoord(y, state.height);
  send(command(0xb5, Buffer.concat([i32(mx), i32(my)])));
  state.mouseEvents = (state.mouseEvents || 0) + 1;
  state.mouseX = mx;
  state.mouseY = my;
}

function sendMouseButtonState(x, y, buttons, wheel = 0) {
  if (!state.width || !state.height) return;
  sendMouseAbsoluteMode();
  const mx = clampMouseCoord(x, state.width);
  const my = clampMouseCoord(y, state.height);
  send(command(0xb3, Buffer.concat([i32(mx), i32(my), Buffer.from([3, ...mouseButtonStates(buttons, wheel)])])));
  state.mouseEvents = (state.mouseEvents || 0) + 1;
  state.mouseX = mx;
  state.mouseY = my;
  state.mouseButtons = buttons & 7;
}

function sendVideoSetting(name, value, options = {}) {
  if (name === "hardwareCompression") {
    if (!value && !ALLOW_RAW_ENHANCE_BY_DEFAULT && !options.allowRawEnhance) {
      throw new Error("refusing to switch to raw enhance; pass allowRawEnhance=true to allow f3 00");
    }
    if (state.videoSettings.hardwareCompression === !!value) return false;
    send(command(0xf3, Buffer.from([value ? 1 : 0])));
    state.videoSettings.hardwareCompression = !!value;
  } else if (name === "force8bpp") {
    if (!ALLOW_EXPERIMENTAL_FORCE8 && !options.allowExperimentalForce8) {
      throw new Error("force-8bpp/reduce-bandwidth is experimental and can stop the stream; set IRMC_ALLOW_EXPERIMENTAL_FORCE8=1 or pass allowExperimentalForce8=true");
    }
    if (state.videoSettings.force8bpp === !!value) return false;
    send(command(0xf6, Buffer.from([value ? 1 : 0])));
    state.videoSettings.force8bpp = !!value;
  } else if (name === "bseMode") {
    const mode = Math.max(0, Math.min(2, Number(value) || 0));
    if (mode && !ALLOW_EXPERIMENTAL_BSE) throw new Error("BSE low-bandwidth modes are disabled by IRMC_ALLOW_EXPERIMENTAL_BSE=0");
    if (state.videoSettings.bseMode === mode) return false;
    send(command(0xf7, le32(mode)));
    state.videoSettings.bseMode = mode;
  } else {
    throw new Error(`unknown video setting: ${name}`);
  }
  state.videoSettings.updatedAt = new Date().toISOString();
  return true;
}

function sendVideoSettings(settings) {
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(settings, "hardwareCompression")) changed = sendVideoSetting("hardwareCompression", !!settings.hardwareCompression, { allowRawEnhance: settings.allowRawEnhance === true }) || changed;
  if (Object.prototype.hasOwnProperty.call(settings, "force8bpp")) changed = sendVideoSetting("force8bpp", !!settings.force8bpp, { allowExperimentalForce8: settings.allowExperimentalForce8 === true }) || changed;
  if (Object.prototype.hasOwnProperty.call(settings, "bseMode")) changed = sendVideoSetting("bseMode", settings.bseMode, settings) || changed;
  if (changed) invalidateRegion(0, 0, state.width || 2048, state.height || 2048); // request one fresh repaint after a settings batch
  return changed;
}

function cloneCommands() {
  return Object.fromEntries(Object.entries(state.commands || {}).map(([k, v]) => [k, v]));
}

function snapshotVideoState() {
  return {
    t: new Date().toISOString(),
    width: state.width,
    height: state.height,
    bpp: state.bpp,
    frames: state.frames,
    rev: latestPngRev,
    bytesIn: state.bytesIn,
    commands: cloneCommands(),
    stats: { ...state.stats },
    videoSettings: { ...state.videoSettings, probes: undefined },
    observedStream: { ...state.observedStream },
  };
}

function commandDelta(before, after) {
  const keys = new Set([...Object.keys(before.commands || {}), ...Object.keys(after.commands || {})]);
  return Object.fromEntries([...keys].sort().map((k) => [k, (after.commands?.[k] || 0) - (before.commands?.[k] || 0)]));
}

function summarizeProbe(name, value, before, after) {
  const changed = [];
  if (before.bpp !== after.bpp) changed.push(`bpp ${before.bpp}->${after.bpp}`);
  if (before.stats.lastEncoding !== after.stats.lastEncoding) changed.push(`encoding ${before.stats.lastEncoding || "unknown"}->${after.stats.lastEncoding || "unknown"}`);
  if ((after.videoSettings.unsupportedBseFrames || 0) > (before.videoSettings.unsupportedBseFrames || 0)) changed.push("unsupported BSE frames appeared");
  const bitrateDelta = Math.round(((after.stats.bitrateKbps || 0) - (before.stats.bitrateKbps || 0)) * 10) / 10;
  const fpsDelta = Math.round(((after.stats.fps || 0) - (before.stats.fps || 0)) * 10) / 10;
  if (!changed.length && Math.abs(bitrateDelta) < 250 && Math.abs(fpsDelta) < 0.5) changed.push("no visible stream effect");
  return {
    name,
    value,
    at: after.t,
    summary: changed.join("; "),
    bitrateDelta,
    fpsDelta,
    before,
    after,
    restored: false,
    commandDelta: commandDelta(before, after),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const powerActions = {
  on: 1,
  off: 0,
  cycle: 2,
  button: 14,
  nmi: 4,
  reset: 3,
  reboot: 15,
  shutdown: 5,
};

function sendPowerAction(action) {
  if (!Object.prototype.hasOwnProperty.call(powerActions, action)) throw new Error(`unknown power action: ${action}`);
  send(command(0x41, Buffer.from([powerActions[action] & 0xff])));
  state.powerActions = (state.powerActions || 0) + 1;
  state.lastPowerAction = action;
  state.lastPowerActionAt = new Date().toISOString();
}

function pruneTimedSamples(samples, now, windowMs) {
  while (samples.length && now - samples[0].t > windowMs) samples.shift();
}

function noteNetworkBytes(n) {
  const now = Date.now();
  state.bytesIn += n;
  byteSamples.push({ t: now, n });
  pruneTimedSamples(byteSamples, now, 5000);
  const bytes = byteSamples.reduce((sum, sample) => sum + sample.n, 0);
  const span = Math.max(1, (now - byteSamples[0].t) / 1000);
  state.stats.bitrateKbps = Math.round((bytes * 8 / span / 1000) * 10) / 10;
}

function noteDecodedFrame(encoding, encodedBytes, updates, decodeMs = 0) {
  const now = Date.now();
  const prevFrame = frameTimes[frameTimes.length - 1] || 0;
  frameTimes.push(now);
  while (frameTimes.length && now - frameTimes[0] > 5000) frameTimes.shift();
  const span = frameTimes.length > 1 ? Math.max(1, (now - frameTimes[0]) / 1000) : 1;
  state.stats.fps = Math.round((frameTimes.length / span) * 10) / 10;
  state.stats.frameIntervalMs = prevFrame ? now - prevFrame : 0;
  state.stats.lastEncoding = encoding;
  state.stats.lastEncodedBytes = encodedBytes || 0;
  state.stats.lastUpdates = updates?.length || 0;
  state.stats.lastDecodeMs = Math.round(decodeMs * 10) / 10;
  state.updateRects = (updates || []).slice(0, 256);
}

function observeStream(fields) {
  state.observedStream = {
    ...state.observedStream,
    ...fields,
    bpp: state.bpp,
    updatedAt: new Date().toISOString(),
  };
}

function noteEnhanceType(type) {
  const key = String(type);
  state.stats.enhanceTypes ||= {};
  state.stats.enhanceTypes[key] = (state.stats.enhanceTypes[key] || 0) + 1;
}

function rememberRenderedFrame(encoding, encodedBytes, updates) {
  if (!latestPng) return;
  recording.push({
    rev: latestPngRev,
    t: Date.now(),
    width: state.width,
    height: state.height,
    bpp: state.bpp,
    encoding,
    encodedBytes: encodedBytes || 0,
    updates: (updates || []).slice(0, 256),
    png: latestPng,
  });
  while (recording.length > RECORDING_LIMIT) recording.shift();
  state.stats.recordingFrames = recording.length;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) reject(new Error("request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function findLatestJnlp() {
  const candidates = [
    process.env.IRMC_JNLP,
    path.join(os.tmpdir(), "irmc-live-viewer", "avr.jnlp"),
    path.join(process.cwd(), "avr.jnlp"),
    path.join(process.cwd(), "irmc-curl", "avr.jnlp"),
    ...safeGlob(path.join(os.homedir(), "Downloads"), /^avr.*\.jnlp$/),
  ].filter(Boolean);
  return candidates
    .filter((p) => {
      try { return fs.statSync(p).isFile(); } catch { return false; }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function safeGlob(dir, re) {
  try {
    return fs.readdirSync(dir).filter((name) => re.test(name)).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function stripIpv6Brackets(host) {
  const m = String(host || "").match(/^\[([^\]]+)\]$/);
  return m ? m[1] : String(host || "");
}

function formatUrlHost(host) {
  const h = stripIpv6Brackets(host);
  return h.includes(":") ? `[${h}]` : h;
}

function parseJnlp(file) {
  const xml = fs.readFileSync(file, "utf8");
  const args = {};
  for (const m of xml.matchAll(/<argument>\s*([^<]+?)\s*<\/argument>/g)) {
    const text = m[1].trim();
    const kv = text.match(/^-([^=]+)=(.*)$/);
    if (kv) args[kv[1]] = kv[2];
  }
  if (process.env.IRMC_HOST) args.ipaddress = stripIpv6Brackets(HOST);
  else args.ipaddress ||= HOST;
  args.VncPort ||= "80";
  state.jnlp = file;
  return args;
}

function curl(args, output) {
  const base = [
    "--silent", "--show-error", "--fail", "--location",
    "--digest", "--user", `${USER}:${PASS}`,
    "--connect-timeout", "10",
  ];
  if (SCHEME === "https") base.push("--insecure");
  if (output) base.push("-o", output);
  return execFileSync("curl", [...base, ...args], { encoding: output ? undefined : "utf8" });
}

function fetchFreshJnlp() {
  if (!PASS) return null;
  if (!HOST) throw new Error("IRMC_HOST is required when fetching a fresh JNLP");

  const dir = path.join(os.tmpdir(), "irmc-live-viewer");
  fs.mkdirSync(dir, { recursive: true });
  const home = path.join(dir, "home.html");
  const jnlp = path.join(dir, "avr.jnlp");
  const hostPort = `${formatUrlHost(HOST)}${IRMC_PORT ? `:${IRMC_PORT}` : ""}`;
  const base = `${SCHEME}://${hostPort}`;

  curl([`${base}/`], home);
  let html = fs.readFileSync(home, "utf8");
  let sid = (html.match(/sid=([A-Za-z0-9_\/+-]+)/) || [])[1];

  for (const page of ["/index.html", "/irmc.html", "/main.html", "/navigation.html", "/console.html", "/avr.html", "/avr.htm", "/avrcfg.htm"]) {
    if (sid) break;
    try {
      curl([`${base}${page}`], home);
      html = fs.readFileSync(home, "utf8");
      sid = (html.match(/sid=([A-Za-z0-9_\/+-]+)/) || [])[1];
    } catch {
      // Some firmware pages return errors depending on session state.
    }
  }

  if (!sid) throw new Error("could not find iRMC sid while fetching JNLP");
  curl([`${base}/avr.jnlp?ms=${MS}&lang=${LANG}&sid=${sid}`], jnlp);
  if (!fs.readFileSync(jnlp, "utf8").includes("<jnlp")) throw new Error("downloaded AVR file is not JNLP");
  return jnlp;
}

function ensureFramebuffer() {
  if (!state.width || !state.height) return false;
  if (!framebuffer) framebuffer = Buffer.alloc(state.width * state.height * 3);
  return true;
}

function setPixelRgb(px, py, red, green, blue) {
  if (py < 0 || px < 0 || py >= state.height || px >= state.width) return;
  const p = (py * state.width + px) * 3;
  framebuffer[p] = red;
  framebuffer[p + 1] = green;
  framebuffer[p + 2] = blue;
}

function setPixelInt(px, py, rgb) {
  setPixelRgb(px, py, (rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
}

function ensureTextMode(cols, rows, fontWidth, fontHeight) {
  const fw = fontWidth || textMode?.fontWidth || 8;
  const fh = fontHeight || textMode?.fontHeight || 16;
  const c = cols || textMode?.cols || Math.max(1, Math.floor((state.width || 640) / fw));
  const r = rows || textMode?.rows || Math.max(1, Math.floor((state.height || 400) / fh));
  const cells = c * r;
  if (!textMode || textMode.cols !== c || textMode.rows !== r || textMode.fontWidth !== fw || textMode.fontHeight !== fh) {
    const ascii = Buffer.alloc(cells, 32);
    const attr = Buffer.alloc(cells, 0x07);
    if (textMode) {
      textMode.ascii.copy(ascii, 0, 0, Math.min(ascii.length, textMode.ascii.length));
      textMode.attr.copy(attr, 0, 0, Math.min(attr.length, textMode.attr.length));
    }
    textMode = {
      cols: c,
      rows: r,
      fontWidth: fw,
      fontHeight: fh,
      ascii,
      attr,
      font: textMode?.font || Buffer.alloc(256 * 32),
      fontHasGlyph: textMode?.fontHasGlyph || null,
      cursorX: -1,
      cursorY: -1,
      startLine: 0,
      stopLine: fh - 1,
    };
  }
  return textMode;
}

function fallbackGlyph(code, row, fontHeight) {
  if (code === 32) return 0;
  const cp437 = cp437Glyphs[code];
  if (cp437) {
    const glyphRow = Math.floor(row * cp437.length / Math.max(1, fontHeight));
    return cp437[glyphRow] || 0;
  }
  const ch = String.fromCharCode(code >= 32 && code <= 126 ? code : 63);
  const glyph = tinyGlyphs[ch] || tinyGlyphs[ch.toUpperCase()] || tinyGlyphs["?"];
  const glyphRow = Math.floor(row * 7 / Math.max(1, fontHeight));
  return glyph[glyphRow] || 0;
}

const cp437Glyphs = {
  176:[10,0,10,0,10,0,10],
  177:[10,21,10,21,10,21,10],
  178:[21,31,21,31,21,31,21],
  179:[4,4,4,4,4,4,4],
  180:[4,4,4,31,4,4,4],
  181:[4,4,4,7,4,4,4],
  182:[4,4,4,28,4,4,4],
  183:[10,10,10,30,10,10,10],
  184:[10,10,10,3,10,10,10],
  185:[10,10,10,27,10,10,10],
  186:[10,10,10,10,10,10,10],
  187:[0,0,0,30,2,2,2],
  188:[2,2,2,30,0,0,0],
  189:[10,10,10,14,0,0,0],
  190:[0,0,0,14,10,10,10],
  191:[0,0,0,31,1,1,1],
  192:[1,1,1,31,0,0,0],
  193:[4,4,4,31,0,0,0],
  194:[0,0,0,31,4,4,4],
  195:[4,4,4,31,0,0,0],
  196:[0,0,0,31,0,0,0],
  197:[4,4,4,31,4,4,4],
  198:[4,4,4,7,4,4,4],
  199:[10,10,10,11,8,8,8],
  200:[8,8,8,15,0,0,0],
  201:[0,0,0,15,8,8,8],
  202:[10,10,10,15,0,0,0],
  203:[0,0,0,31,10,10,10],
  204:[10,10,10,31,0,0,0],
  205:[0,0,0,31,0,0,0],
  206:[10,10,10,31,10,10,10],
  207:[4,4,4,31,0,0,0],
  208:[0,0,0,31,4,4,4],
  209:[10,10,10,30,0,0,0],
  210:[0,0,0,7,4,4,4],
  211:[0,0,0,28,4,4,4],
  212:[4,4,4,28,0,0,0],
  213:[4,4,4,7,0,0,0],
  214:[0,0,0,31,10,10,10],
  215:[10,10,10,31,0,0,0],
  216:[4,4,4,28,4,4,4],
  217:[1,1,1,31,0,0,0],
  218:[0,0,0,31,1,1,1],
  219:[31,31,31,31,31,31,31],
  220:[0,0,0,0,31,31,31],
  221:[28,28,28,28,28,28,28],
  222:[7,7,7,7,7,7,7],
  223:[31,31,31,0,0,0,0],
};

const tinyGlyphs = {
  "A":[14,17,17,31,17,17,17],"B":[30,17,17,30,17,17,30],"C":[14,17,16,16,16,17,14],"D":[30,17,17,17,17,17,30],
  "E":[31,16,16,30,16,16,31],"F":[31,16,16,30,16,16,16],"G":[14,17,16,23,17,17,15],"H":[17,17,17,31,17,17,17],
  "I":[14,4,4,4,4,4,14],"J":[7,2,2,2,18,18,12],"K":[17,18,20,24,20,18,17],"L":[16,16,16,16,16,16,31],
  "M":[17,27,21,21,17,17,17],"N":[17,25,21,19,17,17,17],"O":[14,17,17,17,17,17,14],"P":[30,17,17,30,16,16,16],
  "Q":[14,17,17,17,21,18,13],"R":[30,17,17,30,20,18,17],"S":[15,16,16,14,1,1,30],"T":[31,4,4,4,4,4,4],
  "U":[17,17,17,17,17,17,14],"V":[17,17,17,17,17,10,4],"W":[17,17,17,21,21,21,10],"X":[17,17,10,4,10,17,17],
  "Y":[17,17,10,4,4,4,4],"Z":[31,1,2,4,8,16,31],
  "0":[14,17,19,21,25,17,14],"1":[4,12,4,4,4,4,14],"2":[14,17,1,2,4,8,31],"3":[30,1,1,14,1,1,30],
  "4":[2,6,10,18,31,2,2],"5":[31,16,16,30,1,1,30],"6":[14,16,16,30,17,17,14],"7":[31,1,2,4,8,8,8],
  "8":[14,17,17,14,17,17,14],"9":[14,17,17,15,1,1,14],
  ".":[0,0,0,0,0,12,12],",":[0,0,0,0,0,12,8],":":[0,12,12,0,12,12,0],";":[0,12,12,0,12,4,8],
  "-":[0,0,0,31,0,0,0],"_":[0,0,0,0,0,0,31],"+":[0,4,4,31,4,4,0],"=":[0,0,31,0,31,0,0],
  "/":[1,1,2,4,8,16,16],"\\":[16,16,8,4,2,1,1],"|":[4,4,4,4,4,4,4],
  "'":[4,4,8,0,0,0,0],'"':[10,10,0,0,0,0,0],"`":[8,4,0,0,0,0,0],
  "(": [2,4,8,8,8,4,2], ")":[8,4,2,2,2,4,8], "[":[14,8,8,8,8,8,14], "]":[14,2,2,2,2,2,14],
  "<":[2,4,8,16,8,4,2], ">":[8,4,2,1,2,4,8], "?":[14,17,1,2,4,0,4],
  "!":[4,4,4,4,4,0,4],"@":[14,17,23,21,23,16,14],"#":[10,31,10,10,31,10,0],"$":[4,15,20,14,5,30,4],
  "%":[24,25,2,4,8,19,3],"^":[4,10,17,0,0,0,0],"&":[12,18,20,8,21,18,13],"*":[0,21,14,31,14,21,0],
  "~":[0,0,8,21,2,0,0], "{":[2,4,4,8,4,4,2], "}":[8,4,4,2,4,4,8],
};

function renderTextCell(tm, col, row) {
  if (!framebuffer) framebuffer = Buffer.alloc(state.width * state.height * 3);
  if (col < 0 || row < 0 || col >= tm.cols || row >= tm.rows) return;
  const cell = row * tm.cols + col;
  const code = tm.ascii[cell] || 32;
  const attr = tm.attr[cell] ?? 0x07;
  const fg = textPalette[attr & 0x0f] || textPalette[7];
  const bg = textPalette[(attr >> 4) & 0x07] || textPalette[0];
  if (!tm.fontHasGlyph) {
    tm.fontHasGlyph = new Uint8Array(256);
    for (let c = 0; c < 256; c++) {
      for (let y = 0; y < 32; y++) {
        if (tm.font[c * 32 + y] !== 0) {
          tm.fontHasGlyph[c] = 1;
          break;
        }
      }
    }
  }
  const useSuppliedFont = tm.fontHasGlyph[code] === 1;
  for (let y = 0; y < tm.fontHeight; y++) {
    const fontByte = useSuppliedFont ? (tm.font[code * 32 + y] || 0) : fallbackGlyph(code, y, tm.fontHeight);
    for (let x = 0; x < tm.fontWidth; x++) {
      const mask = 1 << Math.max(0, 7 - x);
      const on = (fontByte & mask) !== 0;
      const isCursor = row === tm.cursorY && col === tm.cursorX && y >= tm.startLine && y <= tm.stopLine;
      const rgb = on || isCursor ? fg : bg;
      setPixelRgb(col * tm.fontWidth + x, row * tm.fontHeight + y, rgb[0], rgb[1], rgb[2]);
    }
  }
}

function renderTextRegion(tm, x, y, width, height) {
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) renderTextCell(tm, col, row);
  }
  latestPng = renderPng();
  latestPngRev++;
}

function findTileShiftAmt(n) {
  let shift = 1;
  while ((n >> shift) !== 0) shift++;
  return shift - 1;
}

function findNumTiles(n, tile) {
  return Math.floor(n / tile) + (n % tile ? 1 : 0);
}

function rleReader(data, st, repeatCode, tripletCode) {
  if (st.remaining < 1) {
    let value = data[st.offset++] ?? 0;
    if (value === tripletCode) {
      st.remaining = 3;
      value = data[st.offset++] ?? 0;
    } else if (value === repeatCode) {
      st.remaining = data[st.offset++] ?? 0;
      if (st.remaining === 1) {
        st.remaining = 1;
        value = tripletCode;
      } else if (st.remaining === 0) {
        st.remaining = 1;
        value = repeatCode;
      } else {
        st.remaining += 1;
        value = data[st.offset++] ?? 0;
      }
    } else {
      st.remaining = 1;
    }
    st.value = value;
  }
  st.remaining -= 1;
  return st.value;
}

function bseByteReader(data, st) {
  if (st.remaining < 1) {
    let value = data[st.offset++] ?? 0;
    if (value === 0x55) {
      st.remaining = 3;
      value = data[st.offset++] ?? 0;
    } else if (value === 0xaa) {
      st.remaining = data[st.offset++] ?? 0;
      if (st.remaining === 1) {
        st.remaining = 1;
        value = 0x55;
      } else if (st.remaining === 0) {
        st.remaining = 1;
        value = 0xaa;
      } else {
        st.remaining += 1;
        value = data[st.offset++] ?? 0;
      }
    } else {
      st.remaining = 1;
    }
    st.value = value;
  }
  st.remaining -= 1;
  return st.value;
}

const BSE_3BPP_SHIFTS_24 = [7, 15, 23];
const BSE_8BPP_SHIFTS_24 = [6, 7, 12, 13, 14, 15, 22, 23];
const BSE_3BPP_MASK_24 = [128, 32768, 8388608];
const BSE_8BPP_MASK_24 = [192, 61440, 12582912];
const BSE_INTENSE_24 = [255, 65280, 16711680];

function bseIntensify(rgb, masks = BSE_8BPP_MASK_24) {
  let out = rgb;
  for (let i = 0; i < 3; i++) {
    if ((out & masks[i]) === masks[i]) out |= BSE_INTENSE_24[i];
  }
  return out & 0xffffff;
}

function applyBseBitPlane(frame, planeCount, shifts, masks) {
  if (!ensureFramebuffer()) return null;
  const startY = (frame.top & 0xff) << 5;
  const endY = ((frame.bottom & 0xff) + 1) << 5;
  const startX = (frame.left & 0xff) << 5;
  const endX = ((frame.right & 0xff) + 1) << 5;
  const width = Math.max(0, Math.min(endX, state.width) - startX);
  const height = Math.max(0, Math.min(endY, state.height) - startY);
  if (!width || !height) return null;

  const compressed = frame.compressedLength < frame.uncompressedLength;
  const compressedState = { offset: 0, remaining: 0, value: 0 };
  const states = Array.from({ length: planeCount }, () => ({ offset: 0, remaining: 0, value: 0 }));
  const planeStride = Math.max(0, Math.floor(frame.uncompressedLength / planeCount));
  if (!compressed) {
    for (let i = 0; i < planeCount; i++) states[i].offset = Math.floor(frame.uncompressedLength * i / planeCount);
  }

  if (compressed) {
    for (let plane = 0; plane < planeCount; plane++) {
      const shift = shifts[plane];
      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x += 8) {
          const value = bseByteReader(frame.data, compressedState);
          for (let bit = 0; bit < 8; bit++) {
            const px = x + bit;
            if (px >= state.width || y >= state.height) continue;
            const bitValue = ((value >> bit) & 1) << shift;
            const current = plane === 0 ? 0 : pixelIntAt(px, y);
            setPixelInt(px, y, plane === planeCount - 1 ? bseIntensify(current | bitValue, masks) : (current | bitValue));
          }
        }
      }
    }
  } else {
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x += 8) {
        const values = states.map((st, plane) => {
          const off = st.offset++;
          return off < frame.data.length && off < (plane + 1) * planeStride ? frame.data[off] : 0;
        });
        for (let bit = 0; bit < 8; bit++) {
          const px = x + bit;
          if (px >= state.width || y >= state.height) continue;
          let rgb = 0;
          for (let plane = 0; plane < planeCount; plane++) rgb |= ((values[plane] >> bit) & 1) << shifts[plane];
          setPixelInt(px, y, bseIntensify(rgb, masks));
        }
      }
    }
  }

  return [{ x: startX, y: startY, width, height }];
}

function pixelIntAt(px, py) {
  if (!framebuffer || py < 0 || px < 0 || py >= state.height || px >= state.width) return 0;
  const p = (py * state.width + px) * 3;
  return ((framebuffer[p] || 0) << 16) | ((framebuffer[p + 1] || 0) << 8) | (framebuffer[p + 2] || 0);
}

function applyBseBitBlt(frame) {
  if (frame.bltType === 3) return applyBseBitPlane(frame, 3, BSE_3BPP_SHIFTS_24, BSE_3BPP_MASK_24);
  if (frame.bltType === 8) return applyBseBitPlane(frame, 8, BSE_8BPP_SHIFTS_24, BSE_8BPP_MASK_24);
  return null;
}

function applyEnhanceHLC(frame) {
  if (!ensureFramebuffer()) return [];

  const tileXShift = findTileShiftAmt(frame.tileWidth);
  const tileYShift = findTileShiftAmt(frame.tileHeight);
  const tilesX = Math.min(findNumTiles(state.width, frame.tileWidth), 64);
  const tilesY = Math.min(findNumTiles(state.height, frame.tileHeight), 64);

  let blueLen = frame.data.length;
  let greenLen = 0;
  let blueOff = 0;
  let greenOff = 0;
  let redOff = 0;

  if (state.bpp > 8) {
    blueLen = frame.data.readUInt32LE(0);
    greenLen = frame.data.readUInt32LE(4);
    blueOff = 12;
    greenOff = blueOff + blueLen;
    if (state.bpp > 16) redOff = greenOff + greenLen;
  }

  const blueState = { offset: blueOff, remaining: 0, value: 0 };
  const greenState = { offset: greenOff, remaining: 0, value: 0 };
  const redState = { offset: redOff, remaining: 0, value: 0 };
  const updates = [];

  for (let tileY = 0; tileY < tilesY; tileY++) {
    for (let tileX = 0; tileX < tilesX; tileX++) {
      const active = tileX < 32
        ? ((frame.snoopLow[tileY] & (1 << tileX)) !== 0)
        : ((frame.snoopHigh[tileY] & (1 << (tileX - 32))) !== 0);
      if (!active) continue;

      const startY = tileY << tileYShift;
      const startX = tileX << tileXShift;
      updates.push({
        x: startX,
        y: startY,
        width: Math.min(frame.tileWidth, Math.max(0, state.width - startX)),
        height: Math.min(frame.tileHeight, Math.max(0, state.height - startY)),
      });
      for (let y = 0; y < frame.tileHeight; y++) {
        const py = startY + y;
        for (let x = 0; x < frame.tileWidth; x++) {
          const px = startX + x;
          const blue = rleReader(frame.data, blueState, frame.repeatCode, frame.tripletCode);
          if (state.bpp <= 8) {
            const rgb = palette[blue] || [blue, blue, blue];
            setPixelRgb(px, py, rgb[0], rgb[1], rgb[2]);
          } else {
            const green = rleReader(frame.data, greenState, frame.repeatCode, frame.tripletCode);
            const red = state.bpp > 16 ? rleReader(frame.data, redState, frame.repeatCode, frame.tripletCode) : 0;
            setPixelRgb(px, py, red, green, blue);
          }
        }
      }
    }
  }
  return updates;
}

function applyEnhanceRaw(frame) {
  if (!ensureFramebuffer()) return [];

  const tileXShift = findTileShiftAmt(frame.tileWidth);
  const tileYShift = findTileShiftAmt(frame.tileHeight);
  const tilesX = Math.min(findNumTiles(state.width, frame.tileWidth), 64);
  const tilesY = Math.min(findNumTiles(state.height, frame.tileHeight), 64);
  const bytesPerPixel = Math.max(1, state.bpp >> 3);
  const updates = [];
  let off = 0;

  for (let tileY = 0; tileY < tilesY; tileY++) {
    for (let tileX = 0; tileX < tilesX; tileX++) {
      const active = tileX < 32
        ? ((frame.snoopLow[tileY] & (1 << tileX)) !== 0)
        : ((frame.snoopHigh[tileY] & (1 << (tileX - 32))) !== 0);
      if (!active) continue;

      const startY = tileY << tileYShift;
      const startX = tileX << tileXShift;
      updates.push({
        x: startX,
        y: startY,
        width: Math.min(frame.tileWidth, Math.max(0, state.width - startX)),
        height: Math.min(frame.tileHeight, Math.max(0, state.height - startY)),
      });
      for (let y = 0; y < frame.tileHeight; y++) {
        const py = startY + y;
        for (let x = 0; x < frame.tileWidth; x++) {
          const px = startX + x;
          if (off >= frame.data.length) return updates;
          if (state.bpp <= 8) {
            const idx = frame.data[off] || 0;
            const rgb = palette[idx] || [idx, idx, idx];
            setPixelRgb(px, py, rgb[0], rgb[1], rgb[2]);
          } else {
            const blue = frame.data[off] || 0;
            const green = frame.data[off + 1] || 0;
            const red = state.bpp > 16 ? (frame.data[off + 2] || 0) : 0;
            setPixelRgb(px, py, red, green, blue);
          }
          off += bytesPerPixel;
        }
      }
    }
  }
  return updates;
}

function applyBitBlt(frame) {
  if (!ensureFramebuffer()) return null;
  if (state.bpp !== 8) return null;
  const width = Math.max(0, frame.dst.width);
  const height = Math.max(0, frame.dst.height);
  if (!width || !height || frame.data.length < width * height) return null;
  let off = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = frame.data[off++];
      const rgb = palette[idx] || [idx, idx, idx];
      setPixelRgb(frame.dst.x + x, frame.dst.y + y, rgb[0], rgb[1], rgb[2]);
    }
  }
  return [{ x: frame.dst.x, y: frame.dst.y, width, height }];
}

function applyTextBlt(frame) {
  if (![257, 258, 259, 260, 261, 262, 263, 264].includes(frame.bltType)) return false;
  const started = process.hrtime.bigint();
  const tm = ensureTextMode(Math.max(textMode?.cols || 0, frame.dst.x + frame.dst.width), Math.max(textMode?.rows || 0, frame.dst.y + frame.dst.height), frame.fontWidth || 8, frame.fontHeight || 16);
  let off = 0;
  const cells = Math.max(0, frame.dst.width * frame.dst.height);

  if (frame.bltType === 264) {
    for (let i = 0; i < cells && off + 1 < frame.data.length; i++) {
      const col = frame.dst.x + (i % frame.dst.width);
      const row = frame.dst.y + Math.floor(i / frame.dst.width);
      const idx = row * tm.cols + col;
      if (idx >= 0 && idx < tm.ascii.length) {
        tm.ascii[idx] = frame.data[off++];
        tm.attr[idx] = frame.data[off++];
      } else {
        off += 2;
      }
    }
  } else {
    if (frame.bltType & 1) {
      for (let i = 0; i < cells && off < frame.data.length; i++) {
        const col = frame.dst.x + (i % frame.dst.width);
        const row = frame.dst.y + Math.floor(i / frame.dst.width);
        const idx = row * tm.cols + col;
        if (idx >= 0 && idx < tm.ascii.length) tm.ascii[idx] = frame.data[off];
        off++;
      }
    }
    if (frame.bltType & 2) {
      for (let i = 0; i < cells && off < frame.data.length; i++) {
        const col = frame.dst.x + (i % frame.dst.width);
        const row = frame.dst.y + Math.floor(i / frame.dst.width);
        const idx = row * tm.cols + col;
        if (idx >= 0 && idx < tm.attr.length) tm.attr[idx] = frame.data[off];
        off++;
      }
    }
    if (frame.bltType & 4) {
      frame.data.copy(tm.font, 0, off, Math.min(frame.data.length, off + tm.font.length));
      tm.fontHasGlyph = null;
    }
  }

  renderTextRegion(tm, frame.dst.x, frame.dst.y, frame.dst.width, frame.dst.height);
  state.frames++;
  const updates = [{
    x: frame.dst.x * tm.fontWidth,
    y: frame.dst.y * tm.fontHeight,
    width: frame.dst.width * tm.fontWidth,
    height: frame.dst.height * tm.fontHeight,
  }];
  const decodeMs = Number(process.hrtime.bigint() - started) / 1e6;
  noteDecodedFrame(`TextBlt ${frame.bltType}`, frame.data.length, updates, decodeMs);
  rememberRenderedFrame(`TextBlt ${frame.bltType}`, frame.data.length, updates);
  return true;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return out;
}

function renderPng() {
  const started = process.hrtime.bigint();
  if (!ensureFramebuffer()) return null;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(state.width, 0);
  ihdr.writeUInt32BE(state.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((state.width * 3 + 1) * state.height);
  for (let y = 0; y < state.height; y++) {
    const row = y * (state.width * 3 + 1);
    raw[row] = 0;
    framebuffer.copy(raw, row + 1, y * state.width * 3, (y + 1) * state.width * 3);
  }
  const out = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 3 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  state.stats.lastPngMs = Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 10) / 10;
  state.stats.lastPngBytes = out.length;
  return out;
}

function readEnhanceAt(buf, offset) {
  const neededHeader = offset + 2 + 1 + 1 + 4 + 4 + 4 + 4 + 512;
  if (buf.length < neededHeader) return null;
  let o = offset;
  const bltRaw = buf.readUInt16LE(o); o += 2;
  const tileWidth = buf[o++];
  const tileHeight = buf[o++];
  const tripletCode = buf.readUInt32LE(o) & 0xff; o += 4;
  const repeatCode = buf.readUInt32LE(o) & 0xff; o += 4;
  const rawSize = buf.readUInt32LE(o); o += 4;
  const scrunchSize = buf.readUInt32LE(o); o += 4;
  const end = o + 512 + scrunchSize;
  if (buf.length < end) return null;
  const snoopLow = [];
  const snoopHigh = [];
  for (let i = 0; i < 64; i++) {
    snoopLow.push(buf.readInt32LE(o)); o += 4;
    snoopHigh.push(buf.readInt32LE(o)); o += 4;
  }
  const data = Buffer.from(buf.subarray(o, o + scrunchSize));
  const bltType = bltRaw >= 0x8000 ? bltRaw - 0x10000 : bltRaw;
  return { end, frame: { bltType, tileWidth, tileHeight, tripletCode, repeatCode, rawSize, scrunchSize, snoopLow, snoopHigh, data } };
}

function readBitBltAt(buf, offset) {
  const headerLen = 2 + 1 + 1 + 8 + 8 + 4;
  if (buf.length < offset + headerLen) return null;
  let o = offset;
  const bltRaw = buf.readUInt16LE(o); o += 2;
  const fontHeight = buf[o++];
  const fontWidth = buf[o++];
  const src = {
    x: buf.readInt16LE(o),
    y: buf.readInt16LE(o + 2),
    width: buf.readInt16LE(o + 4),
    height: buf.readInt16LE(o + 6),
  };
  o += 8;
  const dst = {
    x: buf.readInt16LE(o),
    y: buf.readInt16LE(o + 2),
    width: buf.readInt16LE(o + 4),
    height: buf.readInt16LE(o + 6),
  };
  o += 8;
  const dataSize = buf.readUInt32LE(o); o += 4;
  const end = o + dataSize;
  if (buf.length < end) return null;
  const bltType = bltRaw >= 0x8000 ? bltRaw - 0x10000 : bltRaw;
  return { end, frame: { bltType, fontHeight, fontWidth, src, dst, dataSize, data: buf.subarray(o, end) } };
}

function readSetPaletteAt(buf, offset) {
  if (buf.length < offset + 2) return null;
  let o = offset;
  const attrSize = buf.readUInt16LE(o); o += 2;
  const afterAttrs = o + attrSize * 2;
  if (buf.length < afterAttrs + 2) return null;
  o = afterAttrs;
  const paletteSize = buf.readUInt16LE(o); o += 2;
  const end = o + paletteSize * 4;
  if (buf.length < end) return null;
  const entries = [];
  for (let i = 0; i < paletteSize; i++) {
    const index = buf[o++] & 0xff;
    const red = buf[o++] & 0xff;
    const green = buf[o++] & 0xff;
    const blue = buf[o++] & 0xff;
    entries.push({ index, red, green, blue });
  }
  return { end, attrSize, paletteSize, entries };
}

function readSspBitBltAt(buf, offset) {
  const headerLen = 4 + 4 + 1 + 1 + 1 + 1 + 4;
  if (buf.length < offset + headerLen) return null;
  let o = offset;
  const compressedLength = buf.readUInt32LE(o); o += 4;
  const uncompressedLength = buf.readUInt32LE(o); o += 4;
  const top = buf[o++] & 0xff;
  const left = buf[o++] & 0xff;
  const bottom = buf[o++] & 0xff;
  const right = buf[o++] & 0xff;
  const sequence = buf.readUInt32LE(o); o += 4;
  const end = o + compressedLength;
  if (buf.length < end) return null;
  return { end, frame: { compressedLength, uncompressedLength, top, left, bottom, right, sequence, data: Buffer.from(buf.subarray(o, end)) } };
}

function readBseBitBltAt(buf, offset) {
  const headerLen = 4 + 4 + 4 + 1 + 1 + 1 + 1 + 4;
  if (buf.length < offset + headerLen) return null;
  let o = offset;
  const bltType = buf.readUInt32LE(o); o += 4;
  const compressedLength = buf.readUInt32LE(o); o += 4;
  const uncompressedLength = buf.readUInt32LE(o); o += 4;
  const top = buf[o++] & 0xff;
  const left = buf[o++] & 0xff;
  const bottom = buf[o++] & 0xff;
  const right = buf[o++] & 0xff;
  const sequence = buf.readUInt32LE(o); o += 4;
  const end = o + compressedLength;
  if (buf.length < end) return null;
  return { end, frame: { bltType, compressedLength, uncompressedLength, top, left, bottom, right, sequence, data: Buffer.from(buf.subarray(o, end)) } };
}

function count(cmd) {
  const k = `0x${cmd.toString(16).padStart(2, "0")}`;
  state.commands[k] = (state.commands[k] || 0) + 1;
}

function notePending(cmd, start, detail = "") {
  state.stats.rxBuffered = Math.max(0, rx.length - start);
  state.stats.pendingCommand = `0x${cmd.toString(16).padStart(2, "0")}${detail ? ` ${detail}` : ""}`;
}

function consumeStream() {
  let o = 0;
  while (o < rx.length) {
    const start = o;
    const cmd = rx[o++];

    if (cmd === 0x00) {
      while (o < rx.length && rx[o] === 0) o++;
      count(cmd);
    } else if (cmd === 0xc8) {
      if (rx.length < o + 32) { notePending(cmd, start); o = start; break; }
      o += 32;
      count(cmd);
      if (!handshakeSent) {
        handshakeSent = true;
        sendStartupMessages(currentArgs);
        setStatus("handshake", "sent client auth block");
      }
    } else if (cmd === 0xc9) {
      if (rx.length < o + 4) { notePending(cmd, start); o = start; break; }
      const len = rx.readUInt32LE(o); o += 4;
      if (rx.length < o + len) { notePending(cmd, start, `need=${len}`); o = start; break; }
      const fw = rx.subarray(o, o + len).toString("latin1").replace(/\0/g, "");
      o += len;
      count(cmd);
      state.detail = fw;
    } else if (cmd === 0xe1) {
      if (rx.length < o + 8) { notePending(cmd, start); o = start; break; }
      o += 2;
      const nextWidth = rx.readUInt16LE(o); o += 2;
      const nextHeight = rx.readUInt16LE(o); o += 2;
      const nextBpp = rx.readUInt16LE(o); o += 2;
      if (nextBpp === 0) {
        state.width = nextWidth;
        state.height = nextHeight;
        state.bpp = nextBpp;
        observeStream({ mode: "text", compression: "none", bseMode: null, force8bpp: null, command: "0xe1", enhanceType: null });
        framebuffer = Buffer.alloc(state.width * state.height * 3);
        const cols = Math.max(1, Math.round(nextWidth / (textMode?.fontWidth || 8)));
        const rows = Math.max(1, Math.round(nextHeight / (textMode?.fontHeight || 16)));
        const tm = ensureTextMode(cols, rows, textMode?.fontWidth || 8, textMode?.fontHeight || 16);
        renderTextRegion(tm, 0, 0, tm.cols, tm.rows);
        count(cmd);
        setStatus("video", `${nextWidth}x${nextHeight} ${nextBpp}bpp text mode`);
        logPacket("rx", rx.subarray(start, o), `offset=${start}`);
        continue;
      }
      state.width = nextWidth;
      state.height = nextHeight;
      state.bpp = nextBpp;
      observeStream({ mode: "graphics", bseMode: null, force8bpp: nextBpp === 8 ? "maybe" : false, command: "0xe1", enhanceType: null });
      framebuffer = Buffer.alloc(state.width * state.height * 3);
      count(cmd);
      setStatus("video", `${state.width}x${state.height} ${state.bpp}bpp`);
      invalidateRegion(0, 0, state.width, state.height); // re-send with exact dimensions now that we know them
    } else if (cmd === 0xe2) {
      const parsed = readBitBltAt(rx, o);
      if (!parsed) { notePending(cmd, start); o = start; break; }
      o = parsed.end;
      count(cmd);
      if (applyTextBlt(parsed.frame)) {
        // Text renderer updated the frame.
      } else {
        const decodeStarted = process.hrtime.bigint();
        const updates = applyBitBlt(parsed.frame);
        if (updates) {
        state.frames++;
        const decodeMs = Number(process.hrtime.bigint() - decodeStarted) / 1e6;
        noteDecodedFrame(`BitBlt ${parsed.frame.bltType}`, parsed.frame.data.length, updates, decodeMs);
        observeStream({ mode: "bitblt", compression: "none", bseMode: null, force8bpp: state.bpp === 8 ? "maybe" : false, command: "0xe2", enhanceType: parsed.frame.bltType });
        latestPng = renderPng();
        latestPngRev++;
        rememberRenderedFrame(`BitBlt ${parsed.frame.bltType}`, parsed.frame.data.length, updates);
        }
      }
    } else if (cmd === 0xe3) {
      const parsed = readEnhanceAt(rx, o);
      if (!parsed) {
        // Show scrunchSize if header is readable
        const hdrEnd = o + 20;
        const detail = rx.length >= hdrEnd
          ? `scrunch=${rx.readUInt32LE(o + 16)} raw=${rx.readUInt32LE(o + 12)} need=${rx.readUInt32LE(o + 16) + 532} have=${rx.length - start}`
          : `need-header`;
        notePending(cmd, start, detail);
        o = start; break;
      }
      o = parsed.end;
      count(cmd);
      noteEnhanceType(parsed.frame.bltType);
      if ([-32272, 496, -32270, 498].includes(parsed.frame.bltType)) {
        const decodeStarted = process.hrtime.bigint();
        const isHlc = parsed.frame.bltType === -32270 || parsed.frame.bltType === 498;
        const updates = isHlc ? applyEnhanceHLC(parsed.frame) : applyEnhanceRaw(parsed.frame);
        state.frames++;
        const decodeMs = Number(process.hrtime.bigint() - decodeStarted) / 1e6;
        const encoding = `${isHlc ? "EnhanceHLC" : "EnhanceRaw"} ${parsed.frame.bltType}`;
        noteDecodedFrame(encoding, parsed.frame.data.length, updates, decodeMs);
        observeStream({
          mode: isHlc ? "enhance-hlc" : "enhance-raw",
          compression: isHlc ? "hlc" : "none",
          bseMode: null,
          force8bpp: [501, -32267].includes(parsed.frame.bltType) ? true : (state.bpp === 8 ? "maybe" : false),
          command: "0xe3",
          enhanceType: parsed.frame.bltType,
        });
        if (state.frames % RENDER_EVERY === 0) {
          latestPng = renderPng();
          latestPngRev++;
          rememberRenderedFrame(encoding, parsed.frame.data.length, updates);
        }
      } else {
        state.stats.lastEncoding = `Enhance ${parsed.frame.bltType} unsupported`;
        state.stats.lastEncodedBytes = parsed.frame.data.length;
        observeStream({
          mode: "enhance-unsupported",
          compression: [498, -32270, 501, -32267].includes(parsed.frame.bltType) ? "hlc" : "unknown",
          bseMode: null,
          force8bpp: [501, -32267].includes(parsed.frame.bltType) ? true : null,
          command: "0xe3",
          enhanceType: parsed.frame.bltType,
        });
      }
    } else if (cmd === 0xe0 || cmd === 0xed) {
      const parsed = readSspBitBltAt(rx, o);
      if (!parsed) { notePending(cmd, start); o = start; break; }
      o = parsed.end;
      count(cmd);
      state.videoSettings.unsupportedBseFrames = (state.videoSettings.unsupportedBseFrames || 0) + 1;
      state.stats.lastEncoding = cmd === 0xe0 ? "LowBandwidthSSP unsupported" : "SSP unsupported";
      state.stats.lastEncodedBytes = parsed.frame.compressedLength;
      observeStream({ mode: cmd === 0xe0 ? "low-bandwidth-ssp" : "ssp", compression: "unknown", bseMode: "ssp", force8bpp: null, command: `0x${cmd.toString(16)}`, enhanceType: null });
      sendSequenceAck(parsed.frame.sequence);
    } else if (cmd === 0xe7) {
      const parsed = readBseBitBltAt(rx, o);
      if (!parsed) { notePending(cmd, start); o = start; break; }
      o = parsed.end;
      count(cmd);
      const decodeStarted = process.hrtime.bigint();
      const updates = applyBseBitBlt(parsed.frame);
      if (updates) {
        state.frames++;
        const decodeMs = Number(process.hrtime.bigint() - decodeStarted) / 1e6;
        noteDecodedFrame(`BSEBitBlt ${parsed.frame.bltType}`, parsed.frame.compressedLength, updates, decodeMs);
        observeStream({ mode: "bse", compression: "bse-rle", bseMode: parsed.frame.bltType, force8bpp: parsed.frame.bltType === 8, command: "0xe7", enhanceType: null });
        latestPng = renderPng();
        latestPngRev++;
        rememberRenderedFrame(`BSEBitBlt ${parsed.frame.bltType}`, parsed.frame.compressedLength, updates);
      } else {
        state.videoSettings.unsupportedBseFrames = (state.videoSettings.unsupportedBseFrames || 0) + 1;
        state.stats.lastEncoding = `BSEBitBlt ${parsed.frame.bltType} unsupported`;
        state.stats.lastEncodedBytes = parsed.frame.compressedLength;
        observeStream({ mode: "bse-unsupported", compression: "bse-rle", bseMode: parsed.frame.bltType, force8bpp: parsed.frame.bltType === 8 ? true : null, command: "0xe7", enhanceType: null });
      }
      sendSequenceAck(parsed.frame.sequence);
    } else if (cmd === 0xe6) {
      const parsed = readSetPaletteAt(rx, o);
      if (!parsed) { notePending(cmd, start); o = start; break; }
      for (const entry of parsed.entries) {
        palette[entry.index] = [entry.red, entry.green, entry.blue];
      }
      o = parsed.end;
      count(cmd);
    } else if (cmd === 0xea) {
      if (rx.length < o + 4) { notePending(cmd, start); o = start; break; }
      const prevX = textMode?.cursorX ?? -1;
      const prevY = textMode?.cursorY ?? -1;
      const tm = ensureTextMode();
      tm.cursorX = rx[o] & 0xff;
      tm.cursorY = rx[o + 1] & 0xff;
      tm.startLine = rx[o + 2] & 0xff;
      tm.stopLine = rx[o + 3] & 0xff;
      o += 4;
      count(cmd);
      if (state.bpp === 0) {
        if (prevX >= 0 && prevY >= 0) renderTextCell(tm, prevX, prevY);
        renderTextCell(tm, tm.cursorX, tm.cursorY);
        latestPng = renderPng();
        latestPngRev++;
      }
    } else if (cmd === 0xeb) {
      if (rx.length < o + 4) { o = start; break; }
      o += 4;
    } else if (cmd === 0xec) {
      const len = 256 + 64 * 48;
      if (rx.length < o + len) { o = start; break; }
      o += len;
    } else if (cmd === 0xef) {
      if (rx.length < o + 7) { o = start; break; }
      const reserved = rx.subarray(o, o + 3);
      o += 3;
      const seq = rx.readUInt32LE(o); o += 4;
      sendSequenceAck(seq, reserved);
    } else if (cmd === 0xc5) {
      if (rx.length < o + 8) { o = start; break; }
      const flags = rx.readUInt32LE(o);
      const user0Len = rx[o + 4] & 0xff;
      const user1Len = rx[o + 5] & 0xff;
      const len = 8 + user0Len + user1Len;
      if (rx.length < o + len) { o = start; break; }
      state.multiUserFlags = flags >>> 0;
      state.powerControlEnabled = !!(flags & 0x10000000);
      state.agentConnected = !!(flags & 0x04000000);
      state.powerOn = !!(flags & 0x08000000);
      o += len;
    } else if (cmd === 0x89) {
      const len = 16 + 2 + 2 + 7 + 5 + 512 + 512;
      if (rx.length < o + len) { o = start; break; }
      o += len;
    } else if (cmd === 0xd5) {
      if (rx.length < o + 3) { o = start; break; }
      o += 3;
    } else if (cmd === 0xe4) {
      if (rx.length < o + 15) { o = start; break; }
      o += 15;
    } else if (cmd === 0xe5) {
      // InformCPUUtilization: 6 x u32 (sspTicks, armTicks, cycleTicks, networkTicks, sspCycleTicks, referenceTime)
      if (rx.length < o + 24) { o = start; break; }
      o += 24;
    } else if (cmd === 0x40) {
      // OemLocalMonitorState: no payload (singleton)
    } else if (cmd === 0xc7) {
      // OemCurrentLocalMonitorState: 1-byte state
      if (rx.length < o + 1) { o = start; break; }
      o += 1;
    } else if (cmd === 0xc6) {
      // ServerDisconnect: u32 reason + u16 msgLen + msgLen bytes
      if (rx.length < o + 6) { o = start; break; }
      const msgLen = rx.readUInt16LE(o + 4);
      if (rx.length < o + 6 + msgLen) { o = start; break; }
      o += 6 + msgLen;
    } else if (cmd === 0xde) {
      // OemMsg: u32 length + length bytes
      if (rx.length < o + 4) { o = start; break; }
      const len = rx.readUInt32LE(o);
      if (rx.length < o + 4 + len) { o = start; break; }
      o += 4 + len;
    } else if (cmd === 0xf8) {
      // NativeMessage: u32 length + length bytes
      if (rx.length < o + 4) { o = start; break; }
      const len = rx.readUInt32LE(o);
      if (rx.length < o + 4 + len) { o = start; break; }
      o += 4 + len;
    } else {
      const ctxHex = rx.subarray(Math.max(0, start - 4), Math.min(rx.length, start + 12)).toString("hex");
      console.error(`[unknown-cmd] 0x${cmd.toString(16).padStart(2, "0")} at offset ${start} frames=${state.frames} context: ${ctxHex}`);
      logPacket("rx", rx.subarray(start, Math.min(rx.length, start + 1)), `offset=${start} incomplete-or-unknown`);
      rx = Buffer.alloc(0);
      break;
    }
    logPacket("rx", rx.subarray(start, o), `offset=${start}`);
  }
  if (o > 0) rx = rx.subarray(o);
}

function disconnect() {
  if (socket && !socket.destroyed) {
    send(command(0xd8, le32(1)));
    socket.destroy();
  }
  socket = null;
}

function connectIrmc(args) {
  disconnect();
  currentArgs = args;
  rx = Buffer.alloc(0);
  framebuffer = null;
  latestPng = null;
  latestPngRev = 0;
  handshakeSent = false;
  state.mouseAbsoluteModeSent = false;
  state.commands = {};
  state.frames = 0;
  state.bytesIn = 0;
  state.updateRects = [];
  state.stats = {
    bitrateKbps: 0,
    fps: 0,
    lastEncoding: "",
    lastEncodedBytes: 0,
    lastUpdates: 0,
    lastDecodeMs: 0,
    lastPngMs: 0,
    lastPngBytes: 0,
    frameIntervalMs: 0,
    recordingFrames: recording.length,
    enhanceTypes: {},
  };
  state.width = 0;
  state.height = 0;
  state.bpp = 32;
  state.mouseEnabled = ENABLE_MOUSE_BY_DEFAULT;
  state.mouseEvents = 0;
  state.mouseButtons = 0;
  state.observedStream = {
    mode: "unknown",
    compression: "unknown",
    bseMode: null,
    force8bpp: null,
    bpp: null,
    command: null,
    enhanceType: null,
    updatedAt: null,
  };
  byteSamples = [];
  frameTimes = [];

  const host = stripIpv6Brackets(args.ipaddress || HOST);
  const port = Number(args.VncPort || 80);
  setStatus("connecting", `${host}:${port}`);

  socket = net.connect({ host, port }, () => {
    state.connectedAt = new Date().toISOString();
    setStatus("connected", `${host}:${port}`);
    send(command(0xd2, Buffer.alloc(7)));
  });

  socket.on("data", (chunk) => {
    logRawPacket("rx", chunk);
    noteNetworkBytes(chunk.length);
    rx = Buffer.concat([rx, chunk]);
    try {
      consumeStream();
    } catch (err) {
      setStatus("decode-error", err.message);
      socket.destroy();
    }
  });
  socket.on("error", (err) => setStatus("socket-error", err.message));
  socket.on("close", () => {
    if (state.status !== "decode-error") setStatus("closed", "iRMC TCP socket closed");
  });

  socket.on("close", () => { /* no-op */ });
}

function loadArgs() {
  const fresh = fetchFreshJnlp();
  const file = fresh || findLatestJnlp();
  if (!file) throw new Error("no JNLP available; set IRMC_PASS with IRMC_HOST, or set IRMC_JNLP");
  return parseJnlp(file);
}

function pageHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>iRMC Live Viewer</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #111; color: #ececec; height: 100vh; display: grid; grid-template-rows: auto auto 1fr auto; }
    header { display: flex; align-items: center; gap: 10px; padding: 9px 12px; background: #1d1f22; border-bottom: 1px solid #33383f; }
    h1 { margin: 0; font-size: 15px; font-weight: 650; }
    .pill { font-size: 12px; padding: 3px 8px; border: 1px solid #48505a; border-radius: 999px; color: #cdd3db; }
    button { background: #2b3036; color: #f3f5f7; border: 1px solid #484f58; border-radius: 6px; padding: 7px 9px; font-weight: 650; cursor: pointer; min-width: 36px; }
    button:hover { background: #39414a; }
    button.primary { background: #2f6fed; border-color: #4e84f0; color: white; }
    button.danger { background: #7b2d2d; border-color: #9e4747; }
    button.wide { min-width: 72px; }
    .spacer { margin-left: auto; }
    .strip { display: flex; align-items: center; gap: 6px; padding: 7px 8px; background: #15181b; border-bottom: 1px solid #30363d; overflow-x: auto; }
    .group { display: flex; gap: 4px; padding-right: 6px; border-right: 1px solid #383f47; }
    .group:last-child { border-right: 0; }
    main { min-height: 0; display: grid; place-items: center; overflow: hidden; background: #050505; }
    canvas { max-width: 100%; max-height: 100%; image-rendering: auto; background: #000; cursor: crosshair; touch-action: none; }
    #debug { display: none; position: fixed; right: 10px; top: 58px; z-index: 10; width: min(360px, calc(100vw - 20px)); background: #1a1d21; border: 1px solid #3b424b; border-radius: 8px; box-shadow: 0 12px 32px rgba(0,0,0,.45); padding: 9px; }
    #debug.open { display: grid; gap: 8px; }
    #debug .line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    #debug label { font-size: 12px; color: #d6dbe1; display: flex; align-items: center; gap: 5px; }
    #debug input[type="color"] { width: 32px; height: 28px; padding: 0; border: 1px solid #555d67; border-radius: 5px; background: #22272e; }
    #debug select { background: #22272e; color: #f3f5f7; border: 1px solid #555d67; border-radius: 5px; height: 28px; }
    #statsText { margin: 0; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; color: #dce3ea; }
    #replayPos { font-size: 12px; color: #cdd3db; min-width: 72px; }
    #vk { display: none; background: #1a1d21; border-top: 1px solid #353c44; padding: 8px; }
    #vk.open { display: block; }
    .row { display: grid; gap: 5px; margin-bottom: 5px; grid-template-columns: repeat(15, minmax(34px, 1fr)); }
    .row:last-child { margin-bottom: 0; }
    .key { min-height: 34px; padding: 5px 6px; }
    .key[data-w="2"] { grid-column: span 2; }
    .key[data-w="3"] { grid-column: span 3; }
    .key[data-w="4"] { grid-column: span 4; }
    .key[data-w="5"] { grid-column: span 5; }
    @media (max-width: 760px) {
      header { flex-wrap: wrap; }
      .row { grid-template-columns: repeat(10, minmax(31px, 1fr)); }
      .key { min-height: 32px; font-size: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>iRMC Live Viewer</h1>
    <span id="status" class="pill">starting</span>
    <span id="size" class="pill">no video</span>
    <span id="frames" class="pill">0 frames</span>
    <span id="keys" class="pill">0 keys</span>
    <span id="mouse" class="pill">0 mouse</span>
    <span id="power" class="pill">Power: unknown</span>
    <button id="toggleDebug">Debug</button>
    <button id="toggleKeyboard" class="primary spacer">Keyboard</button>
    <button id="reconnect">Reconnect</button>
  </header>
  <nav class="strip" aria-label="Console keys">
    <div class="group" id="fkeys"></div>
    <div class="group">
      <button data-key="esc">Esc</button>
      <button data-combo="ctrl-alt-del" class="danger wide">Ctrl Alt Del</button>
      <button data-key="tab">Tab</button>
      <button data-key="enter">Enter</button>
    </div>
    <div class="group">
      <button data-key="ins">Ins</button>
      <button data-key="del">Del</button>
      <button data-key="home">Home</button>
      <button data-key="end">End</button>
      <button data-key="pgup">PgUp</button>
      <button data-key="pgdn">PgDn</button>
    </div>
    <div class="group">
      <button data-key="up">Up</button>
      <button data-key="left">Left</button>
      <button data-key="down">Down</button>
      <button data-key="right">Right</button>
    </div>
    <div class="group">
      <button data-power="button">Power Btn</button>
      <button data-power="on">On</button>
      <button data-power="reboot" class="danger">Reboot</button>
      <button data-power="reset" class="danger">Reset</button>
      <button data-power="off" class="danger">Off</button>
      <button data-power="cycle" class="danger">Cycle</button>
    </div>
  </nav>
  <main><canvas id="screen" width="1024" height="768"></canvas></main>
  <aside id="debug" aria-label="Debug tools">
    <div class="line">
      <label><input id="showUpdates" type="checkbox"> Updates</label>
      <label title="Experimental. Disabled by default because high-rate mouse movement can stop video on tested firmware."><input id="enableMouse" type="checkbox"> Mouse</label>
      <label>Color <input id="updateColor" type="color" value="#ff2020"></label>
      <label>Border <select id="updateBorder"><option value="scaled">scaled</option><option value="1">1px</option></select></label>
      <button id="startReplay">Replay</button>
      <button id="stopReplay">Live</button>
    </div>
    <div class="line">
      <button id="prevReplay">Prev</button>
      <button id="nextReplay">Next</button>
      <button id="clearRecording">Clear</button>
      <span id="replayPos">live</span>
    </div>
    <div class="line">
      <label title="On means HLC compressed enhance frames. Off means raw enhance frames and can use much more bandwidth."><input id="hardwareCompression" type="checkbox"> HLC compression</label>
      <label title="Experimental applet mode; observed to stop the stream on tested firmware. Prefer BSE 3 bpp or 8 bpp."><input id="force8bpp" type="checkbox"> Force 8bpp (experimental)</label>
    </div>
    <div class="line">
      <label>Low Bandwidth
        <select id="bseMode">
          <option value="0">None</option>
          <option value="1">3 bpp</option>
          <option value="2">8 bpp</option>
        </select>
      </label>
      <button id="applyVideoSettings">Apply Video</button>
      <button id="probeHardwareCompression">Probe HW</button>
      <button id="probeBse3">Probe 3bpp</button>
      <button id="probeBse8">Probe 8bpp</button>
    </div>
    <div class="line"><span id="probeResult">probe: idle</span></div>
    <pre id="statsText"></pre>
  </aside>
  <section id="vk" aria-label="Virtual keyboard"></section>
  <script>
    const canvas = document.getElementById("screen");
    const ctx = canvas.getContext("2d");
    const img = new Image();
    let rev = -1;
    let latestState = null;
    let replayMode = false;
    let replayFrames = [];
    let replayIndex = 0;
    let replayTimer = null;
    let replayMeta = null;
    let imageLoadStarted = 0;
    let browserImageMs = 0;
    let browserDrawMs = 0;
    const dirtyVideoSettings = new Set();
    const allowRawEnhanceByDefault = ${ALLOW_RAW_ENHANCE_BY_DEFAULT ? "true" : "false"};
    const allowExperimentalForce8 = ${ALLOW_EXPERIMENTAL_FORCE8 ? "true" : "false"};
    let mouseInFlight = false;
    let pendingMouse = null;
    let mouseFlushTimer = null;
    let lastMouseSentAt = 0;
    let lastMouseKey = "";
    const HID = {
      a:4,b:5,c:6,d:7,e:8,f:9,g:10,h:11,i:12,j:13,k:14,l:15,m:16,n:17,o:18,p:19,q:20,r:21,s:22,t:23,u:24,v:25,w:26,x:27,y:28,z:29,
      "1":30,"2":31,"3":32,"4":33,"5":34,"6":35,"7":36,"8":37,"9":38,"0":39,
      enter:40,esc:41,backspace:42,tab:43,space:44,minus:45,equal:46,lbracket:47,rbracket:48,backslash:49,semicolon:51,quote:52,grave:53,comma:54,dot:55,slash:56,
      caps:57,f1:58,f2:59,f3:60,f4:61,f5:62,f6:63,f7:64,f8:65,f9:66,f10:67,f11:68,f12:69,prtsc:70,scroll:71,pause:72,
      ins:73,home:74,pgup:75,del:76,end:77,pgdn:78,right:79,left:80,down:81,up:82,
      lctrl:224,lshift:225,lalt:226,lgui:227,rctrl:228,rshift:229,ralt:230,rgui:231
    };
    const codeToKey = {
      Escape:"esc",Backquote:"grave",Digit1:"1",Digit2:"2",Digit3:"3",Digit4:"4",Digit5:"5",Digit6:"6",Digit7:"7",Digit8:"8",Digit9:"9",Digit0:"0",Minus:"minus",Equal:"equal",Backspace:"backspace",
      Tab:"tab",KeyQ:"q",KeyW:"w",KeyE:"e",KeyR:"r",KeyT:"t",KeyY:"y",KeyU:"u",KeyI:"i",KeyO:"o",KeyP:"p",BracketLeft:"lbracket",BracketRight:"rbracket",Backslash:"backslash",
      CapsLock:"caps",KeyA:"a",KeyS:"s",KeyD:"d",KeyF:"f",KeyG:"g",KeyH:"h",KeyJ:"j",KeyK:"k",KeyL:"l",Semicolon:"semicolon",Quote:"quote",Enter:"enter",
      ShiftLeft:"lshift",KeyZ:"z",KeyX:"x",KeyC:"c",KeyV:"v",KeyB:"b",KeyN:"n",KeyM:"m",Comma:"comma",Period:"dot",Slash:"slash",ShiftRight:"rshift",
      ControlLeft:"lctrl",AltLeft:"lalt",MetaLeft:"lgui",Space:"space",MetaRight:"rgui",AltRight:"ralt",ControlRight:"rctrl",
      Insert:"ins",Delete:"del",Home:"home",End:"end",PageUp:"pgup",PageDown:"pgdn",ArrowUp:"up",ArrowDown:"down",ArrowLeft:"left",ArrowRight:"right",
      F1:"f1",F2:"f2",F3:"f3",F4:"f4",F5:"f5",F6:"f6",F7:"f7",F8:"f8",F9:"f9",F10:"f10",F11:"f11",F12:"f12"
    };
    const shifted = { "!":["lshift","1"], "@":["lshift","2"], "#":["lshift","3"], "$":["lshift","4"], "%":["lshift","5"], "^":["lshift","6"], "&":["lshift","7"], "*":["lshift","8"], "(":["lshift","9"], ")":["lshift","0"], "_":["lshift","minus"], "+":["lshift","equal"], "{":["lshift","lbracket"], "}":["lshift","rbracket"], "|":["lshift","backslash"], ":":["lshift","semicolon"], '"':["lshift","quote"], "~":["lshift","grave"], "<":["lshift","comma"], ">":["lshift","dot"], "?":["lshift","slash"] };
    let lastMouseMoveSent = 0;

    function mousePoint(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.round((e.clientX - r.left) * canvas.width / Math.max(1, r.width)),
        y: Math.round((e.clientY - r.top) * canvas.height / Math.max(1, r.height)),
      };
    }
    function mouseButtons(e) {
      return (e.buttons & 1 ? 1 : 0) | (e.buttons & 2 ? 2 : 0) | (e.buttons & 4 ? 4 : 0);
    }
    function mouseIsEnabled() {
      return document.getElementById("enableMouse").checked;
    }
    async function flushMouse() {
      if (mouseInFlight || !pendingMouse) return;
      const event = pendingMouse;
      pendingMouse = null;
      mouseInFlight = true;
      try {
        await fetch("/mouse", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...event, allowMouse: true })
        });
      } finally {
        mouseInFlight = false;
        if (pendingMouse) setTimeout(flushMouse, 25);
      }
    }
    function queueMouse(event, minIntervalMs = 100) {
      if (!mouseIsEnabled()) return;
      const now = performance.now();
      const key = event.type + ":" + event.x + ":" + event.y + ":" + event.buttons + ":" + (event.wheel || 0);
      if (key === lastMouseKey && event.type === "move") return;
      if (event.type === "move" && now - lastMouseSentAt < minIntervalMs) {
        pendingMouse = event;
        if (!mouseFlushTimer) {
          mouseFlushTimer = setTimeout(() => {
            mouseFlushTimer = null;
            lastMouseSentAt = performance.now();
            lastMouseKey = pendingMouse ? (pendingMouse.type + ":" + pendingMouse.x + ":" + pendingMouse.y + ":" + pendingMouse.buttons + ":" + (pendingMouse.wheel || 0)) : lastMouseKey;
            flushMouse();
          }, Math.max(10, minIntervalMs - (now - lastMouseSentAt)));
        }
        return;
      }
      lastMouseSentAt = now;
      lastMouseKey = key;
      pendingMouse = event;
      flushMouse();
    }
    function sendMouse(type, e, extra = {}) {
      const p = mousePoint(e);
      queueMouse({ type, x: p.x, y: p.y, buttons: mouseButtons(e), ...extra }, e.buttons ? 50 : 125);
    }

    async function sendHids(hids) {
      await fetch("/key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hids }) });
    }
    function tap(name) {
      if (HID[name]) sendHids([HID[name]]);
    }
    function combo(names) {
      sendHids(names.map(n => HID[n]).filter(Boolean));
    }
    async function power(action, label) {
      const name = label || action;
      if (!confirm("Send iRMC power action: " + name + "?")) return;
      await fetch("/power", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    }
    async function applyVideoSettings() {
      const next = {
        hardwareCompression: document.getElementById("hardwareCompression").checked,
        force8bpp: document.getElementById("force8bpp").checked,
        bseMode: Number(document.getElementById("bseMode").value),
      };
      const patch = {};
      if (dirtyVideoSettings.has("hardwareCompression")) patch.hardwareCompression = next.hardwareCompression;
      if (dirtyVideoSettings.has("force8bpp")) patch.force8bpp = next.force8bpp;
      if (dirtyVideoSettings.has("bseMode")) patch.bseMode = next.bseMode;
      if (!Object.keys(patch).length) {
        dirtyVideoSettings.clear();
        document.getElementById("probeResult").textContent = "settings: no changes";
        return;
      }
      if (patch.hardwareCompression === false && !allowRawEnhanceByDefault) {
        const ok = confirm("Switch to raw enhance frames? This can greatly increase bandwidth and may make the BMC sluggish.");
        if (!ok) return;
        patch.allowRawEnhance = true;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "force8bpp") && !allowExperimentalForce8) {
        const ok = confirm("Force 8bpp/reduce-bandwidth has stopped the stream on tested firmware. Send f6 anyway?");
        if (!ok) return;
        patch.allowExperimentalForce8 = true;
      }
      await fetch("/video-settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      }).then(r => r.json()).then(result => {
        document.getElementById("probeResult").textContent = result.ok ? ("settings: applied " + Object.keys(patch).join(", ")) : ("settings error: " + result.error);
        if (result.ok) dirtyVideoSettings.clear();
      });
    }
    async function probeHardwareCompression() {
      const target = !document.getElementById("hardwareCompression").checked;
      const body = { name: "hardwareCompression", value: target, settleMs: 4500, restore: true };
      if (!target && !allowRawEnhanceByDefault) {
        const ok = confirm("Temporarily probe raw enhance frames? This can greatly increase bandwidth while the probe runs.");
        if (!ok) return;
        body.allowRawEnhance = true;
      }
      document.getElementById("probeResult").textContent = "probe: temporarily testing HLC compression -> " + target;
      const result = await fetch("/video-probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }).then(r => r.json());
      document.getElementById("probeResult").textContent = result.ok ? ("probe: " + result.probe.summary) : ("probe error: " + result.error);
      dirtyVideoSettings.clear();
    }
    async function probeBseMode(mode) {
      document.getElementById("probeResult").textContent = "probe: temporarily testing BSE " + mode;
      const result = await fetch("/video-probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "bseMode", value: mode, settleMs: 5500, restore: true })
      }).then(r => r.json());
      document.getElementById("probeResult").textContent = result.ok ? ("probe: " + result.probe.summary) : ("probe error: " + result.error);
      dirtyVideoSettings.clear();
    }
    function drawScreen() {
      const drawStarted = performance.now();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0);
      if (document.getElementById("showUpdates").checked) {
        const rects = replayMode ? (replayMeta?.updates || []) : (latestState?.updateRects || []);
        if (rects.length) {
          ctx.save();
          ctx.strokeStyle = document.getElementById("updateColor").value || "#ff2020";
          const border = document.getElementById("updateBorder").value;
          ctx.lineWidth = border === "1" ? 1 : Math.max(1, Math.round(Math.min(canvas.width, canvas.height) / 300));
          for (const r of rects) ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.width - 1), Math.max(1, r.height - 1));
          ctx.restore();
        }
      }
      browserDrawMs = Math.round((performance.now() - drawStarted) * 10) / 10;
    }
    function updateStats(s) {
      const stats = s.stats || {};
      const observed = s.observedStream || {};
      const localMs = (stats.lastDecodeMs || 0) + (stats.lastPngMs || 0) + browserImageMs + browserDrawMs;
      let bottleneck = "unknown";
      if ((stats.frameIntervalMs || 0) > 0 && localMs > (stats.frameIntervalMs || 0) * 0.55) bottleneck = "viewer/local";
      else if ((stats.bitrateKbps || 0) < 250 && (stats.fps || 0) < 8) bottleneck = "iRMC/network";
      else if ((stats.lastUpdates || 0) > 80) bottleneck = "many small updates";
      else if ((stats.fps || 0) > 0) bottleneck = "probably iRMC pacing";
      document.getElementById("statsText").textContent = [
        "fps: " + (stats.fps || 0),
        "bitrate: " + (stats.bitrateKbps || 0) + " kbps",
        "encoding: " + (stats.lastEncoding || "unknown"),
        "observed mode: " + (observed.mode || "unknown"),
        "observed compression: " + (observed.compression || "unknown"),
        "observed bse: " + (observed.bseMode === null || observed.bseMode === undefined ? "none/unknown" : observed.bseMode),
        "observed force8: " + (observed.force8bpp === null || observed.force8bpp === undefined ? "unknown" : observed.force8bpp),
        "observed command: " + (observed.command || "unknown") + (observed.enhanceType === null || observed.enhanceType === undefined ? "" : " type " + observed.enhanceType),
        "enhance types: " + JSON.stringify(stats.enhanceTypes || {}),
        "pending: " + (stats.pendingCommand || "none"),
        "rx buffered: " + (stats.rxBuffered || 0) + " bytes",
        "encoded: " + (stats.lastEncodedBytes || 0) + " bytes",
        "updates: " + (stats.lastUpdates || 0),
        "frame interval: " + (stats.frameIntervalMs || 0) + " ms",
        "decode: " + (stats.lastDecodeMs || 0) + " ms",
        "png encode: " + (stats.lastPngMs || 0) + " ms",
        "png size: " + (stats.lastPngBytes || 0) + " bytes",
        "browser image: " + browserImageMs + " ms",
        "browser draw: " + browserDrawMs + " ms",
        "local total: " + Math.round(localMs * 10) / 10 + " ms",
        "likely: " + bottleneck,
        "frames: " + (s.frames || 0),
        "recording: " + (stats.recordingFrames || 0) + " frames",
        "bse skipped: " + ((s.videoSettings && s.videoSettings.unsupportedBseFrames) || 0),
        "last probe: " + ((s.videoSettings && s.videoSettings.probes && s.videoSettings.probes[0]?.summary) || "none"),
        "bytes in: " + (s.bytesIn || 0),
      ].join("\\n");
    }
    function setReplayPos() {
      document.getElementById("replayPos").textContent = replayMode && replayFrames.length ? (replayIndex + 1) + "/" + replayFrames.length : "live";
    }
    function showReplayFrame() {
      if (!replayFrames.length) return;
      replayIndex = Math.max(0, Math.min(replayIndex, replayFrames.length - 1));
      replayMeta = replayFrames[replayIndex];
      canvas.width = replayMeta.width;
      canvas.height = replayMeta.height;
      imageLoadStarted = performance.now();
      img.src = "/recording/frame.png?i=" + replayMeta.index + "&rev=" + replayMeta.rev;
      setReplayPos();
    }
    function pauseReplay() {
      if (replayTimer) clearInterval(replayTimer);
      replayTimer = null;
    }
    function playReplay() {
      pauseReplay();
      replayTimer = setInterval(() => {
        if (!replayMode || !replayFrames.length) { pauseReplay(); return; }
        if (replayIndex >= replayFrames.length - 1) { pauseReplay(); return; }
        replayIndex++;
        showReplayFrame();
      }, 140);
    }
    async function startReplay() {
      const r = await fetch("/recording.json", { cache: "no-store" }).then(resp => resp.json());
      replayFrames = r.frames || [];
      if (!replayFrames.length) return;
      replayMode = true;
      replayIndex = 0;
      showReplayFrame();
      playReplay();
    }
    function stopReplay() {
      replayMode = false;
      replayMeta = null;
      pauseReplay();
      rev = -1;
      setReplayPos();
      refreshState();
    }
    function button(label, key, extra = "") {
      return '<button class="key" data-key="' + key + '" ' + extra + '>' + label + '</button>';
    }
    function buildKeyboard() {
      const f = document.getElementById("fkeys");
      for (let i = 1; i <= 12; i++) f.insertAdjacentHTML("beforeend", '<button data-key="f' + i + '">F' + i + '</button>');
      const rows = [
        [["Esc","esc"],["&#96;","grave"],["1","1"],["2","2"],["3","3"],["4","4"],["5","5"],["6","6"],["7","7"],["8","8"],["9","9"],["0","0"],["-","minus"],["=","equal"],["Back","backspace","data-w='2'"]],
        [["Tab","tab","data-w='2'"],["Q","q"],["W","w"],["E","e"],["R","r"],["T","t"],["Y","y"],["U","u"],["I","i"],["O","o"],["P","p"],["[","lbracket"],["]","rbracket"],["\\\\","backslash"]],
        [["Caps","caps","data-w='2'"],["A","a"],["S","s"],["D","d"],["F","f"],["G","g"],["H","h"],["J","j"],["K","k"],["L","l"],[";","semicolon"],["'","quote"],["Enter","enter","data-w='2'"]],
        [["Shift","lshift","data-w='2'"],["Z","z"],["X","x"],["C","c"],["V","v"],["B","b"],["N","n"],["M","m"],[",","comma"],[".","dot"],["/","slash"],["Shift","rshift","data-w='2'"]],
        [["Ctrl","lctrl"],["Alt","lalt"],["Win","lgui"],["Space","space","data-w='5'"],["Alt","ralt"],["Ctrl","rctrl"],["Left","left"],["Up","up"],["Down","down"],["Right","right"]]
      ];
      document.getElementById("vk").innerHTML = rows.map(row => '<div class="row">' + row.map(k => button(k[0], k[1], k[2] || "")).join("") + '</div>').join("");
    }
    async function refreshState() {
      const wantsRects = document.getElementById("showUpdates").checked;
      const s = await fetch("/state.json?rects=" + (wantsRects ? "1" : "0"), { cache: "no-store" }).then(r => r.json());
      latestState = s;
      document.getElementById("status").textContent = s.status + (s.detail ? " · " + s.detail : "");
      document.getElementById("size").textContent = s.width ? s.width + "x" + s.height + " " + s.bpp + "bpp" : "no video";
      document.getElementById("frames").textContent = s.frames + " frames";
      document.getElementById("keys").textContent = (s.keyEvents || 0) + " keys";
      document.getElementById("mouse").textContent = (s.mouseEvents || 0) + " mouse";
      document.getElementById("enableMouse").checked = !!s.mouseEnabled;
      updateStats(s);
      if (s.videoSettings) {
        const hw = document.getElementById("hardwareCompression");
        if (!dirtyVideoSettings.has("hardwareCompression")) {
          hw.indeterminate = typeof s.videoSettings.hardwareCompression !== "boolean";
          if (typeof s.videoSettings.hardwareCompression === "boolean") hw.checked = s.videoSettings.hardwareCompression;
        }
        if (!dirtyVideoSettings.has("force8bpp")) document.getElementById("force8bpp").checked = !!s.videoSettings.force8bpp;
        if (!dirtyVideoSettings.has("bseMode")) document.getElementById("bseMode").value = String(s.videoSettings.bseMode || 0);
      }
      document.getElementById("force8bpp").title = allowExperimentalForce8 ? "Experimental; use carefully." : "Experimental and observed to stop the stream. A confirmation is required before sending f6.";
      const power = document.getElementById("power");
      if (s.powerControlEnabled === false) power.textContent = "Power: unavailable";
      else if (s.powerOn === true) power.textContent = "Power: on";
      else if (s.powerOn === false) power.textContent = "Power: off";
      else power.textContent = "Power: unknown";
      if (!replayMode && s.width && s.height && canvas.width !== s.width) { canvas.width = s.width; canvas.height = s.height; }
      if (!replayMode && s.rev !== rev) {
        rev = s.rev;
        imageLoadStarted = performance.now();
        img.src = "/frame.png?rev=" + rev;
      } else if (!replayMode) {
        drawScreen();
      }
    }
    img.onload = () => {
      browserImageMs = imageLoadStarted ? Math.round((performance.now() - imageLoadStarted) * 10) / 10 : 0;
      drawScreen();
    };
    document.getElementById("reconnect").onclick = () => fetch("/reconnect", { method: "POST" });
    document.getElementById("toggleKeyboard").onclick = () => document.getElementById("vk").classList.toggle("open");
    document.getElementById("toggleDebug").onclick = () => document.getElementById("debug").classList.toggle("open");
    document.getElementById("enableMouse").onchange = async (e) => {
      await fetch("/mouse/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: e.target.checked })
      });
      pendingMouse = null;
      lastMouseKey = "";
    };
    document.getElementById("showUpdates").onchange = drawScreen;
    document.getElementById("updateColor").oninput = drawScreen;
    document.getElementById("updateBorder").onchange = drawScreen;
    document.getElementById("startReplay").onclick = startReplay;
    document.getElementById("stopReplay").onclick = stopReplay;
    document.getElementById("prevReplay").onclick = () => { replayMode = true; pauseReplay(); replayIndex--; showReplayFrame(); };
    document.getElementById("nextReplay").onclick = () => { replayMode = true; pauseReplay(); replayIndex++; showReplayFrame(); };
    document.getElementById("clearRecording").onclick = async () => { await fetch("/recording/clear", { method: "POST" }); replayFrames = []; stopReplay(); };
    document.getElementById("applyVideoSettings").onclick = applyVideoSettings;
    document.getElementById("probeHardwareCompression").onclick = probeHardwareCompression;
    document.getElementById("probeBse3").onclick = () => probeBseMode(1);
    document.getElementById("probeBse8").onclick = () => probeBseMode(2);
    document.getElementById("hardwareCompression").onchange = () => { document.getElementById("hardwareCompression").indeterminate = false; dirtyVideoSettings.add("hardwareCompression"); };
    document.getElementById("force8bpp").onchange = () => { dirtyVideoSettings.add("force8bpp"); };
    document.getElementById("bseMode").onchange = () => { dirtyVideoSettings.add("bseMode"); };
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("pointerdown", e => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      sendMouse("button", e);
    });
    canvas.addEventListener("pointerup", e => {
      e.preventDefault();
      sendMouse("button", e);
    });
    canvas.addEventListener("pointermove", e => {
      if (!canvas.width || !canvas.height) return;
      const now = performance.now();
      if (now - lastMouseMoveSent < 20 && e.buttons === 0) return;
      lastMouseMoveSent = now;
      sendMouse(e.buttons ? "button" : "move", e);
    });
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const wheel = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      if (wheel) sendMouse("wheel", e, { wheel });
    }, { passive: false });
    document.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.combo === "ctrl-alt-del") combo(["lctrl", "lalt", "del"]);
      if (b.dataset.power) power(b.dataset.power, b.textContent.trim());
      if (b.dataset.key) tap(b.dataset.key);
    });
    document.addEventListener("keydown", e => {
      if (e.repeat) return;
      if (e.ctrlKey && e.altKey && e.code === "Delete") { e.preventDefault(); combo(["lctrl", "lalt", "del"]); return; }
      const name = codeToKey[e.code];
      if (name && HID[name]) { e.preventDefault(); sendHids([HID[name]]); return; }
      if (e.key && shifted[e.key]) { e.preventDefault(); combo(shifted[e.key]); }
      else if (e.key && e.key.length === 1) {
        const lower = e.key.toLowerCase();
        if (HID[lower]) { e.preventDefault(); e.key === lower ? tap(lower) : combo(["lshift", lower]); }
      }
    });
    buildKeyboard();
    async function liveLoop() {
      try { await refreshState(); }
      finally { setTimeout(liveLoop, replayMode ? 250 : 75); }
    }
    liveLoop();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pageHtml());
  } else if (req.url.startsWith("/state.json")) {
    const url = new URL(req.url, "http://127.0.0.1");
    const includeRects = url.searchParams.get("rects") !== "0";
    const payload = includeRects ? { ...state, rev: latestPngRev } : { ...state, updateRects: [], rev: latestPngRev };
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  } else if (req.url.startsWith("/frame.png")) {
    if (!latestPng) latestPng = renderPng();
    if (!latestPng) {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(latestPng);
    }
  } else if (req.url.startsWith("/recording.json")) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      limit: RECORDING_LIMIT,
      frames: recording.map((frame, index) => ({
        index,
        rev: frame.rev,
        t: frame.t,
        width: frame.width,
        height: frame.height,
        bpp: frame.bpp,
        encoding: frame.encoding,
        encodedBytes: frame.encodedBytes,
        updates: frame.updates,
      })),
    }));
  } else if (req.url.startsWith("/recording/frame.png")) {
    const url = new URL(req.url, "http://127.0.0.1");
    const index = Number(url.searchParams.get("i"));
    const frame = Number.isInteger(index) ? recording[index] : null;
    if (!frame) {
      res.writeHead(404);
      res.end("not found\n");
    } else {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(frame.png);
    }
  } else if (req.url.startsWith("/recording/clear") && req.method === "POST") {
    recording = [];
    state.stats.recordingFrames = 0;
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.url.startsWith("/reconnect") && req.method === "POST") {
    res.writeHead(202);
    res.end("reconnecting\n");
    setImmediate(() => {
      try { connectIrmc(loadArgs()); } catch (err) { setStatus("error", err.message); }
    });
  } else if (req.url.startsWith("/key") && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.hids)) throw new Error("expected hids array");
      sendKeyCombo(body.hids);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, keyEvents: state.keyEvents || 0 }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  } else if (req.url.startsWith("/mouse/enable") && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      state.mouseEnabled = !!body.enabled;
      if (!state.mouseEnabled) {
        state.mouseAbsoluteModeSent = false;
        state.mouseButtons = 0;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mouseEnabled: state.mouseEnabled }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  } else if (req.url.startsWith("/mouse") && req.method === "POST") {
    try {
      if (!state.mouseEnabled) throw new Error("mouse input is disabled");
      const body = await readJsonBody(req);
      if (body.allowMouse !== true && !ENABLE_MOUSE_BY_DEFAULT) throw new Error("mouse input requires allowMouse=true");
      const type = String(body.type || "move");
      const x = Number(body.x);
      const y = Number(body.y);
      const buttons = Number(body.buttons || 0) & 7;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("expected numeric x/y");
      if (type === "move") sendMouseMove(x, y);
      else if (type === "button") sendMouseButtonState(x, y, buttons, 0);
      else if (type === "wheel") sendMouseButtonState(x, y, buttons, Number(body.wheel || 0));
      else throw new Error(`unknown mouse event type: ${type}`);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mouseEvents: state.mouseEvents || 0, x: state.mouseX, y: state.mouseY, buttons: state.mouseButtons || 0 }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  } else if (req.url.startsWith("/power") && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (typeof body.action !== "string") throw new Error("expected action string");
      sendPowerAction(body.action);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, action: body.action, powerActions: state.powerActions || 0 }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  } else if (req.url.startsWith("/video-settings") && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const changed = sendVideoSettings(body);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, changed, videoSettings: state.videoSettings }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  } else if (req.url.startsWith("/video-probe") && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (typeof body.name !== "string") throw new Error("expected probe setting name");
      const before = snapshotVideoState();
      sendVideoSettings({ [body.name]: body.value, allowRawEnhance: body.allowRawEnhance === true });
      await sleep(Math.max(1000, Math.min(10000, Number(body.settleMs || 4500))));
      const after = snapshotVideoState();
      const probe = summarizeProbe(body.name, body.value, before, after);
      if (body.restore !== false && Object.prototype.hasOwnProperty.call(before.videoSettings || {}, body.name)) {
        sendVideoSettings({
          [body.name]: before.videoSettings[body.name],
          allowRawEnhance: body.name === "hardwareCompression" && before.videoSettings[body.name] === false,
        });
        probe.restored = true;
      }
      state.videoSettings.probes = [probe, ...(state.videoSettings.probes || [])].slice(0, 8);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, probe }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  } else {
    res.writeHead(404);
    res.end("not found\n");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`viewer: http://127.0.0.1:${PORT}`);
  try {
    connectIrmc(loadArgs());
  } catch (err) {
    setStatus("error", err.message);
  }
});

process.on("SIGINT", () => {
  disconnect();
  server.close(() => process.exit(0));
});
