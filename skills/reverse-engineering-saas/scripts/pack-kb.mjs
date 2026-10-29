#!/usr/bin/env node
// Packs a knowledge base into a zip the user can hand to any coding agent.
// Adds BUILD.md (the build brief) to the KB if it is missing. Leaves out
// sandbox/ and log/ (account details) unless --full, but keeps a copy of the
// ledger without object IDs, locations or URLs, so the unzipped folder passes
// check-kb and shows how the study left the product. No dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { buildReport } from './build-report.mjs';

const USAGE = 'Usage: node pack-kb.mjs <kb-dir> [--out <file.zip>] [--full] [--force] [--help]';
const ALWAYS_SKIP = new Set(['.git', 'node_modules', '_templates', '.DS_Store', '.gitkeep']);
const PRIVATE_DIRS = ['sandbox', 'log'];
const LEDGER = 'sandbox/ledger.csv';
const LEDGER_PRIVATE_COLUMNS = ['location', 'object_id'];

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// MS-DOS date and time fields used by the zip format.
function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// Builds a zip archive (no zip64: under 65,535 entries and 4 GB).
function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const stamp = dosDateTime(new Date());
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data);
    const compress = deflated.length < data.length;
    const body = compress ? deflated : data;
    const method = compress ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(stamp.time, 12);
    header.writeUInt16LE(stamp.date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  if (entries.length > 0xffff || offset > 0xffffffff) throw new Error('Knowledge base too large for a zip without zip64.');
  return Buffer.concat([...parts, ...central, end]);
}

function walk(dir, root, skipDirs) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    if (ALWAYS_SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const rel = relative(root, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      if (!skipDirs.includes(rel)) files.push(...walk(full, root, skipDirs));
    } else {
      files.push(rel);
    }
  }
  return files;
}

// Same CSV reader as check-kb.mjs.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

const csvCell = (cell) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

// The ledger as the zip holds it: object IDs and locations blanked, URLs replaced.
function sanitizedLedger(path) {
  const [header = [], ...rows] = parseCsv(readFileSync(path, 'utf8').replace(/\r\n?/g, '\n'));
  const blank = new Set(LEDGER_PRIVATE_COLUMNS.map((column) => header.indexOf(column)).filter((index) => index >= 0));
  const clean = rows.map((cells) => cells.map((cell, index) => (blank.has(index) ? '' : cell.replace(/\b(?:https?|wss?):\/\/[^\s",]+/gi, '[url]'))));
  return Buffer.from(`${[header, ...clean].map((cells) => cells.map(csvCell).join(',')).join('\n')}\n`);
}

function parseArgs(argv) {
  const options = { full: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') options.out = argv[(i += 1)];
    else if (arg === '--full') options.full = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('--') && !options.dir) options.dir = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.dir) {
    console.error(USAGE);
    process.exit(2);
  }
  const kb = resolve(options.dir);
  if (!existsSync(join(kb, 'STATUS.md'))) {
    console.error(`Not a knowledge base (no STATUS.md): ${kb}`);
    process.exit(2);
  }
  const scripts = dirname(fileURLToPath(import.meta.url));

  const check = spawnSync(process.execPath, [join(scripts, 'check-kb.mjs'), kb], { encoding: 'utf8' });
  if (check.status !== 0 && !options.force) {
    console.error(`${check.stdout}${check.stderr}\ncheck-kb reports errors. Fix them, or pass --force to pack anyway.`);
    process.exit(1);
  }

  const product = readFileSync(join(kb, 'STATUS.md'), 'utf8').match(/^# Status:\s*(.+)$/m)?.[1]?.trim() || basename(kb);
  const date = new Date().toLocaleDateString('en-CA');
  const brief = join(kb, 'BUILD.md');
  if (!existsSync(brief)) {
    const template = readFileSync(join(scripts, '..', 'templates', 'handoff', 'BUILD.md'), 'utf8');
    writeFileSync(brief, template.replaceAll('{{PRODUCT}}', product).replaceAll('{{DATE}}', date));
  }
  // The human-readable report travels in the zip and is also sent on its own.
  const report = join(kb, 'REPORT.html');
  writeFileSync(report, buildReport(kb));

  const skipped = options.full ? [] : PRIVATE_DIRS.filter((dir) => existsSync(join(kb, dir)));
  const folder = basename(kb);
  const entries = walk(kb, kb, skipped).map((file) => ({ name: `${folder}/${file}`, data: readFileSync(join(kb, file)) }));
  const ledger = skipped.includes('sandbox') && existsSync(join(kb, LEDGER));
  if (ledger) entries.push({ name: `${folder}/${LEDGER}`, data: sanitizedLedger(join(kb, LEDGER)) });
  const zip = buildZip(entries);
  const out = resolve(options.out || join(dirname(kb), `${folder}-handoff-${date}.zip`));
  writeFileSync(out, zip);

  console.log(`Handoff: ${out}`);
  console.log(`${entries.length} files, ${(zip.length / 1024).toFixed(0)} KB.${skipped.length ? ` Left out: ${skipped.map((dir) => `${dir}/`).join(', ')} (use --full to include).` : ''}`);
  if (ledger) console.log(`Kept ${LEDGER} without object IDs, locations or URLs.`);
  if (check.status !== 0) console.log('Packed with --force: check-kb reported errors.');
  console.log(`Report: ${report}`);
  console.log('Send both files to the user: REPORT.html to read, the zip for any coding agent (start at BUILD.md).');
}

main();
