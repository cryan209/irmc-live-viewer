#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

if (process.argv.length !== 4) {
  console.error("usage: irmc-extract-pcap-streams.js capture.pcap output-dir");
  process.exit(2);
}

const pcapPath = process.argv[2];
const outDir = process.argv[3];
const buf = fs.readFileSync(pcapPath);
fs.mkdirSync(outDir, { recursive: true });

if (buf.length < 24) throw new Error("pcap too short");
const magic = buf.readUInt32LE(0);
const le = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d;
const ns = magic === 0xa1b23c4d || magic === 0x4d3cb2a1;
if (!le && magic !== 0xd4c3b2a1 && magic !== 0x4d3cb2a1) {
  throw new Error(`unsupported pcap magic 0x${magic.toString(16)}`);
}

const read32 = (b, off) => le ? b.readUInt32LE(off) : b.readUInt32BE(off);
const read16 = (b, off) => le ? b.readUInt16LE(off) : b.readUInt16BE(off);
const linktype = read32(buf, 20);
if (linktype !== 1) throw new Error(`only Ethernet pcap is supported, got linktype ${linktype}`);

const ip4 = (b, off) => `${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`;
const flows = new Map();

function getFlow(src, sport, dst, dport) {
  const endpoints = [`${src}:${sport}`, `${dst}:${dport}`].sort();
  const key = `${endpoints[0]}__${endpoints[1]}`;
  if (!flows.has(key)) {
    flows.set(key, {
      key,
      endpoints,
      dirs: new Map(),
      packets: 0,
      bytes: 0,
    });
  }
  const flow = flows.get(key);
  const dirKey = `${src}:${sport}->${dst}:${dport}`;
  if (!flow.dirs.has(dirKey)) flow.dirs.set(dirKey, []);
  return { flow, dirKey };
}

let off = 24;
while (off + 16 <= buf.length) {
  const tsSec = read32(buf, off);
  const tsFrac = read32(buf, off + 4);
  const inclLen = read32(buf, off + 8);
  const origLen = read32(buf, off + 12);
  off += 16;
  if (off + inclLen > buf.length) break;
  const pkt = buf.subarray(off, off + inclLen);
  off += inclLen;

  if (pkt.length < 14) continue;
  const etherType = pkt.readUInt16BE(12);
  if (etherType !== 0x0800) continue;

  const ipOff = 14;
  if (pkt.length < ipOff + 20) continue;
  const version = pkt[ipOff] >> 4;
  const ihl = (pkt[ipOff] & 0x0f) * 4;
  if (version !== 4 || ihl < 20) continue;
  const proto = pkt[ipOff + 9];
  if (proto !== 6) continue;

  const totalLen = pkt.readUInt16BE(ipOff + 2);
  const src = ip4(pkt, ipOff + 12);
  const dst = ip4(pkt, ipOff + 16);
  const tcpOff = ipOff + ihl;
  if (pkt.length < tcpOff + 20) continue;
  const sport = pkt.readUInt16BE(tcpOff);
  const dport = pkt.readUInt16BE(tcpOff + 2);
  const seq = pkt.readUInt32BE(tcpOff + 4);
  const dataOffset = (pkt[tcpOff + 12] >> 4) * 4;
  const payloadOff = tcpOff + dataOffset;
  const ipPayloadEnd = Math.min(pkt.length, ipOff + totalLen);
  if (payloadOff > ipPayloadEnd) continue;
  const payload = pkt.subarray(payloadOff, ipPayloadEnd);
  if (payload.length === 0) continue;

  const { flow, dirKey } = getFlow(src, sport, dst, dport);
  flow.packets += 1;
  flow.bytes += payload.length;
  flow.dirs.get(dirKey).push({
    seq,
    payload: Buffer.from(payload),
    t: tsSec + tsFrac / (ns ? 1e9 : 1e6),
    origLen,
  });
}

function sanitize(s) {
  return s.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function reassemble(chunks) {
  chunks.sort((a, b) => a.seq - b.seq || a.t - b.t);
  if (chunks.length === 0) return Buffer.alloc(0);
  let base = chunks[0].seq;
  let end = 0;
  for (const c of chunks) {
    const rel = (c.seq - base) >>> 0;
    end = Math.max(end, rel + c.payload.length);
  }
  const out = Buffer.alloc(end);
  const filled = Buffer.alloc(end);
  for (const c of chunks) {
    const rel = (c.seq - base) >>> 0;
    for (let i = 0; i < c.payload.length; i++) {
      const pos = rel + i;
      if (pos < out.length && !filled[pos]) {
        out[pos] = c.payload[i];
        filled[pos] = 1;
      }
    }
  }
  return out;
}

const summary = [];
for (const flow of [...flows.values()].sort((a, b) => b.bytes - a.bytes)) {
  const flowDir = path.join(outDir, sanitize(flow.key));
  fs.mkdirSync(flowDir, { recursive: true });
  const item = { flow: flow.key, packets: flow.packets, bytes: flow.bytes, directions: [] };
  for (const [dirKey, chunks] of flow.dirs.entries()) {
    const data = reassemble(chunks);
    const name = sanitize(dirKey) + ".bin";
    fs.writeFileSync(path.join(flowDir, name), data);
    const preview = data.subarray(0, 96).toString("latin1").replace(/[^\x20-\x7e]/g, ".");
    item.directions.push({ direction: dirKey, chunks: chunks.length, bytes: data.length, file: path.join(flowDir, name), preview });
  }
  summary.push(item);
}

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`extracted ${summary.length} TCP flows to ${outDir}`);
for (const flow of summary.slice(0, 12)) {
  console.log(`${flow.bytes.toString().padStart(8)} bytes  ${flow.flow}`);
  for (const d of flow.directions) {
    console.log(`  ${d.bytes.toString().padStart(8)} ${d.direction}  ${d.preview}`);
  }
}
