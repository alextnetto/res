#!/usr/bin/env node
// Turns a finished knowledge base into a triage report (TRIAGE.md) and issue
// drafts for the clone team's tracker: one per barrier, one per problem that
// has a decision in clone/implications.md. Never touches the network and never
// files anything. No dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: node triage-kb.mjs <kb-dir> [--out <dir>] [--force] [--help]';
const BARRIER_SEVERITIES = ['blocks launch', 'blocks feature', 'adds lead time', 'adds cost', 'moat'];
const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const CLOSED_STATUSES = /^(answered|closed|resolved|done)\b/i;
const TITLE_LIMIT = 200;
const FILING = `Run this in this folder, with the clone's repository as \`owner/repo\`:

\`\`\`bash
jq -r '.[] | [.title, .file] | @tsv' issues.json | while IFS=$'\\t' read -r title file; do gh issue create -R owner/repo --title "$title" --body-file "$file"; done
\`\`\``;

// Same as stripIgnored in check-kb.mjs: blanks HTML comments and fenced code, keeping line numbers.
function stripIgnored(text) {
  const blank = (match) => match.replace(/[^\n]/g, '');
  return text.replace(/<!--[\s\S]*?-->/g, blank).replace(/^```[\s\S]*?^```/gm, blank);
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

const read = (kb, file) => (existsSync(join(kb, file)) ? stripIgnored(readFileSync(join(kb, file), 'utf8').replace(/\r\n?/g, '\n')) : '');

// Cells are kept verbatim; only unescaped pipes split them.
const splitCells = (line) => line.replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim());

// Table rows keyed by lower-case header name, with the "## " section they sit under.
function readRows(text) {
  const rows = [];
  let section = '';
  let header = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) section = heading[1].trim().toLowerCase();
    if (!line.startsWith('|')) {
      header = null;
    } else if (!header) {
      header = splitCells(line).map((name) => name.toLowerCase());
    } else if (!/^\|[\s|:-]+\|$/.test(line)) {
      const cells = splitCells(line);
      rows.push({ section, raw: line, by: Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])), first: cells[0] });
    }
  }
  return rows;
}

// Same boundary as claimSections in check-kb.mjs: a "PREFIX-### title" heading starts a section,
// and the next heading of the same or a higher level ends it.
function readSections(text, prefix) {
  const sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^(#{1,6})\s/);
    if (heading && current && heading[1].length <= current.level) current = null;
    const own = line.match(new RegExp(`^(#{1,6})\\s+(${prefix}-\\d{3})\\b\\s*(.*)`));
    if (own) {
      sections.push((current = { id: own[2], title: own[3].trim(), level: own[1].length, lines: [] }));
      continue;
    }
    current?.lines.push(line);
  }
  return sections.map(({ id, title, lines }) => ({ id, title, body: lines.join('\n').trim() }));
}

// The first cell holds the ID, alone or followed by the title.
const rowId = (row, prefix) => row.first.match(new RegExp(`^(${prefix}-\\d{3})\\b\\s*(.*)`));
const rowTitle = (row, id, column) => (row.by[column] && row.by[column] !== row.first ? row.by[column] : id[2]);

// check-kb reports duplicate IDs as errors; with --force the first definition wins.
const skipped = [];
function keepFirst(map, id, value) {
  if (map.has(id)) skipped.push(id);
  else map.set(id, value);
}

// Heading text goes into table cells, where a bare pipe would split the cell.
const cell = (text) => text.replace(/(?<!\\)\|/g, '\\|');

const field = (body, name) => body.match(new RegExp(`^-\\s*${name}:\\s*(.+)$`, 'im'))?.[1].trim() ?? '';

function rank(value, order) {
  const index = order.findIndex((name) => value.toLowerCase().startsWith(name));
  return index === -1 ? order.length : index;
}

const bySeverity = (order) => (a, b) => rank(a.severity, order) - rank(b.severity, order);

function readBarriers(kb) {
  const barriers = new Map();
  for (const section of readSections(read(kb, 'clone/barriers.md'), 'BR')) keepFirst(barriers, section.id, { ...section, severity: field(section.body, 'Severity') });
  return [...barriers.values()].sort(bySeverity(BARRIER_SEVERITIES));
}

// A finding may have a summary row and a detail heading; both describe the same finding.
function readFindings(kb) {
  const text = read(kb, 'findings.md');
  const findings = new Map();
  for (const row of readRows(text)) {
    const id = rowId(row, 'B');
    if (id) keepFirst(findings, id[1], { id: id[1], text: rowTitle(row, id, 'finding'), severity: row.by.severity ?? '', where: row.by.where ?? '', detail: '', source: row.raw });
  }
  const headed = new Map();
  for (const section of readSections(text, 'B')) keepFirst(headed, section.id, section);
  for (const section of headed.values()) {
    const known = findings.get(section.id);
    findings.set(section.id, {
      id: section.id,
      text: known?.text || cell(section.title),
      severity: known?.severity || field(section.body, 'Severity'),
      where: known?.where || field(section.body, 'Where'),
      detail: section.body.split('\n').filter((line) => !/^-\s*(Severity|Where):/i.test(line)).join('\n').trim(),
      source: [known?.source, section.body].filter(Boolean).join('\n'),
    });
  }
  return [...findings.values()].sort(bySeverity(FINDING_SEVERITIES));
}

// Findings mentioned in a Copy, Avoid or Improve row get that row as a decision.
function readDecisions(kb) {
  const decisions = new Map();
  for (const row of readRows(read(kb, 'clone/implications.md'))) {
    const kind = ['copy', 'avoid', 'improve'].find((name) => row.section.startsWith(name));
    if (!kind) continue;
    const decision = { kind, item: row.by.item ?? '', detail: row.by.why ?? row.by.how ?? '', refs: row.by.refs ?? '' };
    for (const id of new Set(row.raw.match(/\bB-\d{3}\b/g) ?? [])) decisions.set(id, [...(decisions.get(id) ?? []), decision]);
  }
  return decisions;
}

function readQuestions(kb) {
  const text = read(kb, 'questions.md');
  const questions = new Map();
  for (const row of readRows(text)) {
    const id = rowId(row, 'Q');
    if (id) keepFirst(questions, id[1], { id: id[1], question: rowTitle(row, id, 'question'), answer: row.by['how to answer'] ?? '', status: row.by.status ?? '' });
  }
  for (const section of readSections(text, 'Q')) {
    if (questions.has(section.id)) continue;
    questions.set(section.id, { id: section.id, question: cell(section.title), answer: cell(field(section.body, 'How to answer')), status: field(section.body, 'Status') });
  }
  // An unknown status counts as open, so nothing is silently dropped.
  return [...questions.values()].filter((question) => !CLOSED_STATUSES.test(question.status));
}

function readEvidenceDates(kb) {
  const path = join(kb, 'evidence', 'index.csv');
  const dates = new Map();
  if (!existsSync(path)) return dates;
  for (const [id = '', date = ''] of parseCsv(readFileSync(path, 'utf8'))) dates.set(id.trim(), date.trim());
  return dates;
}

// Computed from the tags in the row or section, never authored.
function evidenceOf(source, dates) {
  const tags = source.match(/\[(?:obs|net)\s+EV-\d{3}[^\]]*\]|\[doc\s+SRC-\d{3}[^\]]*\]/g) ?? [];
  if (tags.length) {
    const seen = tags.flatMap((tag) => tag.match(/EV-\d{3}/g) ?? []).map((id) => dates.get(id)).filter(Boolean).sort().at(-1);
    return { state: 'confirmed', tags: tags.join(' '), seen };
  }
  if (/\[inf\]/.test(source)) return { state: 'inferred', question: source.match(/\bQ-\d{3}\b/)?.[0] };
  return { state: 'none' };
}

function evidenceLine(evidence) {
  if (evidence.state === 'confirmed') return `- Evidence: ${evidence.tags}${evidence.seen ? `, seen ${evidence.seen}` : ''}`;
  if (evidence.state === 'inferred') return `- Evidence: inferred only.${evidence.question ? ` Answer ${evidence.question} before acting on it.` : ''}`;
  return '- Evidence: none recorded.';
}

function decisionLine({ kind, item, detail, refs }) {
  const label = kind === 'improve' ? 'How' : 'Why';
  const parts = [`${kind[0].toUpperCase()}${kind.slice(1)}: ${item}`, detail && `${label}: ${detail}`, refs && `Refs: ${refs}`];
  return `- ${parts.filter(Boolean).join('. ')}`;
}

// Draft bodies carry no title: the title goes in issues.json, so a filed issue does not repeat it.
function barrierDraft(barrier, product) {
  return `${barrier.body}\n\nFrom \`clone/barriers.md\` in the ${product} knowledge base.\n`;
}

function findingDraft(finding, evidence, decisions, product) {
  return [
    [`- Severity: ${finding.severity}`, `- Where: ${finding.where}`, evidenceLine(evidence)].join('\n'),
    finding.detail,
    `## For the clone\n\n${decisions.map(decisionLine).join('\n')}`,
    `From \`findings.md\` and \`clone/implications.md\` in the ${product} knowledge base.`,
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}

// GitHub caps titles at 256 characters.
function issueTitle(text) {
  const title = text.replace(/\\\|/g, '|');
  if (title.length <= TITLE_LIMIT) return title;
  const cut = title.slice(0, TITLE_LIMIT - 3);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : undefined)}...`;
}

const table = (header, rows) => [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');

function buildReport({ product, date, folder, barriers, problems, questions, undecided }) {
  const launch = barriers.filter((barrier) => rank(barrier.severity, BARRIER_SEVERITIES) === 0).length;
  const count = (state) => problems.filter((problem) => problem.evidence.state === state).length;
  const sections = [
    `# Triage: ${product}\n\nGenerated ${date} from \`${folder}\`. The drafts in \`issues/\` are for the clone's tracker. Nothing was filed.`,
    `## Summary\n\n- Barriers: ${barriers.length}. Launch blockers: ${launch}.\n- Problems: ${problems.length} (confirmed ${count('confirmed')}, inferred ${count('inferred')}). Without a decision in \`clone/implications.md\`: ${undecided.length}.\n- Open questions: ${questions.length}.`,
  ];
  if (barriers.length) {
    const rows = barriers.map((b) => [b.id, cell(b.title), cell(b.severity), `[${b.id}](issues/${b.id}.md)`]);
    sections.push(`## Barriers\n\n${table(['ID', 'Barrier', 'Severity', 'Draft'], rows)}`);
  }
  if (problems.length) {
    const rows = problems.map((p) => {
      const kinds = [...new Set(p.decisions.map((decision) => decision.kind))].join(', ') || 'none';
      return [p.id, p.text, p.severity, p.evidence.state, kinds, p.decisions.length ? `[${p.id}](issues/${p.id}.md)` : '-'];
    });
    sections.push(`## Problems\n\n${table(['ID', 'Problem', 'Severity', 'Evidence', 'Decision', 'Draft'], rows)}`);
  }
  if (questions.length) sections.push(`## Open questions\n\n${table(['ID', 'Question', 'How to answer'], questions.map((q) => [q.id, q.question, q.answer]))}`);
  sections.push(`## Filing\n\nEach draft is an issue body; \`issues.json\` holds the title and file of every draft, in the order above. Read the drafts before filing them.\n\n${FILING}`);
  return `${sections.join('\n\n')}\n`;
}

function parseArgs(argv) {
  const options = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') options.out = argv[(i += 1)];
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
    console.error(`${check.stdout}${check.stderr}\ncheck-kb reports errors. Fix them, or pass --force to triage anyway.`);
    process.exit(1);
  }

  const folder = basename(kb);
  const product = readFileSync(join(kb, 'STATUS.md'), 'utf8').match(/^# Status:\s*(.+)$/m)?.[1]?.trim() || folder;
  const date = new Date().toLocaleDateString('en-CA');
  const out = resolve(options.out || join(dirname(kb), `${folder}-triage-${date}`));
  if (existsSync(out)) {
    console.error(`Already exists: ${out}. Choose another --out.`);
    process.exit(2);
  }

  const dates = readEvidenceDates(kb);
  const decisions = readDecisions(kb);
  const barriers = readBarriers(kb);
  const questions = readQuestions(kb);
  const problems = readFindings(kb).map((finding) => ({ ...finding, evidence: evidenceOf(finding.source, dates), decisions: decisions.get(finding.id) ?? [] }));
  const decided = problems.filter((problem) => problem.decisions.length);
  const undecided = problems.filter((problem) => !problem.decisions.length);

  const drafts = [
    ...barriers.map((barrier) => ({ id: barrier.id, title: `${barrier.id} ${barrier.title}`, text: barrierDraft(barrier, product) })),
    ...decided.map((problem) => ({ id: problem.id, title: `${problem.id} ${problem.text}`, text: findingDraft(problem, problem.evidence, problem.decisions, product) })),
  ];
  const index = drafts.map(({ id, title }) => ({ id, title: issueTitle(title), file: `issues/${id}.md` }));

  try {
    mkdirSync(out);
  } catch (error) {
    console.error(`Cannot create ${out}: ${error.message}`);
    process.exit(2);
  }
  // This run created the directory, so a partial output is entirely ours to remove.
  try {
    mkdirSync(join(out, 'issues'));
    const files = [
      ...drafts.map(({ id, text }) => [`issues/${id}.md`, text]),
      ['issues.json', `${JSON.stringify(index, null, 2)}\n`],
      ['TRIAGE.md', buildReport({ product, date, folder, barriers, problems, questions, undecided })],
    ];
    for (const [name, text] of files) writeFileSync(join(out, name), text, { flag: 'wx' });
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }

  console.log(`Triage: ${out}`);
  console.log(`Drafts: ${drafts.length} (barriers ${barriers.length}, problems ${decided.length}).`);
  console.log(`Problems without a decision: ${undecided.length}${undecided.length ? ` (${undecided.map((problem) => problem.id).join(', ')})` : ''}.`);
  console.log(`Open questions: ${questions.length}.`);
  if (skipped.length) console.log(`Skipped second definitions of: ${[...new Set(skipped)].join(', ')}.`);
  console.log('Nothing was filed. TRIAGE.md says how to file the drafts.');
  if (check.status !== 0) console.log('Triaged with --force: check-kb reported errors.');
}

main();
