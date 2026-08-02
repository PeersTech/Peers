// Generates src-tauri/icons (PNG + ICO + ICNS) from a procedural logo:
// two "peer" nodes connected on a dark rounded tile. Pure Node, no deps.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'backend', 'icons');
mkdirSync(OUT, { recursive: true });

const SIZE = 1024;
// RGBA float buffer
const buf = new Float32Array(SIZE * SIZE * 4);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (d) => clamp(0.5 - d, 0, 1);

// Signed distance to a rounded rect centered on origin.
function sdRoundRect(x, y, hw, hh, r) {
  const qx = Math.abs(x) - (hw - r);
  const qy = Math.abs(y) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
// Signed distance to a segment.
function sdSegment(x, y, ax, ay, bx, by) {
  const pax = x - ax, pay = y - ay;
  const bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

const PURPLE = [0x58, 0x65, 0xf2];
const GREEN = [0x3b, 0xa5, 0x5d];
const LINE = [0x8b, 0x97, 0xff];

const sx = SIZE / 2;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const nx = (x - sx) / sx; // -1..1
    const ny = (y - sx) / sx;

    // Tile: rounded square, subtle vertical gradient.
    const dTile = sdRoundRect(nx, ny, 0.96, 0.96, 0.22);
    const tileA = smooth(dTile * 4); // 0.25px AA at these coords
    const t = (ny + 1) / 2;
    let r = 0x20 + (0x28 - 0x20) * t;
    let g = 0x21 + (0x29 - 0x21) * t;
    let b = 0x24 + (0x2c - 0x24) * t;

    // Connection line between the two nodes.
    const dLine = sdSegment(nx, ny, -0.34, 0, 0.34, 0) - 0.05;
    const lineA = smooth(dLine * 4);
    r = r + (LINE[0] - r) * lineA;
    g = g + (LINE[1] - g) * lineA;
    b = b + (LINE[2] - b) * lineA;

    // Left node (purple), right node (green).
    const dL = Math.hypot(nx + 0.34, ny) - 0.155;
    const dR = Math.hypot(nx - 0.34, ny) - 0.155;
    const aL = smooth(dL * 4);
    const aR = smooth(dR * 4);
    r = r + (PURPLE[0] - r) * aL + (GREEN[0] - r) * aR;
    g = g + (PURPLE[1] - g) * aL + (GREEN[1] - g) * aR;
    b = b + (PURPLE[2] - b) * aL + (GREEN[2] - b) * aR;

    // Node "eye" highlight.
    const dLh = Math.hypot(nx + 0.34 - 0.05, ny - 0.05) - 0.05;
    const hL = smooth(dLh * 8);
    const dRh = Math.hypot(nx - 0.34 - 0.05, ny - 0.05) - 0.05;
    const hR = smooth(dRh * 8);
    r += 40 * (hL + hR);
    g += 40 * (hL + hR);
    b += 40 * (hL + hR);

    const a = clamp(tileA, 0, 1);
    buf[i] = clamp(r, 0, 255);
    buf[i + 1] = clamp(g, 0, 255);
    buf[i + 2] = clamp(b, 0, 255);
    buf[i + 3] = a * 255;
  }
}

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Box-filter downsample of the master buffer.
function down(size) {
  const step = SIZE / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * step);
      const y0 = Math.floor(y * step);
      const x1 = Math.min(SIZE, Math.ceil((x + 1) * step));
      const y1 = Math.min(SIZE, Math.ceil((y + 1) * step));
      let r = 0, g = 0, b = 0, a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * SIZE + xx) * 4;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
          a += buf[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

const pngs = new Map();
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  pngs.set(size, png(size, size, down(size)));
}

writeFileSync(join(OUT, '32x32.png'), pngs.get(32));
writeFileSync(join(OUT, '128x128.png'), pngs.get(128));
writeFileSync(join(OUT, '128x128@2x.png'), pngs.get(256));
writeFileSync(join(OUT, 'icon.png'), pngs.get(512));

// ---------- ICO (PNG-compressed entries) ----------
function ico(sizes) {
  const imgs = sizes.map((s) => pngs.get(s));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(imgs.length, 4);
  let offset = 6 + 16 * imgs.length;
  const entries = [];
  imgs.forEach((png, i) => {
    const e = Buffer.alloc(16);
    const s = sizes[i];
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e[4] = 1; // planes
    e[6] = 32; // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  });
  return Buffer.concat([header, ...entries, ...imgs]);
}
writeFileSync(join(OUT, 'icon.ico'), ico([16, 32, 48, 64, 256]));

// ---------- ICNS (PNG-compressed entries) ----------
function icns() {
  const entries = [
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ].map(([fourcc, size]) => {
    const p = pngs.get(size);
    const head = Buffer.alloc(8);
    head.write(fourcc, 0, 'ascii');
    head.writeUInt32BE(8 + p.length, 4);
    return Buffer.concat([head, p]);
  });
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}
writeFileSync(join(OUT, 'icon.icns'), icns());

console.log('icons written to', OUT);
