// Generates build/icon.icns — the "radar / signal" mark (concentric rings
// with a solid center dot), on white with near-black ink. Pure JS, no
// external tools needed.
//
// Run with: node build-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [255, 255, 255];
const INK = [26, 26, 26];

// --- PNG encoder ---
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(size, pixels) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixels[y * size + x];
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function strokeCircle(pixels, size, cx, cy, r, w, color) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (Math.abs(d - r) <= w / 2) pixels[y * size + x] = color;
    }
  }
}
function fillCircle(pixels, size, cx, cy, r, color) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d <= r) pixels[y * size + x] = color;
    }
  }
}

// Radar/signal mark — every dimension is a fraction of `size`, so it holds
// up correctly whether rendered at 16px or 1024px. ~15% safe margin from
// the edge on all sides.
function renderIcon(size) {
  const pixels = new Array(size * size).fill(BG);
  const cx = size / 2, cy = size / 2;
  strokeCircle(pixels, size, cx, cy, size * 0.32, size * 0.022, INK);
  strokeCircle(pixels, size, cx, cy, size * 0.20, size * 0.022, INK);
  fillCircle(pixels, size, cx, cy, size * 0.07, INK);
  return pixels;
}

// --- icns container ---
const ICON_SIZES = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'icp6', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
];

function buildIcns() {
  const chunks = [];
  for (const { type, size } of ICON_SIZES) {
    const png = encodePNG(size, renderIcon(size));
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(8 + png.length, 0);
    chunks.push(Buffer.concat([typeBuf, lenBuf, png]));
  }
  const body = Buffer.concat(chunks);
  const totalLength = 8 + body.length;
  const header = Buffer.concat([
    Buffer.from('icns', 'ascii'),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(totalLength, 0);
      return b;
    })(),
  ]);
  return Buffer.concat([header, body]);
}

const outDir = path.join(__dirname, 'build');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.icns'), buildIcns());
fs.writeFileSync(path.join(outDir, 'icon-1024.png'), encodePNG(1024, renderIcon(1024)));

console.log('Wrote build/icon.icns and build/icon-1024.png');