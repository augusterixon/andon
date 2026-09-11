// Generates build/icon.icns using the stacked-circles logo (horizontal
// orientation, leftmost circle in front). Pure JS, no external tools needed.
//
// Run with: node build-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [255, 255, 255];
const STROKE = [26, 26, 26];

// --- PNG encoder (RGB, no alpha needed — full-bleed background square) ---
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
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit depth, RGB (no alpha)
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Renders the 3-circle stacked logo at the given canvas size.
// Proportions locked to the approved preview: r/size ≈ 0.17, dx/size ≈ 0.20.
function renderLogoPNG(size) {
  const R = size * 0.17;
  const DX = size * 0.20;
  const strokeW = size * 0.0225;
  const cx = size / 2;
  const cy = size / 2;

  // Draw back-to-front: rightmost first, leftmost (front) last.
  const circles = [
    { cx: cx + DX, cy },
    { cx, cy },
    { cx: cx - DX, cy },
  ];

  const pixels = new Array(size * size).fill(BG);

  for (const c of circles) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dist = Math.sqrt((x - c.cx) ** 2 + (y - c.cy) ** 2);
        if (dist <= R + strokeW / 2) {
          const idx = y * size + x;
          pixels[idx] = Math.abs(dist - R) <= strokeW / 2 ? STROKE : BG;
        }
      }
    }
  }

  return encodePNG(size, pixels);
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
    const png = renderLogoPNG(size);
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

// Also drop a plain 1024 PNG alongside it — handy for anything that isn't
// specifically the macOS .icns format (README hero image, a website, etc).
fs.writeFileSync(path.join(outDir, 'icon-1024.png'), renderLogoPNG(1024));

console.log('Wrote build/icon.icns and build/icon-1024.png');
