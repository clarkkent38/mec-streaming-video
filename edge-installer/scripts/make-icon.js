#!/usr/bin/env node
/**
 * make-icon.js
 * Generates EdgeNest icon — dark background, glowing purple/blue network-nest
 * sphere with a white play triangle in the centre.
 *
 * Approach: write the design as an SVG, then rasterise it to a raw RGBA pixel
 * grid using a pure-JS SVG-to-pixels path tracer built into this file.
 * No native addons, no canvas, no puppeteer — just Node built-ins + zlib.
 *
 * Output:
 *   assets/icons/icon.ico   (256×256 PNG-in-ICO — works on all Windows versions)
 *   assets/icons/icon.png   (256×256 PNG — used by Electron for the tray / window)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets', 'icons');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const W = 256, H = 256;

// ── Pixel buffer (RGBA) ───────────────────────────────────────────────────────
const buf = Buffer.alloc(W * H * 4, 0); // start fully transparent

function setPixel(x, y, r, g, b, a) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  // Alpha-composite over existing pixel
  const ao = a / 255;
  const ai = buf[i + 3] / 255;
  const af = ao + ai * (1 - ao);
  if (af === 0) return;
  buf[i]     = Math.round((r * ao + buf[i]     * ai * (1 - ao)) / af);
  buf[i + 1] = Math.round((g * ao + buf[i + 1] * ai * (1 - ao)) / af);
  buf[i + 2] = Math.round((b * ao + buf[i + 2] * ai * (1 - ao)) / af);
  buf[i + 3] = Math.round(af * 255);
}

// Anti-aliased pixel (fractional coverage)
function setAA(x, y, r, g, b, alpha) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const cover = [
    [(1 - fx) * (1 - fy), x0,     y0    ],
    [fx       * (1 - fy), x0 + 1, y0    ],
    [(1 - fx) * fy,       x0,     y0 + 1],
    [fx       * fy,       x0 + 1, y0 + 1],
  ];
  for (const [w, px, py] of cover) {
    setPixel(px, py, r, g, b, Math.round(alpha * w));
  }
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function fillCircle(cx, cy, radius, r, g, b, a) {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d < radius - 0.5) {
        setPixel(x, y, r, g, b, a);
      } else if (d < radius + 0.5) {
        const aa = Math.round((radius + 0.5 - d) * a);
        setPixel(x, y, r, g, b, aa);
      }
    }
  }
}

function strokeCircle(cx, cy, radius, thickness, r, g, b, a) {
  const inner = radius - thickness / 2;
  const outer = radius + thickness / 2;
  const x0 = Math.max(0, Math.floor(cx - outer - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + outer + 1));
  const y0 = Math.max(0, Math.floor(cy - outer - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + outer + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d >= inner - 0.5 && d <= outer + 0.5) {
        let alpha = a;
        if (d < inner + 0.5) alpha = Math.round(a * (d - inner + 0.5));
        else if (d > outer - 0.5) alpha = Math.round(a * (outer + 0.5 - d));
        setPixel(x, y, r, g, b, Math.max(0, Math.min(255, alpha)));
      }
    }
  }
}

// Draw a line segment with AA and given thickness
function strokeLine(x1, y1, x2, y2, thickness, r, g, b, a) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return;
  const steps = Math.ceil(len * 2);
  const half  = thickness / 2;
  for (let i = 0; i <= steps; i++) {
    const t  = i / steps;
    const px = x1 + dx * t;
    const py = y1 + dy * t;
    // Paint a filled circle of radius=half at this point
    const ir = Math.max(0, Math.floor(px - half - 1));
    const ix = Math.min(W - 1, Math.ceil(px + half + 1));
    const iy0 = Math.max(0, Math.floor(py - half - 1));
    const iy1 = Math.min(H - 1, Math.ceil(py + half + 1));
    for (let sy = iy0; sy <= iy1; sy++) {
      for (let sx = ir; sx <= ix; sx++) {
        const d = Math.sqrt((sx - px) ** 2 + (sy - py) ** 2);
        if (d < half - 0.5) setPixel(sx, sy, r, g, b, a);
        else if (d < half + 0.5) {
          setPixel(sx, sy, r, g, b, Math.round(a * (half + 0.5 - d)));
        }
      }
    }
  }
}

// ── Render the icon ───────────────────────────────────────────────────────────

const CX = W / 2, CY = H / 2;

// 1. Background — very dark navy #0a0e1a
for (let i = 0; i < W * H; i++) {
  buf[i * 4]     = 10;
  buf[i * 4 + 1] = 14;
  buf[i * 4 + 2] = 26;
  buf[i * 4 + 3] = 255;
}

// 2. Subtle radial glow in centre — deep purple
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = Math.sqrt((x - CX) ** 2 + (y - CY) ** 2);
    const glow = Math.max(0, 1 - d / 90);
    const g2   = glow * glow;
    const i    = (y * W + x) * 4;
    buf[i]     = Math.min(255, buf[i]     + Math.round(60  * g2));
    buf[i + 1] = Math.min(255, buf[i + 1] + Math.round(20  * g2));
    buf[i + 2] = Math.min(255, buf[i + 2] + Math.round(90  * g2));
  }
}

// 3. Woven nest strands — multiple arcs in various orientations
// Each strand is an arc approximated by a polyline, coloured blue/purple
const STRANDS = [
  // { tilt(deg), arc_start(deg), arc_end(deg), radius, colour, alpha, thickness }
  { tilt:   0, s:   0, e: 300, rad: 72, r: 90,  g: 100, b: 220, a: 180, t: 1.8 },
  { tilt:  30, s:  20, e: 320, rad: 68, r: 110, g: 80,  b: 230, a: 160, t: 1.6 },
  { tilt:  60, s:  10, e: 280, rad: 74, r: 70,  g: 110, b: 240, a: 170, t: 1.7 },
  { tilt:  90, s:   0, e: 310, rad: 70, r: 100, g: 90,  b: 210, a: 155, t: 1.5 },
  { tilt: 120, s:  15, e: 295, rad: 66, r: 130, g: 70,  b: 220, a: 165, t: 1.6 },
  { tilt: 150, s:  25, e: 305, rad: 76, r: 80,  g: 120, b: 235, a: 150, t: 1.4 },
  { tilt:  45, s:  30, e: 270, rad: 78, r: 60,  g: 90,  b: 200, a: 140, t: 1.3 },
  { tilt: 135, s:  40, e: 290, rad: 64, r: 120, g: 60,  b: 215, a: 145, t: 1.4 },
  // Brighter highlight strands
  { tilt:  15, s:  50, e: 230, rad: 71, r: 140, g: 160, b: 255, a: 200, t: 1.2 },
  { tilt:  75, s:  60, e: 240, rad: 69, r: 160, g: 180, b: 255, a: 190, t: 1.1 },
  { tilt: 105, s:  55, e: 245, rad: 73, r: 150, g: 170, b: 255, a: 195, t: 1.2 },
];

for (const strand of STRANDS) {
  const tRad  = strand.tilt * Math.PI / 180;
  const steps = 120;
  const pts   = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (strand.s + (strand.e - strand.s) * i / steps) * Math.PI / 180;
    // 3-D ellipse projection: rotate in XZ plane by tilt
    const x3 = strand.rad * Math.cos(angle);
    const y3 = strand.rad * Math.sin(angle);
    // Project tilted ellipse onto 2-D screen
    const sx = CX + x3 * Math.cos(tRad) - y3 * 0;
    const sy = CY + x3 * Math.sin(tRad) * 0.35 + y3;
    pts.push([sx, sy]);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    strokeLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1],
      strand.t, strand.r, strand.g, strand.b, strand.a);
  }
}

// 4. Glowing ring outline — two rings for depth
strokeCircle(CX, CY, 78, 2.0, 100, 140, 255, 120);
strokeCircle(CX, CY, 78, 0.8, 180, 210, 255, 200);

// 5. Inner soft glow behind play button
fillCircle(CX, CY, 28, 80, 100, 200, 80);
fillCircle(CX, CY, 22, 120, 140, 230, 100);
fillCircle(CX, CY, 16, 160, 180, 255, 120);

// 6. Play triangle — white/light-blue, centred
// Triangle vertices: tip right, flat left
const PW = 18, PH = 21;  // play icon dimensions
const tx1 = CX - PW * 0.45,  ty1 = CY - PH / 2;  // top-left
const tx2 = CX - PW * 0.45,  ty2 = CY + PH / 2;  // bottom-left
const tx3 = CX + PW * 0.55,  ty3 = CY;            // right tip

// Rasterise filled triangle
const triMinY = Math.floor(Math.min(ty1, ty2, ty3));
const triMaxY = Math.ceil(Math.max(ty1, ty2, ty3));
for (let py = triMinY; py <= triMaxY; py++) {
  const edges = [];
  const pts = [[tx1,ty1,tx2,ty2],[tx2,ty2,tx3,ty3],[tx3,ty3,tx1,ty1]];
  for (const [ax,ay,bx,by] of pts) {
    if ((ay <= py && by > py) || (by <= py && ay > py)) {
      const t = (py - ay) / (by - ay);
      edges.push(ax + t * (bx - ax));
    }
  }
  if (edges.length >= 2) {
    edges.sort((a,b)=>a-b);
    const x0 = edges[0], x1 = edges[edges.length-1];
    for (let px = Math.floor(x0); px <= Math.ceil(x1); px++) {
      let a = 255;
      if (px < x0 + 0.5) a = Math.round(255 * (px - x0 + 0.5));
      else if (px > x1 - 0.5) a = Math.round(255 * (x1 + 0.5 - px));
      setPixel(px, py, 220, 235, 255, Math.max(0, Math.min(255, a)));
    }
  }
}

// 7. Sparkle dots — small bright dots scattered around the sphere
const SPARKLES = [
  [CX + 65, CY - 55], [CX - 70, CY + 45], [CX + 50, CY + 68],
  [CX - 60, CY - 50], [CX + 78, CY + 20], [CX - 75, CY - 10],
  [CX + 30, CY - 78], [CX - 35, CY + 75], [CX + 88, CY - 30],
];
for (const [sx, sy] of SPARKLES) {
  fillCircle(sx, sy, 2.2, 200, 220, 255, 220);
  fillCircle(sx, sy, 1.0, 255, 255, 255, 255);
}

// ── PNG encoder ───────────────────────────────────────────────────────────────

function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const tBuf = Buffer.from(type, 'ascii');
  const len  = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc  = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tBuf, data])));
  return Buffer.concat([len, tBuf, data, crc]);
}

// Build raw scanlines (filter byte 0 = None, then RGBA pixels)
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0;
  for (let x = 0; x < W; x++) {
    const si = (y * W + x) * 4;
    const di = y * (1 + W * 4) + 1 + x * 4;
    raw[di]     = buf[si];
    raw[di + 1] = buf[si + 1];
    raw[di + 2] = buf[si + 2];
    raw[di + 3] = buf[si + 3];
  }
}
const compressed = zlib.deflateSync(raw, { level: 6 });

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit depth, RGBA

const png = Buffer.concat([
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', compressed),
  pngChunk('IEND', Buffer.alloc(0)),
]);

// ── ICO wrapper ───────────────────────────────────────────────────────────────

const icoHdr = Buffer.alloc(6);
icoHdr.writeUInt16LE(0, 0);
icoHdr.writeUInt16LE(1, 2);
icoHdr.writeUInt16LE(1, 4);

const dirEntry = Buffer.alloc(16);
dirEntry[0] = 0; dirEntry[1] = 0; // 0 = 256 in ICO spec
dirEntry[2] = 0; dirEntry[3] = 0;
dirEntry.writeUInt16LE(1,  4);
dirEntry.writeUInt16LE(32, 6);
dirEntry.writeUInt32LE(png.length, 8);
dirEntry.writeUInt32LE(22,        12);

const ico = Buffer.concat([icoHdr, dirEntry, png]);

// ── Write files ───────────────────────────────────────────────────────────────

const icoPath = path.join(OUT_DIR, 'icon.ico');
const pngPath = path.join(OUT_DIR, 'icon.png');

fs.writeFileSync(icoPath, ico);
fs.writeFileSync(pngPath, png);

console.log(`✓ icon.ico  (${ico.length} bytes) → ${icoPath}`);
console.log(`✓ icon.png  (${png.length} bytes) → ${pngPath}`);
console.log('  Design: dark navy bg, purple/blue woven nest sphere, white play triangle, sparkles');
