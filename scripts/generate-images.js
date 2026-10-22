'use strict';

/*
 * Generates the PNG images Homey requires (no dependencies).
 * Run once after cloning: `npm run images`.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WATER_TOP = [64, 170, 222];
const WATER_BOTTOM = [10, 92, 150];
const WHITE = [255, 255, 255];
const TILE = [232, 244, 251];

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function mix(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

/** Is (x, y) in unit coordinates on one of the white wave bands? */
function onWave(x, y) {
  for (const base of [0.52, 0.68]) {
    const centre = base + 0.035 * Math.sin(x * Math.PI * 4);
    if (Math.abs(y - centre) < 0.03) return true;
  }
  return false;
}

/** Pool ladder: two rails with rounded tops and two rungs. */
function onLadder(x, y) {
  const railW = 0.035;
  for (const rx of [0.4, 0.6]) {
    if (Math.abs(x - rx) < railW / 2 && y > 0.2 && y < 0.46) return true;
    // rounded top bending outward
    const cx = rx - 0.05;
    const d = Math.hypot(x - cx, y - 0.2);
    if (y < 0.2 && x > cx && Math.abs(d - 0.05) < railW / 2) return true;
  }
  for (const ry of [0.29, 0.38]) {
    if (y > ry - 0.014 && y < ry + 0.014 && x > 0.4 && x < 0.6) return true;
  }
  return false;
}

/**
 * @param {number} w width
 * @param {number} h height
 * @param {boolean} square driver image (rounded tile on white) vs app image
 */
function render(w, h, square) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const r = 0.2;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let ux = (x + 0.5) / w;
      const uy = (y + 0.5) / h;
      let color;
      if (square) {
        // rounded square tile
        const dx = Math.max(0, Math.abs(ux - 0.5) - (0.5 - r));
        const dy = Math.max(0, Math.abs(uy - 0.5) - (0.5 - r));
        if (Math.hypot(dx, dy) > r) color = WHITE;
      } else {
        // keep the artwork proportional and centred on a wide image
        ux = 0.5 + (ux - 0.5) * (w / h);
      }
      if (!color) {
        color = mix(WATER_TOP, WATER_BOTTOM, uy);
        if (onLadder(ux, uy)) color = TILE;
        if (uy > 0.44 && onWave(ux, uy)) color = WHITE;
      }
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = color[0];
      raw[o + 1] = color[1];
      raw[o + 2] = color[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(file, w, h, square) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(w, h, square));
  console.log('wrote', path.relative(process.cwd(), file), `${w}x${h}`);
}

const root = path.join(__dirname, '..');
write(path.join(root, 'assets/images/small.png'), 250, 175, false);
write(path.join(root, 'assets/images/large.png'), 500, 350, false);
write(path.join(root, 'assets/images/xlarge.png'), 1000, 700, false);
for (const dir of fs.readdirSync(path.join(root, 'drivers'))) {
  const images = path.join(root, 'drivers', dir, 'assets/images');
  write(path.join(images, 'small.png'), 75, 75, true);
  write(path.join(images, 'large.png'), 500, 500, true);
  write(path.join(images, 'xlarge.png'), 1000, 1000, true);
}
