/**
 * Proves the fixture receipts carry a genuinely scannable Code 128 symbol.
 *
 * A barcode that merely *looks* like a barcode is worthless as a parser fixture,
 * so this decodes the rendered PNG pixels back to a string rather than trusting
 * the generator. It reads the PNG itself (zlib is in Node; no dependencies),
 * finds the densest scan row, measures the bar/space runs, and decodes them.
 *
 * Run: node design/receipts/verify-barcode.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ── Minimal PNG reader (8-bit RGB / RGBA, non-interlaced) ─────────────────── */

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec §9).
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x];
      const a = x >= channels ? pixels[dst + x - channels] : 0;
      const b = y > 0 ? pixels[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[dst - stride + x - channels] : 0;
      let out;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + a; break;
        case 2: out = value + b; break;
        case 3: out = value + ((a + b) >> 1); break;
        case 4: out = value + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter} on row ${y}`);
      }
      pixels[dst + x] = out & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

/* ── Code 128 decoding ────────────────────────────────────────────────────── */

const CODE128_PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
];

const PATTERN_TO_VALUE = new Map(CODE128_PATTERNS.map((p, v) => [p, v]));

/**
 * Counts black/white transitions on a row. Dense text rows also score highly,
 * so this only ranks candidates — the caller confirms by attempting a decode.
 */
function transitionsOnRow({ width, channels, pixels }, y) {
  let transitions = 0;
  let prev = false;
  for (let x = 0; x < width; x += 1) {
    const dark = pixels[y * width * channels + x * channels] < 128;
    if (dark !== prev) transitions += 1;
    prev = dark;
  }
  return transitions;
}

/**
 * Rows ordered by how barcode-like they look, densest first. A row of Arabic
 * glyphs can out-transition a barcode, so "densest row" alone is not a reliable
 * locator — the caller walks this list until one actually decodes.
 */
function candidateRows(png) {
  const rows = [];
  for (let y = 0; y < png.height; y += 1) {
    const transitions = transitionsOnRow(png, y);
    if (transitions >= 20) rows.push({ y, transitions });
  }
  return rows.sort((a, b) => b.transitions - a.transitions).map((r) => r.y);
}

/** Measures consecutive same-colour runs across one row, trimming quiet zones. */
function runsInRow({ width, channels, pixels }, y) {
  const row = [];
  for (let x = 0; x < width; x += 1) {
    row.push(pixels[y * width * channels + x * channels] < 128);
  }
  const first = row.indexOf(true);
  const last = row.lastIndexOf(true);
  if (first === -1) throw new Error('no dark pixels on the chosen row');

  const runs = [];
  let current = row[first];
  let length = 0;
  for (let x = first; x <= last; x += 1) {
    if (row[x] === current) {
      length += 1;
    } else {
      runs.push(length);
      current = row[x];
      length = 1;
    }
  }
  runs.push(length);
  return runs;
}

function decodeCode128(runs) {
  // The narrowest run is one module; every other run is a multiple of it.
  const moduleWidth = Math.min(...runs);
  const modules = runs.map((r) => Math.round(r / moduleWidth));

  const symbols = [];
  let i = 0;
  while (i + 6 <= modules.length) {
    const take = modules.slice(i, i + 6).join('');
    if (i + 7 === modules.length) break; // the 7-element stop pattern
    const value = PATTERN_TO_VALUE.get(take);
    if (value === undefined) throw new Error(`unknown pattern "${take}" at element ${i}`);
    symbols.push(value);
    i += 6;
  }
  const stop = modules.slice(i).join('');
  if (stop !== '2331112') throw new Error(`bad stop pattern "${stop}"`);

  const [start, ...rest] = symbols;
  if (start !== 104) throw new Error(`expected Start B (104), got ${start}`);

  const checksum = rest.pop();
  let expected = start;
  rest.forEach((v, idx) => { expected += v * (idx + 1); });
  expected %= 103;
  if (checksum !== expected) throw new Error(`checksum ${checksum} != expected ${expected}`);

  return {
    text: rest.map((v) => String.fromCharCode(v + 32)).join(''),
    moduleWidth,
    checksum,
  };
}

/* ── Run ──────────────────────────────────────────────────────────────────── */

const EXPECTED = {
  'walaa-receipt-invoice-only.png': 'INV-9824',
  'walaa-receipt-with-amount.png': 'INV-9824|85000',
};

let failures = 0;
console.log('\nDecoding Code 128 back out of the rendered pixels:\n');

for (const file of readdirSync(HERE).filter((f) => f.endsWith('.png')).sort()) {
  const png = decodePng(readFileSync(join(HERE, file)));
  const rows = candidateRows(png);

  let decoded = null;
  let lastError = 'no candidate rows found';
  for (const y of rows) {
    try {
      decoded = { y, ...decodeCode128(runsInRow(png, y)) };
      break;
    } catch (error) {
      lastError = error.message;
    }
  }

  if (!decoded) {
    failures += 1;
    console.log(`  ✘ ${file}: ${lastError}\n`);
    continue;
  }

  const want = EXPECTED[file];
  const ok = decoded.text === want;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? '✔' : '✘'} ${file.padEnd(34)} -> "${decoded.text}"` +
      `${ok ? '' : ` (expected "${want}")`}`,
  );
  console.log(
    `      ${png.width}x${png.height}px · scan row y=${decoded.y}` +
      ` · module=${decoded.moduleWidth}px · checksum=${decoded.checksum}\n`,
  );
}

if (failures > 0) {
  console.error(`${failures} barcode(s) failed to decode\n`);
  process.exitCode = 1;
} else {
  console.log('All barcodes decode correctly with valid checksums.\n');
}
