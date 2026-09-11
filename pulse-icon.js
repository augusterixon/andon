// Minimal, dependency-free PNG encoder + circle rasterizer.
// Renders a soft-shaded circle with a subtle drop shadow, closer to how
// Apple's circle emoji actually render (gradient + shadow, not flat fill).

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function over(src, dst) {
  const outA = src.a + dst.a * (1 - src.a);
  if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const r = (src.r * src.a + dst.r * dst.a * (1 - src.a)) / outA;
  const g = (src.g * src.a + dst.g * dst.a * (1 - src.a)) / outA;
  const b = (src.b * src.a + dst.b * dst.a * (1 - src.a)) / outA;
  return { r, g, b, a: outA };
}

function renderCirclePNG(size, topColor, bottomColor, globalAlpha) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.34;
  const edgeSoftness = 0.8;

  const shadowOffsetY = size * 0.05;
  const shadowRadius = radius * 1.05;
  const shadowSoftness = size * 0.12;
  const shadowMaxAlpha = 0.3;

  const rimWidth = radius * 0.18;

  const raw = Buffer.alloc(size * (1 + size * 4));
  let offset = 0;

  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const sdx = x + 0.5 - cx;
      const sdy = y + 0.5 - (cy + shadowOffsetY);
      const sDist = Math.sqrt(sdx * sdx + sdy * sdy);
      const shadowCoverage = 1 - clamp((sDist - (shadowRadius - shadowSoftness)) / shadowSoftness, 0, 1);
      const shadowPixel = { r: 0, g: 0, b: 0, a: shadowCoverage * shadowMaxAlpha * globalAlpha };

      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let coverage;
      if (dist <= radius - edgeSoftness) coverage = 1;
      else if (dist >= radius + edgeSoftness) coverage = 0;
      else coverage = 1 - (dist - (radius - edgeSoftness)) / (edgeSoftness * 2);

      const gradT = clamp((y - (cy - radius)) / (2 * radius), 0, 1);
      let r = lerp(topColor[0], bottomColor[0], gradT);
      let g = lerp(topColor[1], bottomColor[1], gradT);
      let b = lerp(topColor[2], bottomColor[2], gradT);

      const rimT = clamp((dist - (radius - rimWidth)) / rimWidth, 0, 1);
      r = lerp(r, r * 0.75, rimT);
      g = lerp(g, g * 0.75, rimT);
      b = lerp(b, b * 0.75, rimT);

      const circlePixel = { r, g, b, a: coverage * globalAlpha };

      const final = over(circlePixel, shadowPixel);

      raw[offset++] = Math.round(clamp(final.r, 0, 255));
      raw[offset++] = Math.round(clamp(final.g, 0, 255));
      raw[offset++] = Math.round(clamp(final.b, 0, 255));
      raw[offset++] = Math.round(clamp(final.a * 255, 0, 255));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { renderCirclePNG };