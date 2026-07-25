#!/usr/bin/env node
/**
 * Generate placeholder Vodou Bridge icons at 16/48/128.
 * Pure Node — no deps. Outputs PNGs of a solid Vodou-red square.
 * Replace with real icons before Web Store submission.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VODOU_RED = { r: 0xb3, g: 0x1b, b: 0x1b };

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size, color) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Build raw pixel data: filter byte (0) + RGB per pixel per row
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0; // None filter
    for (let x = 0; x < size; x++) {
      const off = y * rowBytes + 1 + x * 3;
      raw[off] = color.r;
      raw[off + 1] = color.g;
      raw[off + 2] = color.b;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 48, 128]) {
  const png = makePng(size, VODOU_RED);
  const path = join(__dirname, 'icons', `icon${size}.png`);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes)`);
}
