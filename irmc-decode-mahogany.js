#!/usr/bin/env node
const fs = require("fs");

if (process.argv.length !== 3) {
  console.error("usage: irmc-decode-mahogany.js server-to-client.bin");
  process.exit(2);
}

const b = fs.readFileSync(process.argv[2]);
let o = 0;

const names = {
  0x40: "OemLocalMonitorState",
  0x89: "StorageStatus",
  0xc5: "MultiUserState",
  0xc6: "ServerDisconnect",
  0xc7: "OemCurrentLocalMonitorState",
  0xc8: "ServerHandshake",
  0xc9: "FirmwareVersion",
  0xd5: "InformKeyIndicators",
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
  0xee: "GraphicsRegisterValue",
  0xef: "SequenceNumber",
  0xf8: "NativeMessage",
};

const counts = new Map();
const events = [];
const ssp = [];
const enhance = [];
const unknown = [];

function u8() { return b[o++]; }
function u16() { const v = b.readUInt16LE(o); o += 2; return v; }
function i16() { const v = b.readInt16LE(o); o += 2; return v; }
function u32() { const v = b.readUInt32LE(o); o += 4; return v; }
function ascii(start, len) { return b.subarray(start, start + len).toString("latin1").replace(/\0/g, ""); }
function add(cmd, start, info = {}) {
  counts.set(cmd, (counts.get(cmd) || 0) + 1);
  events.push({ off: start, cmd: `0x${cmd.toString(16).padStart(2, "0")}`, name: names[cmd] || "?", ...info });
}
function skip(n) {
  if (n < 0 || o + n > b.length) throw new Error(`bad skip ${n} at ${o}`);
  o += n;
}

function readCStringish(max) {
  const start = o;
  while (o < b.length && o - start < max && b[o] !== 0) o++;
  const out = ascii(start, o - start);
  while (o < b.length && o - start < max && b[o] === 0) o++;
  return out;
}

try {
  while (o < b.length) {
    const start = o;
    const cmd = u8();
    switch (cmd) {
      case 0xc8: {
        // ServerHandshake uses a fixed 32-byte version/signature string, then a large user/permission block.
        const sig = ascii(o, 32).trim();
        skip(32);
        // Stop at the next known FirmwareVersion command. This matches this firmware's initial handshake block.
        const next = b.indexOf(0xc9, o);
        if (next === -1) throw new Error("ServerHandshake: could not find following FirmwareVersion");
        const payloadLen = next - o;
        skip(payloadLen);
        add(cmd, start, { sig, payloadLen });
        break;
      }
      case 0xc9: {
        const len = u32();
        const text = ascii(o, len);
        skip(len);
        add(cmd, start, { len, text });
        break;
      }
      case 0xe1: {
        const mode = u16();
        const width = u16();
        const height = u16();
        const bpp = u16();
        add(cmd, start, { mode, width, height, bpp });
        break;
      }
      case 0xe5: {
        const sspTicks = u32();
        const armTicks = u32();
        const cycleTicks = u32();
        const networkTicks = u32();
        const sspCycleTicks = u32();
        const referenceTime = u32();
        add(cmd, start, { sspTicks, armTicks, cycleTicks, networkTicks, sspCycleTicks, referenceTime });
        break;
      }
      case 0xc5: {
        const flags = u32();
        const user0Len = u8();
        const user1Len = u8();
        const user0Flags = u8();
        const user1Flags = u8();
        const user0 = ascii(o, user0Len);
        skip(user0Len);
        const user1 = ascii(o, user1Len);
        skip(user1Len);
        add(cmd, start, { flags: `0x${flags.toString(16)}`, users: [{ name: user0, flags: user0Flags }, { name: user1, flags: user1Flags }] });
        break;
      }
      case 0x89: {
        const ip = [...b.subarray(o, o + 16)];
        skip(16);
        const shareIndex0 = u8();
        const shareIndex1 = u8();
        const port = u16();
        const path0Len = u8();
        const path1Len = u8();
        const shareType0 = u8();
        const shareType1 = u8();
        const shareStatus0 = u8();
        const shareStatus1 = u8();
        const ipType = u8();
        const reserved = b.subarray(o, o + 5).toString("hex");
        skip(5);
        const path0Bytes = b.subarray(o, o + 512);
        skip(512);
        const path1Bytes = b.subarray(o, o + 512);
        skip(512);
        const path0 = path0Bytes.subarray(0, path0Len * 2).toString("utf16le");
        const path1 = path1Bytes.subarray(0, path1Len * 2).toString("utf16le");
        add(cmd, start, { ip: ip.slice(0, 4).join("."), port, shareIndex0, shareIndex1, shareType0, shareType1, shareStatus0, shareStatus1, ipType, reserved, path0, path1 });
        break;
      }
      case 0xd5: {
        const capsLock = !!u8();
        const numLock = !!u8();
        const scrollLock = !!u8();
        add(cmd, start, { capsLock, numLock, scrollLock });
        break;
      }
      case 0xe4: {
        const padding = b.subarray(o, o + 15).toString("hex");
        skip(15);
        add(cmd, start, { padding });
        break;
      }
      case 0xef: {
        const reserved = b.subarray(o, o + 3).toString("hex");
        skip(3);
        const sequence = u32();
        add(cmd, start, { reserved, sequence });
        break;
      }
      case 0xed:
      case 0xe0: {
        const compressedLength = u32();
        const uncompressedLength = u32();
        const top = u8();
        const left = u8();
        const bottom = u8();
        const right = u8();
        const sequence = u32();
        const dataOff = o;
        skip(compressedLength);
        const item = {
          compressedLength,
          uncompressedLength,
          top,
          left,
          bottom,
          right,
          sequence,
          dataOff,
          firstBytes: b.subarray(dataOff, Math.min(dataOff + 8, dataOff + compressedLength)).toString("hex"),
        };
        ssp.push(item);
        add(cmd, start, item);
        break;
      }
      case 0xe3: {
        const bltType = u16();
        const tileWidth = u8();
        const tileHeight = u8();
        const tripletCode = u32();
        const repeatCode = u32();
        const rawSize = u32();
        const scrunchSize = u32();
        const snoopOff = o;
        skip(512);
        const dataOff = o;
        skip(scrunchSize);
        const item = { bltType, tileWidth, tileHeight, tripletCode, repeatCode, rawSize, scrunchSize, snoopOff, dataOff, firstBytes: b.subarray(dataOff, Math.min(dataOff + 8, dataOff + scrunchSize)).toString("hex") };
        enhance.push(item);
        add(cmd, start, item);
        break;
      }
      case 0xe2:
      case 0xe7: {
        const bltType = u16();
        const fontHeight = u8();
        const fontWidth = u8();
        const src = { x: i16(), y: i16(), w: i16(), h: i16() };
        const dst = { x: i16(), y: i16(), w: i16(), h: i16() };
        const dataSize = u32();
        const dataOff = o;
        skip(dataSize);
        add(cmd, start, { bltType, fontHeight, fontWidth, src, dst, dataSize, dataOff });
        break;
      }
      default:
        if (cmd === 0x00) {
          let zeros = 1;
          while (o < b.length && b[o] === 0x00) {
            o++;
            zeros++;
          }
          add(cmd, start, { paddingBytes: zeros });
          break;
        }
        unknown.push({ off: start, cmd });
        throw new Error(`unknown command 0x${cmd.toString(16)} at offset ${start}`);
    }
  }
} catch (err) {
  console.error(`stopped at offset ${o}: ${err.message}`);
}

console.log("== Command counts ==");
for (const [cmd, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`0x${cmd.toString(16).padStart(2, "0")} ${String(names[cmd] || "?").padEnd(24)} ${count}`);
}

console.log("\n== First events ==");
for (const e of events.slice(0, 40)) console.log(JSON.stringify(e));

console.log("\n== SSP stats ==");
if (ssp.length) {
  const totalC = ssp.reduce((n, x) => n + x.compressedLength, 0);
  const totalU = ssp.reduce((n, x) => n + x.uncompressedLength, 0);
  const maxC = Math.max(...ssp.map(x => x.compressedLength));
  const maxU = Math.max(...ssp.map(x => x.uncompressedLength));
  const firstBytes = [...new Set(ssp.slice(0, 100).map(x => x.firstBytes.slice(0, 4)))].slice(0, 20);
  console.log(JSON.stringify({ frames: ssp.length, totalCompressed: totalC, totalUncompressed: totalU, maxCompressed: maxC, maxUncompressed: maxU, firstBytePrefixes: firstBytes }, null, 2));
}

console.log("\n== EnhanceBitBlt stats ==");
if (enhance.length) {
  const totalScrunch = enhance.reduce((n, x) => n + x.scrunchSize, 0);
  const totalRaw = enhance.reduce((n, x) => n + x.rawSize, 0);
  const maxScrunch = Math.max(...enhance.map(x => x.scrunchSize));
  const maxRaw = Math.max(...enhance.map(x => x.rawSize));
  const byRawSize = {};
  const byBltType = {};
  for (const x of enhance) {
    byRawSize[x.rawSize] = (byRawSize[x.rawSize] || 0) + 1;
    byBltType[x.bltType] = (byBltType[x.bltType] || 0) + 1;
  }
  console.log(JSON.stringify({ frames: enhance.length, totalScrunch, totalRaw, maxScrunch, maxRaw, byRawSize, byBltType }, null, 2));
}

if (unknown.length) {
  console.log("\n== Unknown ==");
  for (const u of unknown.slice(0, 20)) console.log(JSON.stringify(u));
}
