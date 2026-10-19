#!/usr/bin/env node
// Validates a reverse-engineering knowledge base: IDs, references, links,
// evidence tags, the change ledger and STATUS.md.
// Exit code 1 when there are errors, 2 on bad usage.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const USAGE = 'Usage: node check-kb.mjs <kb-dir> [--closing] [--next] [--help]';
const ID_PATTERN = /\b(FL|SRC|EV|BR|F|S|C|R|E|B|Q|L)-(\d{3})\b/g;
const SKIP_DIRS = new Set(['.git', 'node_modules', '_templates']);
const SCANNED_EXTENSIONS = new Set(['.md', '.mmd', '.ts']);
const LEDGER_COLUMNS = ['id', 'time', 'class', 'action', 'object', 'location', 'object_id', 'before', 'undo', 'status', 'note'];
const LEDGER_CLASSES = new Set(['A1', 'A2', 'A3', 'A4', 'incident']);
const LEDGER_ACTIONS = new Set(['create', 'update', 'delete', 'toggle', 'incident']);
const LEDGER_STATUSES = new Set(['open', 'restored', 'removed', 'fixture', 'kept', 'human']);
const EVIDENCE_INDEX = 'evidence/index.csv';
const COVERAGE_VALUES = new Set(['todo', 'partial', 'done', 'blocked', 'n/a']);
// Directories whose file names define IDs.
const FILE_ID_DIRS = {
  screens: 'S',
  components: 'C',
  flows: 'FL',
  'data-model/entities': 'E',
  evidence: 'EV',
};
// Files whose table rows (first cell) define IDs.
const ROW_ID_FILES = {
  'inventory/features.md': ['F'],
  'inventory/screens.md': ['S'],
  'sources.md': ['SRC'],
  'findings.md': ['B'],
  'questions.md': ['Q'],
};
// Files whose headings define IDs.
const HEADING_ID_FILES = { 'findings.md': ['B'], 'questions.md': ['Q'], 'clone/barriers.md': ['BR'] };
const ARTIFACT_DIRS = ['screens', 'components', 'flows', 'topics'];

const errors = [];
let closingRun = false;
const warnings = [];
const definitions = new Map();

function walk(dir, root = dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full, root));
    else files.push(relative(root, full).split(sep).join('/'));
  }
  return files;
}

function extensionOf(file) {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot);
}

// Blanks out HTML comments and fenced code blocks, keeping line numbers.
function stripIgnored(text) {
  const blank = (match) => match.replace(/[^\n]/g, '');
  return text.replace(/<!--[\s\S]*?-->/g, blank).replace(/^```[\s\S]*?^```/gm, blank);
}

function define(id, file, line, kind) {
  if (!definitions.has(id)) definitions.set(id, []);
  definitions.get(id).push({ file, line, kind });
}

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

function collectDefinitions(kb, files) {
  for (const file of files) {
    for (const [dir, prefix] of Object.entries(FILE_ID_DIRS)) {
      if (dirname(file) !== dir) continue;
      const name = file.slice(dir.length + 1);
      if (name === '.gitkeep' || file === EVIDENCE_INDEX) continue;
      const match = name.match(/^([A-Z]+)-(\d{3})(?=[-.])/);
      if (match && match[1] === prefix) define(`${prefix}-${match[2]}`, file, 0, 'file');
      else warnings.push(`${file}: file name should start with ${prefix}-### (for example ${prefix}-001-name)`);
    }
  }
  const markdownFiles = files.filter((file) => file.endsWith('.md'));
  for (const file of markdownFiles) {
    const lines = stripIgnored(readFileSync(join(kb, file), 'utf8')).split('\n');
    const rowPrefixes = ROW_ID_FILES[file] ?? [];
    const headingPrefixes = file.startsWith('rules/') ? ['R'] : HEADING_ID_FILES[file] ?? [];
    lines.forEach((line, index) => {
      const row = line.match(/^\|\s*([A-Z]+)-(\d{3})\b/);
      if (row && rowPrefixes.includes(row[1])) define(`${row[1]}-${row[2]}`, file, index + 1, 'row');
      const heading = line.match(/^#{1,6}\s+([A-Z]+)-(\d{3})\b/);
      if (heading && headingPrefixes.includes(heading[1])) define(`${heading[1]}-${heading[2]}`, file, index + 1, 'heading');
    });
  }
}

function checkDuplicates() {
  for (const [id, places] of definitions) {
    const byKind = new Map();
    for (const place of places) byKind.set(place.kind, [...(byKind.get(place.kind) ?? []), place]);
    for (const same of byKind.values()) {
      if (same.length > 1) {
        const where = same.map((place) => (place.line ? `${place.file}:${place.line}` : place.file)).join(', ');
        errors.push(`${id} is defined more than once: ${where}`);
      }
    }
  }
}

function checkReferencesAndLinks(kb, files) {
  for (const file of files.filter((name) => SCANNED_EXTENSIONS.has(extensionOf(name)))) {
    const text = stripIgnored(readFileSync(join(kb, file), 'utf8'));
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const where = `${file}:${index + 1}`;
      for (const match of line.matchAll(ID_PATTERN)) {
        const id = match[0];
        if (match[2] === '000') errors.push(`${where}: placeholder ID ${id} left from a template`);
        else if (!definitions.has(id)) errors.push(`${where}: ${id} is referenced but not defined`);
      }
      for (const link of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = link[1].split('#')[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;
        if (!existsSync(resolve(kb, dirname(file), decodeURI(target)))) errors.push(`${where}: broken link ${link[1]}`);
      }
      // Tags written inside inline code are documentation, not claims.
      const prose = line.replace(/`[^`]*`/g, '');
      if (/\[inf\]/.test(prose) && !/\bQ-\d{3}\b/.test(prose)) warnings.push(`${where}: [inf] without a Q-### on the same line`);
      for (const tag of prose.matchAll(/\[(obs|net|doc)\b([^\]]*)\]/g)) {
        const expected = tag[1] === 'doc' ? 'SRC' : 'EV';
        if (!new RegExp(`^\\s+${expected}-\\d{3}`).test(tag[2])) errors.push(`${where}: [${tag[1]} ...] must cite ${expected}-###`);
      }
    });
    if (/\{\{[^}]+\}\}/.test(text)) {
      // At the end of a study the charter must be complete; elsewhere a placeholder is a reminder.
      if (closingRun && file === '00-charter.md') errors.push(`${file}: template placeholders {{...}} not filled`);
      else warnings.push(`${file}: template placeholders {{...}} not filled`);
    }
  }
}

// Rules and barriers are claims the clone depends on: each section needs evidence.
function checkEvidenceSections(kb, files) {
  const targets = [
    ...files.filter((name) => name.startsWith('rules/') && name.endsWith('.md')).map((file) => [file, 'R']),
    ...files.filter((name) => name === 'clone/barriers.md').map((file) => [file, 'BR']),
  ];
  for (const [file, prefix] of targets) {
    const text = stripIgnored(readFileSync(join(kb, file), 'utf8'));
    const start = new RegExp(`^(?=#{1,6}\\s+${prefix}-\\d{3}\\b)`, 'm');
    const sections = text.split(start).filter((section) => new RegExp(`^#{1,6}\\s+${prefix}-\\d{3}`).test(section));
    for (const section of sections) {
      const id = section.match(new RegExp(`${prefix}-\\d{3}`))[0];
      if (/\[(obs|net)\s+EV-\d{3}|\[doc\s+SRC-\d{3}/.test(section)) continue;
      if (/\[inf\]/.test(section) && /\bQ-\d{3}\b/.test(section)) warnings.push(`${file}: ${id} rests on inference only`);
      else errors.push(`${file}: ${id} has no evidence tag ([obs EV-###], [net EV-###] or [doc SRC-###])`);
    }
  }
}

function checkArtifacts(files, kb) {
  for (const file of files) {
    if (!file.endsWith('.md') || !ARTIFACT_DIRS.includes(dirname(file))) continue;
    if (!/^##\s+Not tested\b/m.test(readFileSync(join(kb, file), 'utf8'))) warnings.push(`${file}: no "## Not tested" section`);
  }
}

function checkLedger(kb, closing) {
  const path = join(kb, 'sandbox', 'ledger.csv');
  if (!existsSync(path)) {
    errors.push('sandbox/ledger.csv is missing');
    return { rows: 0, open: 0 };
  }
  const [header = [], ...rows] = parseCsv(readFileSync(path, 'utf8'));
  if (header.join(',') !== LEDGER_COLUMNS.join(',')) {
    errors.push(`sandbox/ledger.csv: header must be ${LEDGER_COLUMNS.join(',')}`);
    return { rows: rows.length, open: 0 };
  }
  let open = 0;
  rows.forEach((cells, index) => {
    const row = Object.fromEntries(LEDGER_COLUMNS.map((column, i) => [column, (cells[i] ?? '').trim()]));
    const where = `sandbox/ledger.csv:${index + 2}`;
    if (!/^L-\d{3}$/.test(row.id)) errors.push(`${where}: id must be L-###`);
    else define(row.id, 'sandbox/ledger.csv', index + 2, 'ledger');
    if (!LEDGER_CLASSES.has(row.class)) errors.push(`${where}: class must be one of ${[...LEDGER_CLASSES].join(', ')}`);
    if (!LEDGER_ACTIONS.has(row.action)) errors.push(`${where}: action must be one of ${[...LEDGER_ACTIONS].join(', ')}`);
    if (!LEDGER_STATUSES.has(row.status)) errors.push(`${where}: status must be one of ${[...LEDGER_STATUSES].join(', ')}`);
    if (['kept', 'fixture', 'human'].includes(row.status) && !row.note) errors.push(`${where}: ${row.status} rows need a note`);
    else if (row.class === 'incident' && !row.note) errors.push(`${where}: incident rows need a note`);
    if (row.status === 'open') {
      open += 1;
      (closing ? errors : warnings).push(`${where}: ${row.id} is still open (${row.object})`);
    }
    if (row.status === 'fixture' && closing) errors.push(`${where}: ${row.id} is a fixture still in the product (${row.object})`);
    if (row.status === 'human') (closing ? errors : warnings).push(`${where}: ${row.id} waits for the user: ${row.note}`);
  });
  return { rows: rows.length, open };
}

function checkStatus(kb, files, ledger) {
  const path = join(kb, 'STATUS.md');
  if (!existsSync(path)) {
    errors.push('STATUS.md is missing');
    return;
  }
  const text = readFileSync(path, 'utf8');
  const updated = text.match(/^Updated:\s*(\d{4}-\d{2}-\d{2})/m);
  if (!updated) warnings.push('STATUS.md: no "Updated: YYYY-MM-DD" line');
  for (const section of ['Summary', 'Next actions', 'Needs human', 'Blocked']) {
    if (!new RegExp(`^##\\s+${section}`, 'm').test(text)) warnings.push(`STATUS.md: no "## ${section}" section`);
  }
  const logDates = files
    .filter((file) => file.startsWith('log/'))
    .map((file) => file.match(/(\d{4}-\d{2}-\d{2})/)?.[1])
    .filter(Boolean)
    .sort();
  const newestLog = logDates.at(-1);
  if (updated && newestLog && updated[1] < newestLog) warnings.push(`STATUS.md: updated ${updated[1]}, older than the newest log ${newestLog}`);
  const stated = text.match(/Open ledger rows:\s*(\d+)/);
  if (stated && Number(stated[1]) !== ledger.open) warnings.push(`STATUS.md: says ${stated[1]} open ledger rows, ledger has ${ledger.open}`);
}

function checkEvidenceIndex(kb, files) {
  const evidence = files.filter((file) => dirname(file) === 'evidence' && /^evidence\/EV-\d{3}/.test(file));
  const path = join(kb, EVIDENCE_INDEX);
  if (!existsSync(path)) {
    if (evidence.length) warnings.push(`${EVIDENCE_INDEX} is missing`);
    return;
  }
  const [, ...rows] = parseCsv(readFileSync(path, 'utf8'));
  const indexed = new Set(rows.map((cells) => (cells[0] ?? '').trim()));
  for (const file of evidence) {
    const id = file.match(/EV-\d{3}/)[0];
    if (!indexed.has(id)) warnings.push(`${file}: no row in ${EVIDENCE_INDEX}`);
  }
  for (const id of indexed) {
    if (id && !definitions.has(id)) warnings.push(`${EVIDENCE_INDEX}: ${id} has no evidence file`);
  }
}

// Field and relation rows in entity files need a source tag.
function checkEntities(kb, files) {
  for (const file of files.filter((name) => name.startsWith('data-model/entities/') && name.endsWith('.md'))) {
    let section = '';
    stripIgnored(readFileSync(join(kb, file), 'utf8'))
      .split('\n')
      .forEach((line, index) => {
        const heading = line.match(/^##\s+(.+)/);
        if (heading) section = heading[1].trim();
        if (!['Fields', 'Relations'].includes(section) || !line.startsWith('|')) return;
        if (/^\|\s*(Field|Relation)\s*\|/.test(line) || /^\|[\s|:-]+\|$/.test(line)) return;
        if (!/\[(obs|net|doc)\s|\[inf\]/.test(line)) warnings.push(`${file}:${index + 1}: ${section.toLowerCase()} row without an evidence tag`);
      });
  }
}

// Every feature should have a row in the coverage queue.
function checkCoverageRows(kb) {
  const path = join(kb, 'inventory', 'coverage.md');
  if (!existsSync(path)) return;
  const covered = new Set(stripIgnored(readFileSync(path, 'utf8')).match(/^\|\s*F-\d{3}/gm)?.map((cell) => cell.replace(/^\|\s*/, '')) ?? []);
  for (const [id, places] of definitions) {
    if (id.startsWith('F-') && places.some((place) => place.file === 'inventory/features.md') && !covered.has(id)) {
      warnings.push(`inventory/coverage.md: ${id} has no row`);
    }
  }
}

function coverageSummary(kb) {
  const path = join(kb, 'inventory', 'coverage.md');
  const counts = Object.fromEntries([...COVERAGE_VALUES].map((value) => [value, 0]));
  if (!existsSync(path)) return counts;
  stripIgnored(readFileSync(path, 'utf8'))
    .split('\n')
    .forEach((line, index) => {
      if (!/^\|\s*F-\d{3}\b/.test(line)) return;
      const cells = line.split('|').slice(2, -2).map((cell) => cell.trim().toLowerCase());
      for (const cell of cells) {
        const value = cell.split(/[\s:]/)[0];
        if (COVERAGE_VALUES.has(value)) counts[value] += 1;
        else warnings.push(`inventory/coverage.md:${index + 1}: "${cell}" is not one of ${[...COVERAGE_VALUES].join(', ')}`);
      }
    });
  return counts;
}

function nextIds() {
  const max = {};
  for (const id of definitions.keys()) {
    const [prefix, number] = id.split('-');
    max[prefix] = Math.max(max[prefix] ?? 0, Number(number));
  }
  return ['F', 'S', 'C', 'FL', 'R', 'BR', 'E', 'B', 'Q', 'SRC', 'EV', 'L']
    .map((prefix) => `${prefix}-${String((max[prefix] ?? 0) + 1).padStart(3, '0')}`)
    .join('  ');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const kbArg = args.find((arg) => !arg.startsWith('--'));
  if (!kbArg) {
    console.error(USAGE);
    process.exit(2);
  }
  const kb = resolve(kbArg);
  if (!existsSync(kb)) {
    console.error(`Not found: ${kb}`);
    process.exit(2);
  }
  const closing = args.includes('--closing');
  closingRun = closing;
  const files = walk(kb);

  collectDefinitions(kb, files);
  const ledger = checkLedger(kb, closing);
  checkDuplicates();
  checkReferencesAndLinks(kb, files);
  checkEvidenceSections(kb, files);
  checkArtifacts(files, kb);
  checkEvidenceIndex(kb, files);
  checkEntities(kb, files);
  checkCoverageRows(kb);
  checkStatus(kb, files, ledger);
  const coverage = coverageSummary(kb);

  if (args.includes('--next')) {
    console.log(nextIds());
    return;
  }

  const counts = {};
  for (const id of definitions.keys()) counts[id.split('-')[0]] = (counts[id.split('-')[0]] ?? 0) + 1;
  console.log(`Knowledge base: ${kb}`);
  console.log(`Defined: ${Object.entries(counts).map(([prefix, n]) => `${prefix} ${n}`).join(', ') || 'nothing yet'}`);
  console.log(`Coverage cells: ${Object.entries(coverage).map(([value, n]) => `${value} ${n}`).join(', ')}`);
  console.log(`Ledger: ${ledger.rows} rows, ${ledger.open} open`);
  if (errors.length) console.log(`\nErrors (${errors.length}):\n${errors.map((line) => `  ${line}`).join('\n')}`);
  if (warnings.length) console.log(`\nWarnings (${warnings.length}):\n${warnings.map((line) => `  ${line}`).join('\n')}`);
  if (!errors.length) console.log(`\nOK${warnings.length ? ' with warnings' : ''}.`);
  process.exitCode = errors.length ? 1 : 0;
}

main();
