// Tests for init-kb.mjs and check-kb.mjs. No dependencies.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { toPosix } from '../skills/reverse-engineering-saas/scripts/check-kb.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'reverse-engineering-saas', 'scripts');
const run = (name, ...args) => spawnSync(process.execPath, [join(scripts, name), ...args], { encoding: 'utf8' });

let dir;
let kb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 're-kb-'));
  kb = join(dir, 're-acme');
  const init = run('init-kb.mjs', kb, '--product', 'Acme CRM');
  assert.equal(init.status, 0, init.stderr);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (path, text) => writeFileSync(join(kb, path), text);
const check = (...args) => run('check-kb.mjs', kb, ...args);

// Regression for the Windows path-separator bug: walk() used relative(), which
// yields backslashes on Windows, but definitions are keyed to '/'-based tables
// (FILE_ID_DIRS like 'data-model/entities', the 'rules/' prefix, EVIDENCE_INDEX).
// Without normalization every nested heading/filename definition went unregistered
// on Windows, so every E-/R- reference was flagged "referenced but not defined".
test('toPosix normalizes separators so nested IDs resolve on every platform', () => {
  assert.equal(toPosix('data-model\\entities\\E-002-x.md'), 'data-model/entities/E-002-x.md');
  assert.equal(toPosix('rules\\atendimento.md'), 'rules/atendimento.md');
  assert.equal(toPosix('evidence/index.csv'), 'evidence/index.csv');
});

test('init creates the tree, fills product and date, copies artifact templates', () => {
  for (const path of ['STATUS.md', 'sandbox/ledger.csv', 'inventory/coverage.md', '_templates/screen.md', 'evidence/index.csv']) {
    assert.ok(existsSync(join(kb, path)), `${path} missing`);
  }
  const status = readFileSync(join(kb, 'STATUS.md'), 'utf8');
  assert.match(status, /# Status: Acme CRM/);
  assert.match(status, /Updated: \d{4}-\d{2}-\d{2}/);
});

test('init never overwrites existing files', () => {
  write('STATUS.md', 'kept');
  const again = run('init-kb.mjs', kb, '--product', 'Other');
  assert.equal(again.status, 0);
  assert.equal(readFileSync(join(kb, 'STATUS.md'), 'utf8'), 'kept');
});

test('a fresh KB passes with warnings for unfilled placeholders only', () => {
  const result = check();
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /OK with warnings/);
  assert.match(result.stdout, /00-charter\.md: template placeholders/);
});

test('references must resolve to definitions', () => {
  write('screens/S-001-board.md', '# S-001 Board\nFeatures: F-001\n\n## Not tested\n- Drag.\n');
  let result = check();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /F-001 is referenced but not defined/);
  appendFileSync(join(kb, 'inventory/features.md'), '| F-001 | Deals | Board | Free | P1 | S-001 | | todo | [doc SRC-001] |\n');
  appendFileSync(join(kb, 'sources.md'), '| SRC-001 | Help center | https://example.com/help | docs | 2026-10-15 | features |\n');
  result = check();
  assert.equal(result.status, 0, result.stdout);
});

test('rules need evidence, and cited evidence must exist', () => {
  write('rules/deals.md', '# Rules: deals\n\n### R-001 Won deals leave the board\n- Given a deal\n- When won\n- Then hidden\n');
  let result = check();
  assert.match(result.stdout, /R-001 has no evidence tag/);
  write('rules/deals.md', '# Rules: deals\n\n### R-001 Won deals leave the board\n- Evidence: [obs EV-001]\n');
  result = check();
  assert.match(result.stdout, /EV-001 is referenced but not defined/);
  write('evidence/EV-001-deal-won.png', 'png');
  result = check();
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /evidence\/EV-001-deal-won\.png: no row in evidence\/index\.csv/);
  appendFileSync(join(kb, 'evidence/index.csv'), 'EV-001,2026-10-15,s01,/deal/:id,won deal leaves board,yes\nEV-099,2026-10-15,s01,/x,missing,no\n');
  result = check();
  assert.doesNotMatch(result.stdout, /EV-001-deal-won\.png: no row/);
  assert.match(result.stdout, /EV-099 has no evidence file/);
});

test('malformed evidence tags, placeholder IDs, duplicates and broken links are errors', () => {
  write('evidence/EV-001-a.png', 'png');
  write('rules/a.md', '### R-001 One\n- Evidence: [obs SRC-001]\n\n### R-001 Again\n- Evidence: [obs EV-001]\n');
  write('topics/search.md', '# Topic: search\nSee S-000 and ![x](../evidence/EV-404-missing.png)\n\n## Not tested\n- All.\n');
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[obs \.\.\.\] must cite EV-###/);
  assert.match(result.stdout, /R-001 is defined more than once/);
  assert.match(result.stdout, /placeholder ID S-000/);
  assert.match(result.stdout, /broken link \.\.\/evidence\/EV-404-missing\.png/);
});

test('[inf] needs a question and artifacts need a Not tested section', () => {
  write('components/C-001-card.md', '# C-001 Card\nProbably virtualized [inf]\n');
  const result = check();
  assert.match(result.stdout, /\[inf\] without a Q-###/);
  assert.match(result.stdout, /components\/C-001-card\.md: no "## Not tested" section/);
});

test('fixture rows need a note and fail with --closing', () => {
  appendFileSync(join(kb, 'sandbox/ledger.csv'), 'L-001,2026-10-15T10:00:00Z,A2,create,12 tasks,Sandbox,,,delete,fixture,\n');
  let result = check();
  assert.match(result.stdout, /fixture rows need a note/);
  write('sandbox/ledger.csv', 'id,time,class,action,object,location,object_id,before,undo,status,note\nL-001,2026-10-15T10:00:00Z,A2,create,12 tasks,Sandbox,,,delete,fixture,test data for s02\n');
  result = check();
  assert.equal(result.status, 0, result.stdout);
  result = check('--closing');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /L-001 is a fixture still in the product/);
});

test('human rows need a note, warn during the study and fail with --closing', () => {
  write('sandbox/ledger.csv', 'id,time,class,action,object,location,object_id,before,undo,status,note\nL-001,2026-10-15T10:00:00Z,incident,incident,mention of [person A],Sandbox,,,delete comment,human,deleting the comment would notify again; tell [person A] to ignore it\n');
  let result = check();
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /L-001 waits for the user/);
  result = check('--closing');
  assert.equal(result.status, 1);
});

test('barriers need evidence and are counted as BR IDs', () => {
  appendFileSync(join(kb, 'clone/barriers.md'), '\n| BR-001 | permissioned integration | blocks feature | F-001 | weeks |\n\n### BR-001 WhatsApp needs business verification\n- Severity: blocks feature\n- Blocks: F-001\n');
  appendFileSync(join(kb, 'inventory/features.md'), '| F-001 | Notifications | WhatsApp alerts | Business | P2 | | BR-001 | todo | |\n');
  let result = check();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /clone\/barriers\.md: BR-001 has no evidence tag/);
  appendFileSync(join(kb, 'clone/barriers.md'), '- Evidence: [doc SRC-001]\n');
  appendFileSync(join(kb, 'sources.md'), '| SRC-001 | WhatsApp Business Platform docs | https://developers.facebook.com/docs/whatsapp | docs | 2026-10-16 | verification |\n');
  result = check();
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /BR 1/);
  assert.match(check('--next').stdout, /BR-002/);
});

test('entity field rows need an evidence tag', () => {
  write('data-model/entities/E-001-deal.md', '# E-001 Deal\n\n## Fields\n\n| Field | Type | Required | Default | Constraints or enum | Source |\n|---|---|---|---|---|---|\n| title | string | yes | | | [doc SRC-001] |\n| value | number | no | 0 | | |\n\n## Not tested\n- None.\n');
  appendFileSync(join(kb, 'sources.md'), '| SRC-001 | API | https://example.com/api | api | 2026-10-15 | fields |\n');
  const result = check();
  assert.match(result.stdout, /E-001-deal\.md:8: fields row without an evidence tag/);
  assert.doesNotMatch(result.stdout, /E-001-deal\.md:7:/);
});

test('--git creates a repository for the KB even inside another repository', () => {
  const parent = join(dir, 'parent');
  spawnSync('git', ['init', '-q', parent]);
  const nested = join(parent, 're-nested');
  const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const result = spawnSync(process.execPath, [join(scripts, 'init-kb.mjs'), nested, '--product', 'Nested', '--git'], {
    encoding: 'utf8',
    env: { ...process.env, ...identity },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(nested, '.git')), 'KB has its own repository');
  const log = spawnSync('git', ['-C', nested, 'log', '--oneline'], { encoding: 'utf8' });
  assert.match(log.stdout, /Create knowledge base for Nested/);
});

test('--git without a git identity still creates the repository', () => {
  const target = join(dir, 're-no-identity');
  const empty = join(dir, 'empty-home');
  spawnSync('mkdir', ['-p', empty]);
  // useConfigOnly stops git from guessing an identity from the OS user, as on CI runners.
  const env = { ...process.env, HOME: empty, XDG_CONFIG_HOME: empty, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' };
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[key];
  const result = spawnSync(process.execPath, [join(scripts, 'init-kb.mjs'), target, '--product', 'X', '--git'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(target, '.git')));
  assert.match(result.stdout, /initial commit failed/);
});

test('open ledger rows warn, and fail with --closing', () => {
  appendFileSync(join(kb, 'sandbox/ledger.csv'), 'L-001,2026-10-15T10:00:00Z,A2,create,"task ""[RE] typical""",Sandbox,123,,delete task,open,\n');
  let result = check();
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /L-001 is still open/);
  assert.match(result.stdout, /says 0 open ledger rows, ledger has 1/);
  result = check('--closing');
  assert.equal(result.status, 1);
});

test('invalid ledger rows are errors', () => {
  appendFileSync(join(kb, 'sandbox/ledger.csv'), 'L-001,2026-10-15,A9,poke,thing,here,,,,kept,\n');
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /class must be one of/);
  assert.match(result.stdout, /action must be one of/);
  assert.match(result.stdout, /kept rows need a note/);
});

test('coverage cells are counted and invalid values flagged', () => {
  appendFileSync(join(kb, 'inventory/features.md'), '| F-001 | Deals | Board | Free | P1 | | | todo | |\n');
  appendFileSync(join(kb, 'inventory/coverage.md'), '| F-001 Board | done | partial | blocked: drag | todo | n/a | done | maybe | done | notes |\n');
  const result = check();
  assert.match(result.stdout, /Coverage cells: todo 1, partial 1, done 3, blocked 1, n\/a 1/);
  assert.match(result.stdout, /"maybe" is not one of/);
});

test('features without a coverage row are flagged', () => {
  appendFileSync(join(kb, 'inventory/features.md'), '| F-001 | Deals | Board | Free | P1 | | | todo | |\n');
  assert.match(check().stdout, /inventory\/coverage\.md: F-001 has no row/);
  appendFileSync(join(kb, 'inventory/coverage.md'), '| F-001 Board | todo | todo | todo | todo | todo | todo | todo | todo | todo | |\n');
  assert.doesNotMatch(check().stdout, /F-001 has no row/);
});

test('--closing fails on an unfilled charter; --help exits 0', () => {
  const closing = check('--closing');
  assert.equal(closing.status, 1);
  assert.match(closing.stdout, /Errors[\s\S]*00-charter\.md: template placeholders/);
  const help = run('check-kb.mjs', '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage/);
});

test('init-kb defaults to ./re-<product-slug>', () => {
  const result = spawnSync(process.execPath, [join(scripts, 'init-kb.mjs'), '--product', 'Ação CRM'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, 're-acao-crm', 'STATUS.md')));
});

// Lists and verifies a zip with Python's zipfile, an independent implementation.
const readZip = (file) => {
  const code = 'import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad": z.testzip(), "names": z.namelist(), "build": z.read([n for n in z.namelist() if n.endswith("/BUILD.md")][0]).decode()}))';
  const result = spawnSync('python3', ['-c', code, file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('pack-kb writes a valid zip with BUILD.md and without account details', () => {
  appendFileSync(join(kb, 'sandbox/ledger.csv'), 'L-001,2026-10-16T10:00:00Z,A2,create,task,Sandbox,,,delete,removed,\n');
  write('log/2026-10-16-s01.md', '# Session s01\n');
  const out = join(dir, 'handoff.zip');
  const result = run('pack-kb.mjs', kb, '--out', out);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Left out: sandbox\/, log\//);
  assert.ok(existsSync(join(kb, 'BUILD.md')), 'BUILD.md is added to the KB');
  const zip = readZip(out);
  assert.equal(zip.bad, null);
  assert.ok(zip.names.includes('re-acme/BUILD.md'));
  assert.ok(zip.names.includes('re-acme/clone/prd.md'));
  assert.ok(zip.names.includes('re-acme/evidence/index.csv'));
  assert.deepEqual(zip.names.filter((name) => name.includes('/sandbox/')), ['re-acme/sandbox/ledger.csv'], 'only the ledger is kept from sandbox/');
  assert.ok(!zip.names.some((name) => /\/(log|_templates)\//.test(name) || name.endsWith('.gitkeep')));
  assert.match(zip.build, /# Build brief: Acme CRM clone/);
  assert.doesNotMatch(zip.build, /\{\{/);

  const full = run('pack-kb.mjs', kb, '--out', join(dir, 'full.zip'), '--full');
  assert.equal(full.status, 0, full.stderr);
  assert.ok(readZip(join(dir, 'full.zip')).names.includes('re-acme/sandbox/environment.md'));
});

test('an unzipped handoff passes check-kb --closing; its ledger has no IDs, locations or URLs', () => {
  write('sandbox/ledger.csv', 'id,time,class,action,object,location,object_id,before,undo,status,note\nL-001,2026-10-16T10:00:00Z,A2,create,"task ""[RE] typical""",Acme Corp > Sales > 🧪 [RE] Sandbox,4471,,Delete it at https://acme.example.com/deal/4471,removed,verified by search\n');
  appendFileSync(join(kb, 'STATUS.md'), '- L-001 removed and verified.\n');
  write('00-charter.md', '# Charter: Acme CRM\n\nGoal: rebuild the deals board.\n');
  const out = join(dir, 'handoff.zip');
  const packed = run('pack-kb.mjs', kb, '--out', out);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  assert.match(packed.stdout, /Kept sandbox\/ledger\.csv without object IDs/);
  const target = join(dir, 'unzipped');
  const unzip = spawnSync('python3', ['-c', 'import sys,zipfile\nzipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', out, target], { encoding: 'utf8' });
  assert.equal(unzip.status, 0, unzip.stderr);

  const ledger = readFileSync(join(target, 're-acme', 'sandbox', 'ledger.csv'), 'utf8');
  assert.equal(ledger, 'id,time,class,action,object,location,object_id,before,undo,status,note\nL-001,2026-10-16T10:00:00Z,A2,create,"task ""[RE] typical""",,,,Delete it at [url],removed,verified by search\n');
  const result = run('check-kb.mjs', join(target, 're-acme'), '--closing');
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /Ledger: 1 rows, 0 open/);
});

test('build-report writes one self-contained page with linked IDs and escaped content', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  writeFileSync(join(kb, 'evidence/EV-001-board.png'), png);
  writeFileSync(join(kb, 'evidence/EV-002-api.json'), '{}');
  appendFileSync(join(kb, 'evidence/index.csv'), 'EV-001,2026-10-16,s01,/board,board anatomy,yes\nEV-002,2026-10-16,s01,/board,api shapes,n/a\n');
  appendFileSync(join(kb, 'inventory/features.md'), '| F-001 | Deals | Board | Free | P1 | S-001 | BR-001 | done | |\n');
  appendFileSync(join(kb, 'inventory/coverage.md'), '| F-001 Board | done | partial | blocked: drag | todo | n/a | done | done | done | done | |\n');
  write('screens/S-001-board.md', '# S-001 Board\nRules: R-001\n\n![Board](../evidence/EV-001-board.png)\n\n- Item\n  - Nested item\n\n## Not tested\n- Drag.\n');
  write('rules/board.md', '# Rules: board\n\n### R-001 Cards show <script>alert(1)</script> as text\n- Evidence: [obs EV-001]\n');
  appendFileSync(join(kb, 'clone/barriers.md'), '\n### BR-001 Example barrier\n- Severity: blocks launch (until approved)\n- Evidence: [doc SRC-001]\n');
  appendFileSync(join(kb, 'sources.md'), '| SRC-001 | Docs | https://example.com/docs | docs | 2026-10-16 | x |\n');
  const result = run('build-report.mjs', kb);
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(join(kb, 'REPORT.html'), 'utf8');
  assert.match(html, /<title>Acme CRM: reverse engineering report<\/title>/);
  for (const id of ['summary', 'barriers', 'screens', 'rules', 'evidence', 'S-001', 'R-001', 'BR-001', 'EV-001', 'EV-002', 'F-001', 'SRC-001']) {
    assert.match(html, new RegExp(`id="${id}"`), `anchor ${id}`);
  }
  assert.match(html, /<a href="#R-001">R-001<\/a>/);
  assert.match(html, /background-image:url\("data:image\/png;base64,/);
  assert.equal((html.match(/data:image\/png;base64,/g) || []).length, 1, 'each image is embedded once');
  assert.match(html, /<span class="pic full p1" role="img"[^>]*style="aspect-ratio:1\/1/, 'pictures keep their size from the file header');
  assert.match(html, /<span class="chip red">blocks launch<\/span> \(until approved\)/);
  assert.match(html, /<span class="chip amber">blocked: drag<\/span>/);
  assert.match(html, /<ul><li>Item<ul><li>Nested item<\/li><\/ul><\/li>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script[^>]+src|https?:\/\/[^"]*\.js\b/i, 'no external scripts');
  for (const link of html.match(/<link[^>]*>/g) || []) assert.match(link, /fonts\.(googleapis|gstatic)\.com/, `only Google Fonts: ${link}`);
  assert.match(html, /id="themeBtn"/, 'theme toggle');
  assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/g, ''), /\u2014/, 'no em dashes in the page');
  assert.match(html, /^<!doctype html>\n<!-- AI agents: [^>]*BUILD\.md/, 'agents are told where to read, in the source');
  assert.match(html, /If you are an AI agent<\/h3><p>[^<]*<code>BUILD\.md<\/code>/, 'and on the page');
  const order = [...html.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(order[0], 'summary');
  assert.ok(order.indexOf('rules') < order.indexOf('plan') && order.indexOf('plan') < order.indexOf('barriers'), `order: ${order.join(' > ')}`);
  assert.match(html, /<article class="card sev-red"><h\d id="BR-001">/, 'barriers are cards colored by severity');
  assert.equal(run('build-report.mjs', '--help').status, 0);

  const out = join(dir, 'report.zip');
  assert.equal(run('pack-kb.mjs', kb, '--out', out).status, 0);
  assert.ok(readZip(out).names.includes('re-acme/REPORT.html'));
});

test('build-report draws screens, components, flows and rules as designed views', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  for (const name of ['EV-001-board.png', 'EV-002-form.png', 'EV-003-toast.png']) writeFileSync(join(kb, 'evidence', name), png);
  appendFileSync(join(kb, 'evidence/index.csv'), 'EV-001,2026-10-16,s01,/board,"Board, annotated",yes\nEV-002,2026-10-16,s01,/board,Add form,yes\nEV-003,2026-10-16,s01,/board,Toast after save,yes\n');
  write('screens/S-001-board.md', '# S-001 Board\nFeatures: F-001 · URL: `/board` · Status: done\n\n## Purpose\n\nThe daily queue.\n\n## Anatomy\n\n![Board](../evidence/EV-001-board.png)\n\n| # | Region | Contents | Component | Evidence |\n|---|---|---|---|---|\n| 1 | Toolbar | Add and filter | C-001 | [obs EV-001] |\n\n## States\n\n| State | How to reach it | What it shows | Evidence |\n|---|---|---|---|\n| Empty | No items | Blank column | [obs EV-003] |\n| Error | none | not tested | none |\n\n## Interactions\n\n| Trigger | Result | Evidence |\n|---|---|---|\n| Click add | Form opens | [obs EV-002] |\n');
  write('components/C-001-add-form.md', '# C-001 Add form\nUsed in: S-001 · Status: done\n\n## Variants\n\n| Variant | Difference | Evidence |\n|---|---|---|\n| Compact | Fewer fields | [obs EV-002] |\n\n## States\n\n| State | Visual change | Evidence |\n|---|---|---|\n| Default | White | [obs EV-002] |\n| Hover | not measured | none |\n\n## Behavior\n\n- Saving closes the form [obs EV-003].\n');
  write('flows/FL-001-create.md', '# FL-001 Create an item\nUser goal: add work · Features: F-001 · Status: done\n\n## Steps\n\n| # | Screen | User action | System response | Evidence |\n|---|---|---|---|---|\n| 1 | S-001 | Click add | Form opens | [obs EV-002] |\n| 2 | S-001 | Save | Toast | [obs EV-003] |\n| 3 | S-001 | Wait | Nothing | none |\n\n## Branches and errors\n\n| At step | Condition | What happens | Evidence |\n|---|---|---|---|\n| 2 | Title empty | Error under the field | [obs EV-002] |\n\n## Not tested\n\n- Keyboard only.\n');
  write('rules/board.md', '# Rules: board\n\n### R-001 Saving needs a title\n- Given an empty title\n- When the user saves\n- Then an error shows\n- Evidence: [obs EV-002]\n- Feature: F-001 · Screen: S-001\n');
  const result = run('build-report.mjs', kb);
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(join(kb, 'REPORT.html'), 'utf8');
  assert.equal((html.match(/data:image\/png;base64,/g) || []).length, 3, 'three images, each embedded once although reused');
  assert.match(html, /<article class="obj screen" id="S-001">/);
  assert.match(html, /<div class="anat"><figure><div class="shot"><span class="pic full/, 'anatomy image next to its legend');
  assert.match(html, /<ol class="lg"><li><span class="n">1<\/span><div><b>Toolbar<\/b> <span class="op"><a href="#C-001">C-001<\/a><\/span>/);
  assert.match(html, /Board, annotated/, 'captions come from evidence/index.csv, quoted commas kept');
  assert.match(html, /<div class="stt"><b>Empty<\/b>/);
  assert.match(html, /Not reached:<\/b> Error/);
  assert.match(html, /<article class="obj comp" id="C-001">/);
  assert.match(html, /<span class="pill" title="White">Default<\/span><span class="pill off" title="not measured">Hover<\/span>/);
  assert.match(html, /<ol class="flow"><li class="st"><div class="shot t"><span class="pic thumb/);
  assert.match(html, /<div class="shot t empty"><span>S-001<\/span><\/div>/, 'a step without a picture shows its screen');
  assert.equal((html.match(/<li class="st">/g) || []).length, 3);
  assert.match(html, /<div class="brn"><span class="at">Step 2<\/span>/);
  assert.match(html, /<article class="rule" id="R-001">[\s\S]*?<dt>Given<\/dt><dd>an empty title<\/dd><dt>When<\/dt>/);
  const order = [...html.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order.slice(0, 6), ['summary', 'features', 'screens', 'components', 'flows', 'rules']);
});

test('build-report degrades when screens, flows and images are missing', () => {
  write('components/C-001-x.md', '# C-001 Bare component\nUsed in: S-009\n');
  const result = run('build-report.mjs', kb);
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(join(kb, 'REPORT.html'), 'utf8');
  assert.match(html, /No screenshot in the evidence/);
  assert.doesNotMatch(html, /<section id="flows"/);
  assert.doesNotMatch(html, /<section id="screens"/);
});

test('pack-kb refuses a KB with errors unless --force', () => {
  write('rules/a.md', '### R-001 No evidence\n- Given x\n');
  const refused = run('pack-kb.mjs', kb, '--out', join(dir, 'x.zip'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /R-001 has no evidence tag[\s\S]*--force/);
  assert.ok(!existsSync(join(dir, 'x.zip')));
  const forced = run('pack-kb.mjs', kb, '--out', join(dir, 'x.zip'), '--force');
  assert.equal(forced.status, 0);
  assert.match(forced.stdout, /Packed with --force/);
  assert.equal(run('pack-kb.mjs', '--help').status, 0);
});

test('--next prints the next free ID per prefix', () => {
  appendFileSync(join(kb, 'inventory/features.md'), '| F-007 | Deals | Board | Free | P1 | | | todo | |\n');
  write('evidence/EV-012-x.png', 'png');
  const result = check('--next');
  assert.match(result.stdout, /F-008/);
  assert.match(result.stdout, /EV-013/);
  assert.match(result.stdout, /R-001/);
});
