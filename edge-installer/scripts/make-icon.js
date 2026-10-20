#!/usr/bin/env node
/**
 * make-icon.js
 * Generates a valid 256×256 ICO file containing a PNG image chunk.
 * Modern ICO files store PNG directly (Windows Vista+, all Electron versions).
 * No external dependencies — pure Node.js.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets', 'icons');
const ICO_OUT = path.join(OUT_DIR, 'icon.ico');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const W = 256, H = 256;

// ── Build a minimal PNG for 256×256 blue (#2563eb) square ─────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf    = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const crcInput  = Buffer.concat([typeBytes, data]);
  const crcBuf    = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8]  = 8;  // bit depth
ihdr[9]  = 2;  // color type: RGB
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// Raw pixel data: each row = filter byte (0) + RGB pixels
const rawRows = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const rowOff = y * (1 + W * 3);
  rawRows[rowOff] = 0; // filter = None
  for (let x = 0; x < W; x++) {
    const pOff = rowOff + 1 + x * 3;
    rawRows[pOff + 0] = 0x25; // R
    rawRows[pOff + 1] = 0x63; // G
    rawRows[pOff + 2] = 0xeb; // B
  }
}

const compressed = zlib.deflateSync(rawRows, { level: 1 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
  chunk('IHDR', ihdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0)),
]);

// ── Wrap PNG in ICO container ──────────────────────────────────────────────
// ICO header: 6 bytes
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0); // reserved
icoHeader.writeUInt16LE(1, 2); // type = 1 (ICO)
icoHeader.writeUInt16LE(1, 4); // 1 image

// Directory entry: 16 bytes
const dirEntry = Buffer.alloc(16);
dirEntry[0] = 0;           // width  (0 = 256)
dirEntry[1] = 0;           // height (0 = 256)
dirEntry[2] = 0;           // color count
dirEntry[3] = 0;           // reserved
dirEntry.writeUInt16LE(1,  4); // planes
dirEntry.writeUInt16LE(32, 6); // bit count (hint)
dirEntry.writeUInt32LE(png.length, 8);        // size of PNG data
dirEntry.writeUInt32LE(6 + 16,    12);        // offset = after header + 1 dir entry

const ico = Buffer.concat([icoHeader, dirEntry, png]);
fs.writeFileSync(ICO_OUT, ico);
console.log(`✓ icon.ico (PNG-in-ICO, 256×256) → ${ICO_OUT} (${ico.length} bytes)`);
