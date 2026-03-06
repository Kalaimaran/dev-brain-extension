/**
 * generate_icons.js
 * Run with: node generate_icons.js
 * Generates icon16.png, icon48.png, icon128.png using the Canvas API (Node 18+)
 * or falls back to writing minimal valid PNG buffers.
 *
 * Usage: node extension/icons/generate_icons.js
 */

const fs = require("fs");
const path = require("path");

// Minimal 1×1 transparent PNG — base template we scale up conceptually.
// These are real, Chrome-compatible PNG files generated via raw bytes.

function generatePNG(size) {
  // We'll create an SVG string and write it — Chrome accepts SVG for icons too
  // but manifest.json explicitly names .png so we write tiny valid PNGs instead.

  // Simple approach: use Node's built-in to write a valid PNG.
  // This uses the raw PNG structure with a brain emoji rendered via canvas if available,
  // otherwise a solid purple square.

  try {
    const { createCanvas } = require("canvas");
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");

    // Background
    ctx.fillStyle = "#6c63ff";
    roundRect(ctx, 0, 0, size, size, size * 0.2);
    ctx.fill();

    // Brain emoji
    ctx.font = `${size * 0.6}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🧠", size / 2, size / 2);

    return canvas.toBuffer("image/png");
  } catch {
    // canvas module not installed — write a minimal valid 1×1 purple PNG
    return minimalPNG(size);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Returns a buffer containing a minimal valid PNG for the given size
 * filled with solid color #6c63ff (the accent purple).
 * Built from raw bytes without any external dependency.
 */
function minimalPNG(size) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = buildChunk("IHDR", Buffer.concat([
    uint32(size), uint32(size),
    Buffer.from([8, 2, 0, 0, 0]), // 8-bit RGB, no interlace
  ]));

  // IDAT chunk — uncompressed scanlines (filter byte 0x00 + RGB pixels)
  const { deflateSync } = require("zlib");
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0; // filter: None
  for (let i = 0; i < size; i++) {
    row[1 + i * 3 + 0] = 0x6c; // R
    row[1 + i * 3 + 1] = 0x63; // G
    row[1 + i * 3 + 2] = 0xff; // B
  }
  const raw = Buffer.concat(Array(size).fill(row));
  const idat = buildChunk("IDAT", deflateSync(raw));

  // IEND chunk
  const iend = buildChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

function uint32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function buildChunk(type, data) {
  const { crc32 } = require("zlib");
  // Node's zlib doesn't expose crc32 directly — implement it inline
  const typeBuf = Buffer.from(type, "ascii");
  const len = uint32(data.length);
  const payload = Buffer.concat([typeBuf, data]);
  const crc = crc32buf(payload);
  return Buffer.concat([len, payload, uint32(crc)]);
}

// Simple CRC32 implementation
function crc32buf(buf) {
  let crc = 0xffffffff;
  const table = makeCRCTable();
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let _crcTable;
function makeCRCTable() {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    _crcTable[n] = c;
  }
  return _crcTable;
}

// ---------------------------------------------------------------------------
// Write icons
// ---------------------------------------------------------------------------
const dir = __dirname;
for (const size of [16, 48, 128]) {
  const buf = generatePNG(size);
  const outPath = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`Written: ${outPath} (${buf.length} bytes)`);
}
console.log("Done. Icons ready for the extension.");
