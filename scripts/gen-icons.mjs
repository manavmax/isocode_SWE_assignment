import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

/** Deterministic solid-color app icons (SPEC: "simple generated icons").
 * Pure Node PNG encoder: 8-bit RGB, filter 0, one IDAT chunk. */

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** teal #0f5f5c background, white rounded glyph square in the middle */
function pixelAt(x, y, size) {
  const pad = size * 0.08;
  const half = size / 2;
  const glyphHalf = size * 0.22;
  const radius = size * 0.06;
  const inGlyphX = Math.abs(x - half) <= glyphHalf;
  const inGlyphY = Math.abs(y - half) <= glyphHalf;
  const dx = Math.max(Math.abs(x - half) - (glyphHalf - radius), 0);
  const dy = Math.max(Math.abs(y - half) - (glyphHalf - radius), 0);
  const rounded = dx * dx + dy * dy <= radius * radius;
  if (inGlyphX && inGlyphY && (radius <= 0 ? true : rounded) && x > pad && y > pad) {
    return [255, 255, 255];
  }
  return [0x0f, 0x5f, 0x5c];
}

function makePng(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y, size);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync('public', { recursive: true });
writeFileSync('public/pwa-192.png', makePng(192));
writeFileSync('public/pwa-512.png', makePng(512));
console.log('icons: public/pwa-192.png, public/pwa-512.png written');
