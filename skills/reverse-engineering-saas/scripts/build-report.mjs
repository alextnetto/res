#!/usr/bin/env node
// Builds REPORT.html, the main report a person reads: one self-contained page
// laid out like a design study (screens, components and flows first-class),
// rendered from the knowledge base's Markdown. Images are embedded once as
// base64 and reused by class; the only script is an inline theme toggle and
// image zoom. No dependencies.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: node build-report.mjs <kb-dir> [--out <file.html>] [--help]';
const ID_PATTERN = /\b(FL|SRC|EV|BR|F|S|C|R|E|B|Q|L)-(\d{3})\b/g;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const COVERAGE = ['done', 'partial', 'blocked', 'todo', 'n/a'];
const CHIP_WORDS = /^(blocks launch|blocks feature|adds lead time|adds cost|moat|required to sell|important|minor)\b/i;
const CATALOG_FILES = ['inventory/features.md', 'inventory/screens.md', 'sources.md', 'questions.md', 'findings.md'];
const UNSEEN = /^\s*(not tested|not measured|not reached|not studied|not seen|none seen|none|n\/a|unknown)\b/i;
const GALLERY_LIMIT = 6;

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Files saved on Windows end lines with CRLF; the parsers expect LF.
const read = (kb, file) => (existsSync(join(kb, file)) ? readFileSync(join(kb, file), 'utf8').replace(/\r\n?/g, '\n') : '');
// A comment on its own line goes with its line, so tables around it stay intact.
const stripComments = (text) => text.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n/gm, '').replace(/<!--[\s\S]*?-->/g, '');
const listDir = (kb, dir, filter = () => true) =>
  existsSync(join(kb, dir)) ? readdirSync(join(kb, dir)).filter((name) => !name.startsWith('.') && filter(name)).sort().map((name) => `${dir}/${name}`) : [];
const unique = (items) => [...new Set(items)];

// Everything the renderer needs to resolve images and links.
function makeContext(kb) {
  const anchors = new Set();
  const fileIds = new Map();
  const evidence = new Map();
  for (const dir of ['screens', 'components', 'flows', 'data-model/entities']) {
    for (const file of listDir(kb, dir, (name) => name.endsWith('.md'))) {
      const id = basename(file).match(/^([A-Z]+-\d{3})/)?.[1];
      if (id) {
        fileIds.set(file, id);
        anchors.add(id);
      }
    }
  }
  for (const file of listDir(kb, 'evidence')) {
    const id = basename(file).match(/^(EV-\d{3})/)?.[1];
    if (id) {
      evidence.set(id, file);
      anchors.add(id);
    }
  }
  const markdown = [...CATALOG_FILES, 'clone/barriers.md', ...listDir(kb, 'rules', (name) => name.endsWith('.md'))];
  for (const file of markdown) {
    for (const line of stripComments(read(kb, file)).split('\n')) {
      const id = line.match(/^#{1,6}\s+([A-Z]+-\d{3})\b/)?.[1] || (CATALOG_FILES.includes(file) && line.match(/^\|\s*([A-Z]+-\d{3})\s*\|/)?.[1]);
      if (id) anchors.add(id);
    }
  }
  return { kb, anchors, fileIds, evidence, captions: readEvidenceIndex(kb), emitted: new Set(), pics: new Map() };
}

// evidence/index.csv: id,date,session,route,shows,masked. Quoted fields may hold commas.
function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

function readEvidenceIndex(kb) {
  const captions = new Map();
  const lines = read(kb, 'evidence/index.csv').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return captions;
  const head = parseCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase());
  const at = head.indexOf('shows') >= 0 ? head.indexOf('shows') : 4;
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const id = cells[0]?.trim();
    if (/^EV-\d{3}$/.test(id) && cells[at]) captions.set(id, cells[at].trim());
  }
  return captions;
}

// Pixel size from the file header, so each picture keeps its shape without layout shift.
function imageSize(buf, ext) {
  try {
    if (ext === '.png' && buf.length > 24) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    if (ext === '.gif' && buf.length > 10) return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
    if (ext === '.jpg' || ext === '.jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (ext === '.webp' && buf.length > 30) {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
      if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
      if (kind === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
      }
    }
  } catch {
    // Fall through to the default shape.
  }
  return [16, 10];
}

const isImage = (file) => Boolean(file && MIME[extname(file).toLowerCase()]);
const kbPath = (ctx, baseDir, src) => relative(ctx.kb, resolve(ctx.kb, baseDir, src)).split(sep).join('/');
const evOf = (file) => (file ? basename(file).match(/^(EV-\d{3})/)?.[1] ?? null : null);

// Registers an image once and returns its class; the bytes go into one stylesheet rule.
function registerPic(ctx, file) {
  if (ctx.pics.has(file)) return ctx.pics.get(file);
  const ext = extname(file).toLowerCase();
  if (!MIME[ext] || !existsSync(join(ctx.kb, file))) return null;
  const buf = readFileSync(join(ctx.kb, file));
  const [w, h] = imageSize(buf, ext);
  const pic = { cls: `p${ctx.pics.size + 1}`, w: w || 16, h: h || 10, uri: `data:${MIME[ext]};base64,${buf.toString('base64')}` };
  ctx.pics.set(file, pic);
  return pic;
}

// A picture element. kind "full" keeps the image's own shape; "thumb" crops to a fixed frame.
function pic(ctx, file, alt, kind = 'full') {
  const p = registerPic(ctx, file);
  if (!p) return '';
  const style = kind === 'full' ? ` style="aspect-ratio:${p.w}/${p.h};max-width:${p.w}px"` : '';
  return `<span class="pic ${kind} ${p.cls}" role="img" tabindex="0" aria-label="${escapeHtml(alt)}"${style}></span>`;
}

const evFile = (ctx, id) => (id && isImage(ctx.evidence.get(id)) ? ctx.evidence.get(id) : null);
const evCaption = (ctx, id) => ctx.captions.get(id) || basename(ctx.evidence.get(id) || id).replace(/^EV-\d{3}-?/, '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ');
const evIds = (text) => unique(text.match(/\bEV-\d{3}\b/g) || []);

function shot(ctx, id, kind = 'full') {
  const file = evFile(ctx, id);
  if (!file) return '';
  const text = evCaption(ctx, id);
  return `<figure><div class="shot${kind === 'thumb' ? ' t' : ''}">${pic(ctx, file, `${id}: ${text}`, kind)}</div><figcaption><a class="evl" href="#${id}">${id}</a> ${escapeHtml(text)}</figcaption></figure>`;
}

// Turns a Markdown link target into an in-page anchor or an external URL.
function resolveHref(ctx, href, baseDir) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('#')) return href;
  const target = kbPath(ctx, baseDir, href.split('#')[0]);
  const id = ctx.fileIds.get(target) || basename(target).match(/^(EV-\d{3}|[A-Z]+-\d{3})/)?.[1];
  return id && ctx.anchors.has(id) ? `#${id}` : null;
}

function linkIds(ctx, escaped) {
  return escaped.replace(ID_PATTERN, (id) => (ctx.anchors.has(id) ? `<a href="#${id}">${id}</a>` : id));
}

const INLINE = /(`[^`]+`)|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g;

function renderInline(ctx, text, baseDir) {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    html += linkIds(ctx, escapeHtml(text.slice(last, match.index)));
    last = match.index + match[0].length;
    const [, code, alt, src, label, href, bold, italic] = match;
    if (code) html += `<code>${linkIds(ctx, escapeHtml(code.slice(1, -1)))}</code>`;
    else if (src !== undefined) {
      const element = pic(ctx, kbPath(ctx, baseDir, src), alt);
      html += element ? `<span class="shot inl">${element}</span>` : `<span class="missing">[image not found: ${escapeHtml(src)}]</span>`;
    } else if (label !== undefined) {
      const target = resolveHref(ctx, href, baseDir);
      const inner = renderInline(ctx, label, baseDir);
      html += target ? `<a href="${escapeHtml(target)}">${inner}</a>` : inner;
    } else if (bold) html += `<strong>${renderInline(ctx, bold, baseDir)}</strong>`;
    else if (italic) html += `<em>${renderInline(ctx, italic, baseDir)}</em>`;
  }
  return html + linkIds(ctx, escapeHtml(text.slice(last)));
}

// Chips for barrier severity, market weight and coverage values.
function chipClass(value) {
  const v = value.toLowerCase();
  if (/blocks launch|required to sell/.test(v)) return 'red';
  if (/blocks feature|important|blocked/.test(v)) return 'amber';
  if (/lead time|adds cost|partial/.test(v)) return 'blue';
  if (/done|reviewed/.test(v)) return 'green';
  return 'gray';
}

function renderCell(ctx, cell, baseDir) {
  const value = cell.trim();
  const coverage = COVERAGE.find((word) => value.toLowerCase() === word || value.toLowerCase().startsWith(`${word}:`) || value.toLowerCase().startsWith(`${word} `));
  if (coverage) return `<span class="chip ${chipClass(coverage)}">${escapeHtml(value)}</span>`;
  const keyword = value.match(CHIP_WORDS)?.[1];
  if (keyword) return `<span class="chip ${chipClass(keyword)}">${escapeHtml(keyword)}</span>${renderInline(ctx, value.slice(keyword.length), baseDir)}`;
  if (/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(value)) return `<span class="swatch" style="background:${escapeHtml(value)}"></span>${escapeHtml(value)}`;
  if (UNSEEN.test(value) && value.length < 60) return `<span class="dim">${renderInline(ctx, value, baseDir)}</span>`;
  return renderInline(ctx, value, baseDir);
}

const splitRow = (line) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());

function renderTable(ctx, lines, baseDir, file) {
  const [head, , ...rows] = lines;
  const heads = splitRow(head).map((cell) => `<th>${renderInline(ctx, cell, baseDir)}</th>`).join('');
  const body = rows
    .map((line) => {
      const cells = splitRow(line);
      const id = CATALOG_FILES.includes(file) && cells[0]?.match(/^([A-Z]+-\d{3})$/)?.[1];
      const attr = id && !ctx.emitted.has(id) && ![...ctx.fileIds.values()].includes(id) ? ` id="${id}"` : '';
      if (attr) ctx.emitted.add(id);
      return `<tr${attr}>${cells.map((cell, index) => `<td${index === 0 && /^[A-Z]+-\d{3}/.test(cell) ? ' class="k"' : ''}>${renderCell(ctx, cell, baseDir)}</td>`).join('')}</tr>`;
    })
    .join('');
  return `<div class="tbl-wrap"><table><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// "Severity: blocks feature (until approval)" shows the keyword as a chip and the rest as text.
function renderListItem(ctx, text, baseDir) {
  const field = text.match(/^(Severity|Market weight):\s*(.+)$/);
  const keyword = field?.[2].match(CHIP_WORDS)?.[1];
  if (!keyword) return renderInline(ctx, text, baseDir);
  const rest = field[2].slice(keyword.length);
  return `${field[1]}: <span class="chip ${chipClass(keyword)}">${escapeHtml(keyword)}</span>${renderInline(ctx, rest, baseDir)}`;
}

// Nested lists: an item indented deeper than the current level belongs to the previous item.
function renderList(ctx, items, start, indent, baseDir) {
  const tag = items[start].ordered ? 'ol' : 'ul';
  let html = `<${tag}>`;
  let i = start;
  while (i < items.length && items[i].indent >= indent) {
    if (items[i].indent > indent) {
      const [nested, next] = renderList(ctx, items, i, items[i].indent, baseDir);
      html = html.replace(/<\/li>$/, `${nested}</li>`);
      i = next;
      continue;
    }
    html += `<li>${renderListItem(ctx, items[i].text, baseDir)}</li>`;
    i += 1;
  }
  return [`${html}</${tag}>`, i];
}

// Renders the Markdown subset the knowledge base uses.
function renderMarkdown(ctx, markdown, file, headingShift = 0) {
  const baseDir = dirname(file);
  const lines = stripComments(markdown).split('\n');
  const out = [];
  let paragraph = [];
  let card = null;
  const flush = () => {
    if (paragraph.length) out.push(`<p>${renderInline(ctx, paragraph.join(' '), baseDir)}</p>`);
    paragraph = [];
  };
  // A rule or barrier section becomes a card, colored by its severity when it has one.
  const closeCard = () => {
    if (!card) return;
    flush();
    const body = out.splice(card.start).join('\n');
    const severity = body.match(/Severity: <span class="chip (\w+)"/)?.[1];
    out.push(`<article class="card${severity ? ` sev-${severity}` : ''}">${body}</article>`);
    card = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      flush();
      const code = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i]); i += 1) code.push(lines[i]);
      out.push(`<pre class="${fence[1] || 'text'}"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(6, heading[1].length + headingShift);
      const [, id, rest] = heading[2].match(/^([A-Z]+-\d{3})\b\s*(.*)$/) || [];
      if (card && level <= card.level) closeCard();
      const attr = id && !ctx.emitted.has(id) ? ` id="${id}"` : '';
      if (attr) ctx.emitted.add(id);
      if (id && /^(R|BR)-/.test(id)) card = { level, start: out.length };
      const title = id ? `<a class="id" href="#${id}">${id}</a> ${renderInline(ctx, rest, baseDir)}` : renderInline(ctx, heading[2], baseDir);
      out.push(`<h${level}${attr}>${title}</h${level}>`);
      continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      flush();
      const table = [];
      for (; i < lines.length && lines[i].trim().startsWith('|'); i += 1) table.push(lines[i]);
      i -= 1;
      out.push(renderTable(ctx, table, baseDir, file));
      continue;
    }
    const item = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (item) {
      flush();
      const items = [];
      for (; i < lines.length; i += 1) {
        const next = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (next) items.push({ indent: next[1].length, ordered: /\d/.test(next[2]), text: next[3] });
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1].text += ` ${lines[i].trim()}`;
        else break;
      }
      i -= 1;
      out.push(renderList(ctx, items, 0, items[0].indent, baseDir)[0]);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const quote = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i += 1) quote.push(lines[i].replace(/^>\s?/, ''));
      i -= 1;
      out.push(`<blockquote>${renderInline(ctx, quote.join(' '), baseDir)}</blockquote>`);
      continue;
    }
    if (/^-{3,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  closeCard();
  return out.join('\n');
}

// ---------- Structured reading of artifact files ----------

// Splits an artifact file into its H1 title, the meta line under it, and its "## " parts.
function parseArtifact(text) {
  const clean = stripComments(text);
  const title = clean.match(/^#\s+(.*)$/m)?.[1]?.trim() ?? '';
  const [, id, name] = title.match(/^([A-Z]+-\d{3})\b\s*(.*)$/) || [null, null, title];
  const heads = [...clean.matchAll(/^##\s+(.+)$/gm)];
  const intro = (heads.length ? clean.slice(0, heads[0].index) : clean).replace(/^#\s+.*$/m, '');
  const metaLine = intro.split('\n').map((line) => line.trim()).find((line) => line && !/^[!|]/.test(line)) || '';
  const parts = new Map();
  const order = [];
  heads.forEach((match, index) => {
    const end = index + 1 < heads.length ? heads[index + 1].index : clean.length;
    const key = match[1].trim();
    parts.set(key.toLowerCase(), clean.slice(match.index + match[0].length, end));
    order.push(key);
  });
  // Whatever else sits between the meta line and the first part (lists, notes), minus lone images.
  const introRest = intro.split('\n').filter((line) => line.trim() !== metaLine && !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line)).join('\n').trim();
  return { id, name: name || title, metaLine, introRest, parts, order, text: clean };
}

const part = (artifact, ...names) => names.map((name) => artifact.parts.get(name.toLowerCase())).find((value) => value !== undefined) ?? '';

// First Markdown table in a block, as lower-case header cells and rows of cells.
function parseTable(block) {
  const lines = block.split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (lines[i].trim().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const rows = [];
      for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j += 1) rows.push(splitRow(lines[j]));
      return { head: splitRow(lines[i]).map((cell) => cell.toLowerCase()), rows };
    }
  }
  return { head: [], rows: [] };
}

// Index of the first header that matches one of the names, or the fallback.
const col = (table, fallback, ...names) => {
  for (const name of names) {
    const index = table.head.findIndex((cell) => cell === name || cell.startsWith(name));
    if (index >= 0) return index;
  }
  return fallback;
};

const listItems = (block) => block.split('\n').map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1]).filter(Boolean);
const paragraphs = (block) => block.split(/\n\s*\n/).map((chunk) => chunk.trim()).filter((chunk) => chunk && !/^[|!#`>-]/.test(chunk) && !/^\d+\./.test(chunk));
const firstImage = (ctx, text, baseDir) => {
  const src = text.match(/!\[[^\]]*\]\(([^)\s]+)\)/)?.[1];
  return src ? kbPath(ctx, baseDir, src) : null;
};

// "Features: F-001 · URL: `/x` · Status: done" as key and value pairs.
function metaPills(ctx, line, baseDir) {
  if (!line) return '';
  const items = line.split(/\s+·\s+/).map((chunk) => chunk.match(/^([^:`]{1,40}):\s*(.+)$/)).filter(Boolean);
  if (!items.length) return `<p class="kvs">${renderInline(ctx, line, baseDir)}</p>`;
  return `<div class="kvs">${items
    .map(([, key, value]) => {
      const inner = /^status$/i.test(key.trim()) ? `<span class="chip ${chipClass(value)}">${escapeHtml(value)}</span>` : `<span>${renderInline(ctx, value, baseDir)}</span>`;
      return `<span class="kv"><b>${escapeHtml(key.trim())}</b>${inner}</span>`;
    })
    .join('')}</div>`;
}

function anchor(ctx, id) {
  if (!id || ctx.emitted.has(id)) return '';
  ctx.emitted.add(id);
  return ` id="${id}"`;
}

function objectHeader(ctx, artifact, file) {
  const intro = artifact.introRest ? `<div class="intro">${renderMarkdown(ctx, artifact.introRest, file, 3)}</div>` : '';
  return `<div class="oh">${artifact.id ? `<span class="id">${artifact.id}</span>` : ''}<h3>${renderInline(ctx, artifact.name, dirname(file))}</h3></div>${metaPills(ctx, artifact.metaLine, dirname(file))}${intro}`;
}

// The parts of a file not shown in the designed view, rendered as plain notes.
function restNotes(ctx, artifact, file, skip, label) {
  const keep = artifact.order.filter((name) => !skip.includes(name.toLowerCase()));
  if (!keep.length) return '';
  const md = keep.map((name) => `## ${name}\n${artifact.parts.get(name.toLowerCase())}`).join('\n');
  return `<details class="notes"><summary>${escapeHtml(label)} <span class="dim">${escapeHtml(keep.join(', ').toLowerCase())}</span></summary><div class="nb">${renderMarkdown(ctx, md, file, 2)}</div></details>`;
}

// ---------- Screens ----------

function renderScreen(ctx, file) {
  const artifact = parseArtifact(read(ctx.kb, file));
  const baseDir = dirname(file);
  const purpose = paragraphs(part(artifact, 'Purpose')).map((p) => `<p>${renderInline(ctx, p, baseDir)}</p>`).join('');
  const anatomyBlock = part(artifact, 'Anatomy', 'Layout');
  const anatomy = parseTable(anatomyBlock);
  const linked = firstImage(ctx, anatomyBlock, baseDir) || firstImage(ctx, artifact.text, baseDir);
  const shots = evIds(artifact.text).filter((id) => evFile(ctx, id));
  const main = linked && isImage(linked) && existsSync(join(ctx.kb, linked)) ? linked : evFile(ctx, shots[0]);
  const mainId = evOf(main);
  const rest = shots.filter((id) => id !== mainId);

  const iRegion = col(anatomy, 1, 'region', 'part');
  const iContent = col(anatomy, 2, 'contents', 'content');
  const iComp = col(anatomy, -1, 'component');
  const legend = anatomy.rows.length
    ? `<ol class="lg">${anatomy.rows
        .map((row) => {
          const comp = iComp >= 0 && row[iComp] && !UNSEEN.test(row[iComp]) ? ` <span class="op">${renderInline(ctx, row[iComp], baseDir)}</span>` : '';
          return `<li><span class="n">${escapeHtml(row[0] || '')}</span><div><b>${renderInline(ctx, row[iRegion] || '', baseDir)}</b>${comp}<span>${renderInline(ctx, row[iContent] || '', baseDir)}</span></div></li>`;
        })
        .join('')}</ol>`
    : '';
  let anat = '';
  if (main) {
    const cap = mainId ? evCaption(ctx, mainId) : artifact.name;
    const figure = `<figure><div class="shot">${pic(ctx, main, `${artifact.name}: ${cap}`)}</div><figcaption>${mainId ? `<a class="evl" href="#${mainId}">${mainId}</a> ` : ''}${escapeHtml(cap)}</figcaption></figure>`;
    anat = legend ? `<div class="anat">${figure}<div><p class="cap-h">Anatomy</p>${legend}</div></div>` : figure;
  } else if (legend) anat = `<p class="cap-h">Anatomy</p>${legend}`;

  const thumbs = rest.map((id) => shot(ctx, id, 'thumb'));
  const gallery = thumbs.length
    ? `<p class="cap-h">More from this screen <span class="dim">${thumbs.length} screenshot${thumbs.length > 1 ? 's' : ''}</span></p><div class="g3">${thumbs.slice(0, GALLERY_LIMIT).join('')}</div>${
        thumbs.length > GALLERY_LIMIT ? `<details class="more"><summary>Show ${thumbs.length - GALLERY_LIMIT} more</summary><div class="g3">${thumbs.slice(GALLERY_LIMIT).join('')}</div></details>` : ''
      }`
    : '';

  const states = parseTable(part(artifact, 'States'));
  let statesHtml = '';
  if (states.rows.length) {
    const iShow = col(states, 2, 'what it shows', 'visual', 'shows');
    const seen = states.rows.filter((row) => !UNSEEN.test(row[iShow] || ''));
    const unseen = states.rows.filter((row) => UNSEEN.test(row[iShow] || ''));
    statesHtml = `<p class="cap-h">States</p>${seen.length ? `<div class="states">${seen
      .map((row) => `<div class="stt"><b>${renderInline(ctx, row[0], baseDir)}</b><span>${renderInline(ctx, row[iShow] || '', baseDir)}</span></div>`)
      .join('')}</div>` : ''}${unseen.length ? `<p class="unseen"><b>Not reached:</b> ${unseen.map((row) => escapeHtml(row[0])).join(', ')}</p>` : ''}`;
  }

  const notes = restNotes(ctx, artifact, file, ['purpose', 'anatomy', 'layout', 'states'], 'Full screen notes');
  return `<article class="obj screen"${anchor(ctx, artifact.id)}>${objectHeader(ctx, artifact, file)}${purpose}${anat}${gallery}${statesHtml}${notes}</article>`;
}

// ---------- Components ----------

function pills(ctx, rows, detailIndex, baseDir) {
  return rows
    .map((row) => {
      const detail = row[detailIndex] || '';
      return `<span class="pill${UNSEEN.test(detail) ? ' off' : ''}" title="${escapeHtml(detail)}">${renderInline(ctx, row[0], baseDir)}</span>`;
    })
    .join('');
}

function renderComponent(ctx, file) {
  const artifact = parseArtifact(read(ctx.kb, file));
  const baseDir = dirname(file);
  const linked = firstImage(ctx, artifact.text, baseDir);
  const img = linked && isImage(linked) && existsSync(join(ctx.kb, linked)) ? linked : evIds(artifact.text).map((id) => evFile(ctx, id)).find(Boolean);
  const imgId = evOf(img);
  const visual = img
    ? `<figure><div class="shot t">${pic(ctx, img, `${artifact.name}${imgId ? `: ${evCaption(ctx, imgId)}` : ''}`, 'thumb')}</div>${imgId ? `<figcaption><a class="evl" href="#${imgId}">${imgId}</a> ${escapeHtml(evCaption(ctx, imgId))}</figcaption>` : ''}</figure>`
    : '<div class="shot t empty"><span>No screenshot in the evidence</span></div>';
  const variants = parseTable(part(artifact, 'Variants'));
  const states = parseTable(part(artifact, 'States'));
  const behavior = listItems(part(artifact, 'Behavior', 'Behaviour'));
  const vDetail = col(variants, 1, 'difference', 'what');
  const sDetail = col(states, 1, 'visual change', 'visual', 'what');
  const seenStates = states.rows.filter((row) => !UNSEEN.test(row[sDetail] || '')).length;
  const body = [
    variants.rows.length ? `<p class="lbl">Variants</p><div class="pills">${pills(ctx, variants.rows, vDetail, baseDir)}</div>` : '',
    states.rows.length ? `<p class="lbl">States <span class="dim">${seenStates} of ${states.rows.length} observed</span></p><div class="pills">${pills(ctx, states.rows, sDetail, baseDir)}</div>` : '',
    behavior.length ? `<p class="lbl">Behavior</p><ul class="beh">${behavior.slice(0, 4).map((item) => `<li>${renderInline(ctx, item, baseDir)}</li>`).join('')}</ul>${behavior.length > 4 ? `<p class="dim small">${behavior.length - 4} more in the notes.</p>` : ''}` : '',
  ].join('');
  const notes = restNotes(ctx, artifact, file, ['behavior', 'behaviour'], 'Full component notes');
  return `<article class="obj comp"${anchor(ctx, artifact.id)}>${visual}<div class="cb">${objectHeader(ctx, artifact, file)}${body}${notes}</div></article>`;
}

// ---------- Flows ----------

function renderFlow(ctx, file) {
  const artifact = parseArtifact(read(ctx.kb, file));
  const baseDir = dirname(file);
  const steps = parseTable(part(artifact, 'Steps'));
  const iNum = col(steps, 0, '#', 'step');
  const iScreen = col(steps, -1, 'screen');
  const iAction = col(steps, 2, 'user action', 'action');
  const iResp = col(steps, 3, 'system response', 'response', 'result');
  const iEv = col(steps, -1, 'evidence');
  const hint = steps.rows.length > 4 ? `<p class="hint dim small">${steps.rows.length} steps. On a wide screen, scroll the strip sideways to see them all.</p>` : '';
  const strip = steps.rows.length
    ? `${hint}<ol class="flow">${steps.rows
        .map((row, index) => {
          const evs = evIds(iEv >= 0 ? row[iEv] || '' : row.join(' '));
          const imgId = evs.find((id) => evFile(ctx, id));
          const screenName = iScreen >= 0 ? row[iScreen] || '' : '';
          const screen = screenName ? `<span class="op">${renderInline(ctx, screenName, baseDir)}</span>` : '';
          const thumb = imgId
            ? `<div class="shot t">${pic(ctx, evFile(ctx, imgId), `Step ${index + 1}: ${evCaption(ctx, imgId)}`, 'thumb')}</div>`
            : `<div class="shot t empty"><span>${screenName ? escapeHtml(screenName) : 'No screenshot'}</span></div>`;
          return `<li class="st">${thumb}<div class="sb"><div class="sh"><span class="n">${escapeHtml(row[iNum] || String(index + 1))}</span>${screen}</div><b>${renderInline(ctx, row[iAction] || '', baseDir)}</b><span>${renderInline(ctx, row[iResp] || '', baseDir)}</span>${evs.length ? `<span class="evs">${evs.map((id) => linkIds(ctx, id)).join(' ')}</span>` : ''}</div></li>`;
        })
        .join('')}</ol>`
    : renderMarkdown(ctx, part(artifact, 'Steps'), file, 2);
  const branches = parseTable(part(artifact, 'Branches and errors', 'Branches'));
  const bAt = col(branches, 0, 'at step', 'step');
  const bIf = col(branches, 1, 'condition', 'if');
  const bThen = col(branches, 2, 'what happens', 'result', 'then');
  const branchHtml = branches.rows.length
    ? `<p class="cap-h">Branches and errors</p><div class="branches">${branches.rows
        .map((row) => {
          const outcome = row[bThen] || '';
          return `<div class="brn${UNSEEN.test(outcome) ? ' off' : ''}"><span class="at">Step ${escapeHtml(row[bAt] || '?')}</span><div><b>${renderInline(ctx, row[bIf] || '', baseDir)}</b><span class="arrow" aria-hidden="true"></span><span>${renderInline(ctx, outcome, baseDir)}</span></div></div>`;
        })
        .join('')}</div>`
    : '';
  const untested = listItems(part(artifact, 'Not tested'));
  const untestedHtml = untested.length
    ? `<div class="caution"><span class="ic">!</span><div><b class="h">Not tested</b>${untested.map((item) => `<p>${renderInline(ctx, item, baseDir)}</p>`).join('')}</div></div>`
    : '';
  const diagram = part(artifact, 'Diagram');
  const diagramHtml = diagram.trim() ? `<details class="notes"><summary>Diagram source <span class="dim">mermaid</span></summary><div class="nb">${renderMarkdown(ctx, diagram, file, 2)}</div></details>` : '';
  const notes = restNotes(ctx, artifact, file, ['steps', 'branches and errors', 'branches', 'not tested', 'diagram'], 'More notes');
  return `<article class="obj flowc"${anchor(ctx, artifact.id)}>${objectHeader(ctx, artifact, file)}${strip}${branchHtml}${untestedHtml}${diagramHtml}${notes}</article>`;
}

// ---------- Rules ----------

const GWT = /^(Given|When|Then|And|But)\b\s*(.*)$/i;

function renderRuleFile(ctx, file) {
  const text = stripComments(read(ctx.kb, file));
  const title = text.match(/^#\s+(.*)$/m)?.[1] ?? basename(file, '.md');
  const baseDir = dirname(file);
  const blocks = text.split(/^(?=#{2,6}\s+R-\d{3}\b)/m);
  const lead = blocks[0].replace(/^#\s+.*$/m, '').trim();
  const cards = blocks.slice(1).map((block) => {
    const lines = block.split('\n');
    const [, id, name] = lines[0].match(/^#{2,6}\s+(R-\d{3})\b\s*(.*)$/);
    const items = [];
    const extra = [];
    for (const line of lines.slice(1)) {
      const item = line.match(/^\s*[-*]\s+(.*)$/)?.[1];
      if (item !== undefined && !extra.length) items.push(item);
      else if (/^\s{2,}\S/.test(line) && items.length && !extra.length) items[items.length - 1] += ` ${line.trim()}`;
      else if (line.trim() || extra.length) extra.push(line);
    }
    const gwt = items.filter((item) => GWT.test(item));
    const meta = items.filter((item) => !GWT.test(item));
    const dl = gwt.length
      ? `<dl class="gwt">${gwt
          .map((item) => {
            const [, word, rest] = item.match(GWT);
            return `<dt>${escapeHtml(word[0].toUpperCase() + word.slice(1).toLowerCase())}</dt><dd>${renderInline(ctx, rest, baseDir)}</dd>`;
          })
          .join('')}</dl>`
      : '';
    const foot = meta.length ? `<div class="rf">${meta.map((item) => `<span>${renderInline(ctx, item, baseDir)}</span>`).join('')}</div>` : '';
    const more = extra.join('\n').trim() ? `<div class="rx">${renderMarkdown(ctx, extra.join('\n'), file, 3)}</div>` : '';
    return `<article class="rule"${anchor(ctx, id)}><h4><a class="id" href="#${id}">${id}</a> ${renderInline(ctx, name, baseDir)}</h4>${dl}${foot}${more}</article>`;
  });
  return `<h3 class="grp-h">${renderInline(ctx, title.replace(/^Rules:\s*/i, '').replace(/^\w/, (c) => c.toUpperCase()), baseDir)} <span class="dim">${cards.length} rule${cards.length === 1 ? '' : 's'}</span></h3>${lead ? renderMarkdown(ctx, lead, file, 2) : ''}${cards.length ? `<div class="rules">${cards.join('')}</div>` : ''}`;
}

// ---------- Other sections ----------

// Collapsible section per file (entities, topics).
function renderFiles(ctx, files) {
  return files
    .map((file) => {
      const text = read(ctx.kb, file);
      const title = text.match(/^#\s+(.*)$/m)?.[1] ?? basename(file, '.md');
      const id = ctx.fileIds.get(file);
      const body = renderMarkdown(ctx, text.replace(/^#\s+.*$/m, ''), file, 1);
      const [, titleId, titleRest] = title.match(/^([A-Z]+-\d{3})\b\s*(.*)$/) || [];
      const label = titleId ? `<span class="id">${titleId}</span> ${renderInline(ctx, titleRest, dirname(file))}` : renderInline(ctx, title, dirname(file));
      return `<details class="file"${anchor(ctx, id)}><summary>${label}</summary><div class="nb">${body}</div></details>`;
    })
    .join('\n');
}

function markdownSection(ctx, file, headingShift = 1) {
  const text = read(ctx.kb, file);
  return text ? renderMarkdown(ctx, text.replace(/^#\s+.*$/m, ''), file, headingShift) : '';
}

// The raw part of STATUS.md under one "## Heading".
function statusRaw(status, name) {
  return status.match(new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm'))?.[1] ?? '';
}

function countCoverage(kb) {
  const counts = Object.fromEntries(COVERAGE.map((value) => [value, 0]));
  for (const line of stripComments(read(kb, 'inventory/coverage.md')).split('\n')) {
    if (!/^\|\s*F-\d{3}/.test(line)) continue;
    for (const cell of line.split('|').slice(2, -2)) {
      const value = COVERAGE.find((word) => cell.trim().toLowerCase().startsWith(word));
      if (value) counts[value] += 1;
    }
  }
  return counts;
}

// Color tokens as swatches: any table row in the tokens file that holds a color value.
function swatches(ctx) {
  const text = stripComments(read(ctx.kb, 'design/tokens.md'));
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitRow(line);
    const colors = cells.filter((cell) => /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(cell));
    if (!colors.length) continue;
    const variable = cells.find((cell) => /^`?--/.test(cell))?.replace(/`/g, '');
    out.push(`<div class="sw" style="--n:${colors.length}">${colors.map((color) => `<i style="background:${escapeHtml(color)}"></i>`).join('')}<b>${escapeHtml(cells[0])}</b><span>${escapeHtml(colors.join(' / '))}</span>${variable ? `<code>${escapeHtml(variable)}</code>` : ''}</div>`);
  }
  return out.length ? `<p class="cap-h">Color</p><div class="sws">${out.join('')}</div>` : '';
}

function evidenceGallery(ctx) {
  const items = [...ctx.evidence.entries()].sort(([a], [b]) => a.localeCompare(b));
  const images = [];
  const files = [];
  for (const [id, file] of items) {
    const caption = evCaption(ctx, id);
    if (isImage(file)) {
      images.push(`<figure${anchor(ctx, id)}><div class="shot t">${pic(ctx, file, `${id}: ${caption}`, 'thumb')}</div><figcaption><b>${id}</b> ${escapeHtml(caption)}</figcaption></figure>`);
    } else {
      const size = statSync(join(ctx.kb, file)).size;
      files.push(`<tr${anchor(ctx, id)}><td class="k">${id}</td><td>${escapeHtml(caption)}</td><td><code>${escapeHtml(file)}</code></td><td class="num">${(size / 1024).toFixed(1)} KB</td></tr>`);
    }
  }
  return [
    images.length ? `<div class="g4">${images.join('')}</div>` : '',
    files.length ? `<h3>Captures that are not images</h3><p class="sub">Network shapes, script output and notes, kept in the knowledge base folder.</p><div class="tbl-wrap"><table><thead><tr><th>ID</th><th>Shows</th><th>File</th><th>Size</th></tr></thead><tbody>${files.join('')}</tbody></table></div>` : '',
  ].join('');
}

function section(id, number, title, lede, html) {
  return `<section id="${id}"><h2><span class="sn">${String(number).padStart(2, '0')}</span>${escapeHtml(title)}</h2>${lede ? `<p class="sub">${escapeHtml(lede)}</p>` : ''}${html}</section>`;
}

const DARK = `color-scheme:dark;--paper:#14171b;--ink:#eef0f3;--ink-2:#b5bcc6;--muted:#8f96a1;--rule:#2b3037;--rule-strong:#4a515b;--grid:#22262c;
--accent:#7ab8e0;--accent-ink:#0d1a24;--accent-wash:#1a2733;--good-ink:#4cc14c;--good-wash:#15291a;--caution-ink:#f5c75a;--caution-wash:#2e2610;--crit:#f07272;--crit-wash:#2f1a1a;--blue-ink:#8cc0ea;--blue-wash:#172a3a;--shot-bg:#0b0b0b`;

const CSS = `
:root{color-scheme:light;--paper:#fff;--ink:#16191d;--ink-2:#4b5260;--muted:#5d646f;--rule:#dde1e6;--rule-strong:#aab1bb;--grid:#eceef1;
--accent:#1a5276;--accent-ink:#fff;--accent-wash:#eef4f9;--good-ink:#006300;--good-wash:#e6f4e6;--caution:#fab219;--caution-ink:#7a5300;--caution-wash:#fff6df;
--crit:#c23434;--crit-wash:#fbe7e7;--blue-ink:#1f5f99;--blue-wash:#e6eff8;--shot-bg:#111}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--paper);scroll-behavior:smooth;-webkit-text-size-adjust:100%}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--paper);color:var(--ink);font-family:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:17px;line-height:1.55;-webkit-font-smoothing:antialiased;overflow-x:hidden}
.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}
a:focus-visible,button:focus-visible,summary:focus-visible,.pic:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
p{margin:0 0 .8rem;max-width:68ch}
code,.op,.id,.sn,.n,.evl{font-family:'IBM Plex Mono',ui-monospace,monospace}
code{font-size:.86em;background:var(--grid);padding:.05em .3em;border-radius:3px;overflow-wrap:anywhere}
.num{font-variant-numeric:tabular-nums}.dim{color:var(--muted);font-weight:400}.small{font-size:14px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 0;font-size:14px;color:var(--muted)}
.theme-toggle{background:transparent;border:1px solid var(--rule-strong);color:var(--ink-2);font:inherit;font-size:13px;padding:4px 10px;border-radius:4px;cursor:pointer;flex:none}
.hero{padding:18px 0 0}
.kicker{font:600 12.5px/1 'IBM Plex Mono',ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin:0 0 14px}
.hero h1{font-size:clamp(30px,5vw,46px);line-height:1.1;font-weight:600;letter-spacing:-.01em;margin:0 0 12px;max-width:22ch}
.lede{font-size:19px;color:var(--ink-2);margin:0;max-width:62ch}
.chips{display:flex;gap:8px;overflow-x:auto;padding:22px 0 4px;scrollbar-width:thin}
.chips a{flex:none;font-size:14px;color:var(--ink-2);text-decoration:none;border:1px solid var(--rule);border-radius:999px;padding:4px 12px}
.chips a:hover{border-color:var(--accent);color:var(--accent)}
.answer{border-left:4px solid var(--accent);padding:4px 0 4px 18px;margin:26px 0 0}
.answer .big{font-size:clamp(21px,2.6vw,26px);line-height:1.3;font-weight:600;margin:0 0 12px;max-width:44ch}
.answer ol{margin:0;padding-left:1.2em;max-width:78ch}.answer li{margin-bottom:6px;color:var(--ink-2)}.answer li b{color:var(--ink)}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--rule);border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);margin:26px 0 0}
.tile{padding:16px 18px;background:var(--paper)}.tile .v{font-size:30px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}.tile .l{font-size:15px;color:var(--ink-2);margin-top:4px}
section{padding:56px 0 8px;scroll-margin-top:8px}
h2{font-size:27px;line-height:1.2;font-weight:600;margin:0 0 6px;letter-spacing:-.005em}
h2 .sn{color:var(--accent);font-variant-numeric:tabular-nums;margin-right:12px;font-size:.8em}
.sub{color:var(--ink-2);margin:0 0 22px;max-width:70ch}
h3{font-size:19px;line-height:1.3;font-weight:600;margin:28px 0 8px}h4{font-size:16.5px;margin:18px 0 6px}h5,h6{font-size:15px;margin:14px 0 6px}
ul,ol{padding-left:22px}li{margin:3px 0;max-width:78ch}
figure{margin:0;min-width:0}figcaption{font-size:14px;color:var(--muted);margin-top:8px;max-width:80ch}figcaption b{color:var(--ink);font-weight:600}
.evl{font-size:12.5px;font-weight:500;text-decoration:none;margin-right:4px}
.shot{background:var(--shot-bg);border:1px solid var(--rule-strong);border-radius:8px;padding:8px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.shot.t{padding:0;aspect-ratio:16/10}.shot.empty{background:var(--grid);border-style:dashed;color:var(--muted);font-size:13px;text-align:center;padding:10px}
.shot.inl{display:flex;margin:12px 0}
.pic{display:block;width:100%;background-repeat:no-repeat;background-size:contain;background-position:center;cursor:zoom-in;border-radius:4px}
.pic.thumb{height:100%;background-size:cover;background-position:top left;border-radius:0}
.g2,.g3,.g4{display:grid;gap:20px}.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.g4{grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.g4 figcaption{font-size:13px}
.note,.caution,.crit{border-radius:6px;padding:12px 14px;margin:18px 0;font-size:15px;max-width:82ch;display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:start}
.note{background:var(--accent-wash)}.caution{background:var(--caution-wash);border-left:4px solid var(--caution)}.crit{background:var(--crit-wash);border-left:4px solid var(--crit)}
.ic{font-weight:700;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px}
.note .ic{background:var(--accent);color:var(--accent-ink)}.caution .ic{background:var(--caution);color:#1a1a1a}.crit .ic{background:var(--crit);color:#fff}
.note p,.caution p,.crit p{margin:0 0 4px}.note h3,.caution h3,.crit h3{margin:0 0 4px;font-size:15.5px}.h{display:block;margin-bottom:2px}
.note ul,.caution ul,.crit ul{margin:4px 0 0;padding-left:18px}
.tbl-wrap{overflow-x:auto;margin:14px 0 0}
table{border-collapse:collapse;width:100%;font-size:15px}
th{text-align:left;font-weight:600;font-size:13px;color:var(--muted);border-bottom:1.5px solid var(--ink);padding:6px 12px 6px 0;vertical-align:bottom}
td{border-bottom:1px solid var(--rule);padding:8px 12px 8px 0;vertical-align:top}
td.k{font-weight:600;white-space:nowrap}td a{text-decoration:none;white-space:nowrap}
td code,.op{display:inline-block;font-size:12.5px;border:1px solid var(--rule-strong);border-radius:4px;padding:0 6px;margin:0 4px 2px 0;line-height:20px;background:none;overflow-wrap:anywhere}
.op a{text-decoration:none}
.id{display:inline-block;font-size:12.5px;font-weight:600;color:var(--accent);background:var(--accent-wash);border-radius:4px;padding:0 7px;text-decoration:none;line-height:22px;flex:none}
.chip{display:inline-block;font-size:12.5px;font-weight:600;padding:1px 9px;border-radius:999px;white-space:nowrap}
.chip.red{color:var(--crit);background:var(--crit-wash)}.chip.amber{color:var(--caution-ink);background:var(--caution-wash)}.chip.blue{color:var(--blue-ink);background:var(--blue-wash)}.chip.green{color:var(--good-ink);background:var(--good-wash)}.chip.gray{color:var(--muted);background:var(--grid)}
.swatch{display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid var(--rule-strong);vertical-align:-2px;margin-right:6px}
pre{margin:12px 0;overflow-x:auto;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:13px;line-height:1.55;background:var(--grid);padding:14px 16px;border-radius:6px}pre code{background:none;padding:0;font-size:inherit}
blockquote{margin:12px 0;padding:6px 14px;border-left:3px solid var(--rule-strong);color:var(--ink-2)}
hr{border:0;border-top:1px solid var(--rule);margin:24px 0}
.missing{color:var(--crit)}
.obj{border-top:1.5px solid var(--ink);padding:22px 0 34px;scroll-margin-top:8px;min-width:0}
.oh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 8px}.oh h3{margin:0;font-size:22px;line-height:1.25}
.kvs{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:14px;color:var(--ink-2);margin:0 0 14px;max-width:none}
.kv{display:inline-flex;gap:6px;align-items:baseline;min-width:0;overflow-wrap:anywhere}.kv b{font-weight:500;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;flex:none}
.cap-h{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:24px 0 10px}
.cap-h .dim{text-transform:none;letter-spacing:0}
.anat{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:26px;align-items:start;margin-top:16px}.anat>figure{position:sticky;top:12px}.anat .cap-h{margin-top:0}
.lg{list-style:none;margin:0;padding:0;font-size:15px}
.lg li{display:grid;grid-template-columns:34px minmax(0,1fr);gap:8px;padding:7px 0;border-top:1px solid var(--rule);margin:0}.lg li:first-child{border-top:0}
.n{justify-self:start;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:var(--ink);color:var(--paper);font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;flex:none}
.lg b{font-weight:600;margin-right:6px}.lg div>span:not(.op){display:block;color:var(--ink-2);font-size:14px}
.states{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:8px;overflow:hidden}
.stt{background:var(--paper);padding:10px 12px;font-size:14px;min-width:0}.stt b{display:block;font-size:14.5px}.stt span{color:var(--ink-2)}
.unseen{font-size:14px;color:var(--muted);margin:10px 0 0;max-width:none}.unseen b{color:var(--ink-2);font-weight:500}
details.notes,details.file{border:1px solid var(--rule);border-radius:8px;margin:16px 0 0;background:var(--paper);min-width:0}
details>summary{cursor:pointer;list-style:none;padding:10px 14px;font-weight:600;font-size:15px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"+";font-family:'IBM Plex Mono',monospace;color:var(--accent);width:12px;flex:none}
details[open]>summary::before{content:"\\2212"}details[open]>summary{border-bottom:1px solid var(--rule)}
details>summary .dim{font-size:13px;font-weight:400}
.nb{padding:4px 14px 14px;min-width:0}.nb>h4:first-child,.nb>h3:first-child{margin-top:12px}
details.more{margin-top:12px}details.more>summary{padding:6px 0;color:var(--accent)}details.more[open]>summary{border:0;margin-bottom:12px}
details.file{margin:10px 0}
.comps{display:grid;grid-template-columns:1fr 1fr;gap:0 32px}
.comp{display:flex;flex-direction:column;gap:14px}.comp .oh h3{font-size:19px}.comp .kvs{margin-bottom:4px}
.lbl{font-size:12.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:12px 0 6px}.lbl .dim{text-transform:none;letter-spacing:0}
.pills{display:flex;flex-wrap:wrap;gap:6px}
.pill{font-size:13px;border:1px solid var(--accent);color:var(--accent);background:var(--accent-wash);border-radius:999px;padding:1px 10px;cursor:help}
.pill.off{border:1px dashed var(--rule-strong);color:var(--muted);background:none}
.beh{margin:0;padding-left:18px;font-size:15px;color:var(--ink-2)}
.hint{margin:14px 0 0}.flow{list-style:none;margin:12px 0 0;padding:4px 2px 14px;display:flex;gap:34px;overflow-x:auto;scroll-snap-type:x proximity}
.st{flex:1 0 200px;max-width:300px;margin:0;position:relative;scroll-snap-align:start;display:flex;flex-direction:column;border:1px solid var(--rule);border-radius:8px;background:var(--paper);max-width:none}
.st .shot{border:0;border-bottom:1px solid var(--rule);border-radius:8px 8px 0 0}
.st+.st::before{content:"";position:absolute;left:-28px;top:72px;width:20px;height:2px;background:var(--accent)}
.st+.st::after{content:"";position:absolute;left:-12px;top:68px;border:5px solid transparent;border-left:7px solid var(--accent)}
.sb{padding:10px 12px 12px;font-size:14px;display:flex;flex-direction:column;gap:4px;flex:1}
.sh{display:flex;align-items:center;gap:8px}.sh .n{background:var(--accent);color:var(--accent-ink)}.sh .op{margin:0}
.sb b{font-size:15px;line-height:1.35}.sb>span{color:var(--ink-2)}.sb .evs{font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:var(--muted);margin-top:auto;padding-top:6px}
.branches{display:grid;gap:8px}
.brn{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:start;border:1px solid var(--rule);border-left:3px solid var(--caution);border-radius:6px;padding:9px 12px;font-size:15px}
.brn.off{border-left-style:dashed;border-left-color:var(--rule-strong)}
.brn .at{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--caution-ink);background:var(--caution-wash);border-radius:4px;padding:1px 6px;white-space:nowrap}
.brn .arrow{display:inline-block;width:18px;height:2px;background:var(--rule-strong);margin:0 10px 0 8px;vertical-align:5px;position:relative}
.brn .arrow::after{content:"";position:absolute;right:-6px;top:-4px;border:5px solid transparent;border-left:6px solid var(--rule-strong)}
.brn div>span:last-child{color:var(--ink-2)}
.grp-h{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;border-bottom:1.5px solid var(--ink);padding-bottom:6px;margin-top:36px}
.grp-h .dim{font-size:14px}
.rules{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;align-items:start}
.rule{border:1px solid var(--rule);border-radius:8px;padding:14px 16px;min-width:0;scroll-margin-top:8px}
.rule h4{margin:0 0 10px;font-size:15.5px;line-height:1.4}.rule h4 .id{margin-right:4px}
.gwt{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 10px;margin:0;font-size:14.5px}
.gwt dt{font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--accent);background:var(--accent-wash);border-radius:4px;padding:1px 6px;height:fit-content;margin-top:2px;text-align:center}
.gwt dd{margin:0;color:var(--ink-2);min-width:0}
.rf{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:10px;padding-top:8px;border-top:1px dashed var(--rule);font-size:13px;color:var(--muted)}
.rx{font-size:14px}
.card{border:1px solid var(--rule);border-left:4px solid var(--rule-strong);border-radius:6px;padding:2px 18px 8px;margin:14px 0}
.card>h3:first-child,.card>h4:first-child,.card>h5:first-child{margin-top:14px}
.card.sev-red{border-left-color:var(--crit)}.card.sev-amber{border-left-color:var(--caution)}.card.sev-blue{border-left-color:var(--blue-ink)}
.card ul{font-size:15px}
.cov{margin:22px 0 0}.cov .bar{display:flex;height:12px;border-radius:999px;overflow:hidden;background:var(--grid)}
.seg.green,.dot.green{background:var(--good-ink)}.seg.blue,.dot.blue{background:var(--blue-ink)}.seg.amber,.dot.amber{background:var(--caution)}.seg.gray,.dot.gray{background:var(--rule-strong)}
.legend{display:flex;flex-wrap:wrap;gap:16px;color:var(--muted);font-size:14px;margin:10px 0 0}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.sws{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin:8px 0 20px}
.sw{display:grid;grid-template-columns:repeat(var(--n,1),1fr);font-size:13.5px;border:1px solid var(--rule);border-radius:8px;overflow:hidden;min-width:0}
.sw i{display:block;height:44px;border-bottom:1px solid var(--rule)}.sw b,.sw span,.sw code{grid-column:1/-1;padding:0 10px;overflow-wrap:anywhere}.sw b{padding-top:8px;font-weight:600}.sw span{color:var(--muted);font-size:12.5px}
.sw code{background:none;font-size:11.5px;color:var(--muted);padding-bottom:8px}
dialog#lb{border:0;padding:0;background:transparent;max-width:96vw;max-height:94vh}
dialog#lb::backdrop{background:rgba(0,0,0,.85)}
dialog#lb img{display:block;max-width:96vw;max-height:86vh;width:auto;height:auto;border-radius:4px;cursor:zoom-out}
dialog#lb p{color:#eee;font-size:14px;margin:8px 0 0;max-width:none}
footer{color:var(--muted);font-size:14px;margin:64px 0 32px;border-top:1px solid var(--rule);padding-top:16px}
@media (max-width:880px){.anat,.comps,.rules,.g2{grid-template-columns:1fr}.g3{grid-template-columns:1fr 1fr}.g4{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:760px){.tiles{grid-template-columns:1fr 1fr}}
@media (max-width:600px){body{font-size:16px}.g3,.g4{grid-template-columns:1fr 1fr;gap:12px}.g3 figcaption{font-size:12.5px}.anat>figure{position:static}
.flow{flex-direction:column;gap:30px;overflow:visible;padding:4px 0 0}.st{flex:none}
.st+.st::before{left:calc(50% - 1px);top:-26px;width:2px;height:16px}.st+.st::after{left:calc(50% - 5px);top:-11px;border:5px solid transparent;border-top:7px solid var(--accent)}
.hint{display:none}.brn{grid-template-columns:1fr}.brn .at{justify-self:start}.oh h3{font-size:20px}}
@media print{.topbar,.chips,dialog{display:none}.pic{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

const HEAD_SCRIPT = "(function(){try{var t=localStorage.getItem('res-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}})();";
const BODY_SCRIPT = `(function(){var b=document.getElementById('themeBtn');function cur(){var a=document.documentElement.getAttribute('data-theme');if(a)return a;return window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
function lab(){b.textContent=cur()==='dark'?'Light theme':'Dark theme'}b.addEventListener('click',function(){var n=cur()==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem('res-theme',n)}catch(e){}lab()});lab();
var d=document.getElementById('lb'),im=d.querySelector('img'),cp=d.querySelector('p');function open(el){if(!d.showModal)return;var m=getComputedStyle(el).backgroundImage.match(/url\\(["']?([\\s\\S]*?)["']?\\)/);if(!m)return;im.src=m[1];im.alt=el.getAttribute('aria-label')||'';var f=el.closest('figure');var c=f&&f.querySelector('figcaption');cp.textContent=c?c.textContent:im.alt;d.showModal()}
document.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('.pic');if(el)open(el)});document.addEventListener('keydown',function(e){if((e.key==='Enter'||e.key===' ')&&e.target.classList&&e.target.classList.contains('pic')){e.preventDefault();open(e.target)}});d.addEventListener('click',function(){d.close()})})();`;

const AGENT_COMMENT = '<!-- AI agents: this file is a generated report for people. Do not build from it. Read BUILD.md in this folder first and follow its read order; the Markdown files are the source of truth. -->';

// "Covered: a, b" becomes "<b>Covered.</b> a, b".
function answerItem(ctx, item) {
  const [, label, rest] = item.match(/^([A-Z][\w ]{1,24}):\s+(.*)$/) || [];
  return label ? `<li><b>${escapeHtml(label)}.</b> ${renderInline(ctx, rest, '.')}</li>` : `<li>${renderInline(ctx, item, '.')}</li>`;
}

function charterValue(kb, key) {
  const row = parseTable(stripComments(read(kb, '00-charter.md'))).rows.find((cells) => cells[0]?.toLowerCase() === key);
  return row?.[1] || '';
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function buildReport(kbDir) {
  const kb = resolve(kbDir);
  const ctx = makeContext(kb);
  const status = stripComments(read(kb, 'STATUS.md'));
  const product = status.match(/^# Status:\s*(.+)$/m)?.[1]?.trim() || basename(kb);
  const updated = status.match(/^Updated:\s*([\d-]+)/m)?.[1];
  const phase = status.match(/Phase:\s*([^·\n]+)/)?.[1]?.trim();
  const level = status.match(/^Environment:\s*(L\d)/m)?.[1];
  const coverage = countCoverage(kb);
  const measured = COVERAGE.slice(0, 4).reduce((sum, value) => sum + coverage[value], 0);
  const count = (pattern, text) => (text.match(pattern) || []).length;
  const rulesFiles = listDir(kb, 'rules', (name) => name.endsWith('.md'));
  const screenFiles = listDir(kb, 'screens', (name) => name.endsWith('.md'));
  const componentFiles = listDir(kb, 'components', (name) => name.endsWith('.md'));
  const flowFiles = listDir(kb, 'flows', (name) => name.endsWith('.md'));
  const n = {
    features: count(/^\|\s*F-\d{3}/gm, stripComments(read(kb, 'inventory/features.md'))),
    screens: screenFiles.filter((file) => /\/S-\d{3}/.test(file)).length,
    components: componentFiles.filter((file) => /\/C-\d{3}/.test(file)).length,
    flows: flowFiles.filter((file) => /\/FL-\d{3}/.test(file)).length,
    rules: count(/^#{1,6}\s+R-\d{3}/gm, stripComments(rulesFiles.map((file) => read(kb, file)).join('\n'))),
    entities: listDir(kb, 'data-model/entities', (name) => /^E-\d{3}/.test(name)).length,
    barriers: count(/^#{1,6}\s+BR-\d{3}/gm, stripComments(read(kb, 'clone/barriers.md'))),
    evidence: ctx.evidence.size,
  };
  const tiles = [
    [n.features, 'features'],
    [n.screens, 'screens'],
    [n.components, 'components'],
    [n.flows, 'user flows'],
    [n.rules, 'business rules'],
    [n.entities, 'entities'],
    [n.barriers, 'launch items'],
    [n.evidence, 'evidence files'],
  ].filter(([value]) => value > 0);

  // Hero: one line that says what the study holds, then the summary as numbered findings.
  const held = [n.screens && plural(n.screens, 'screen'), n.components && plural(n.components, 'component'), n.flows && plural(n.flows, 'user flow'), n.rules && plural(n.rules, 'business rule')].filter(Boolean);
  const big = held.length
    ? `${product}, documented from the outside: ${held.length > 1 ? `${held.slice(0, -1).join(', ')} and ${held.at(-1)}` : held[0]}, each tied to evidence.`
    : `${product}, documented from the outside.`;
  const summaryItems = listItems(statusRaw(status, 'Summary'));
  const answer = `<div class="answer"><p class="big">${escapeHtml(big)}</p>${summaryItems.length ? `<ol>${summaryItems.map((item) => answerItem(ctx, item)).join('')}</ol>` : ''}</div>`;
  const lede = charterValue(kb, 'goal') || `How ${product} works, how to rebuild it, and what to prepare before launch.`;

  const statusParts = ['done', 'partial', 'blocked', 'todo'];
  const coverageHtml = measured
    ? `<div class="cov"><p class="cap-h">How far the study went: ${Math.round((coverage.done / measured) * 100)}% of checks done</p><div class="bar">${statusParts
        .filter((value) => coverage[value])
        .map((value) => `<span class="seg ${chipClass(value)}" style="width:${((coverage[value] / measured) * 100).toFixed(1)}%"></span>`)
        .join('')}</div><p class="legend">${statusParts.map((value) => `<span><i class="dot ${chipClass(value)}"></i>${coverage[value]} ${value}</span>`).join('')}</p></div>`
    : '';
  const isNone = (raw) => !raw.trim() || /^\s*[-*]\s*None\.?\s*$/i.test(raw.trim());
  const decideRaw = statusRaw(status, 'Needs human');
  const blockedRaw = statusRaw(status, 'Blocked');
  const nextRaw = statusRaw(status, 'Next actions');
  const callout = (kind, icon, title, raw) => `<div class="${kind}"><span class="ic">${icon}</span><div><b class="h">${title}</b>${renderMarkdown(ctx, raw, 'STATUS.md')}</div></div>`;
  const overview = [
    '<div class="note"><span class="ic">i</span><div><h3>If you are an AI agent</h3><p>Do not build from this page: it is generated for people. Open <code>BUILD.md</code> in this folder and follow its read order. The Markdown files next to it are the source of truth.</p></div></div>',
    isNone(decideRaw) ? '' : callout('caution', '!', 'Needs your decision', decideRaw),
    isNone(blockedRaw) ? '' : callout('crit', '&times;', 'Blocked', blockedRaw),
    coverageHtml,
    isNone(nextRaw) ? '' : `<p class="cap-h">Next actions</p>${renderMarkdown(ctx, nextRaw, 'STATUS.md')}`,
  ].join('');

  const about = [
    ['00-charter.md', 'Charter'],
    ['glossary.md', 'Glossary'],
    ['sources.md', 'Sources'],
  ]
    .map(([file, title]) => (read(kb, file) ? `<h3>${title}</h3>${markdownSection(ctx, file, 2)}` : ''))
    .join('\n');

  // Screens, components and flows are rendered as designed views; the rest as text.
  const sections = [
    ['summary', 'Overview', 'What needs your decision, how far the study went, and what comes next.', overview],
    ['features', 'What the product does', 'Every feature found, its plan and priority, the screens it lives on, and how deeply each one was studied.',
      [markdownSection(ctx, 'inventory/features.md'), read(kb, 'inventory/screens.md') ? `<h3>Screen catalog</h3>${markdownSection(ctx, 'inventory/screens.md', 2)}` : '', read(kb, 'inventory/coverage.md') ? `<details class="notes"><summary>Coverage by feature <span class="dim">which parts of each feature were checked</span></summary><div class="nb">${markdownSection(ctx, 'inventory/coverage.md', 2)}</div></details>` : ''].join('\n')],
    ['screens', 'Screens', 'Each screen with its annotated anatomy, the screenshots taken of it, and the states it can be in. Click a picture to enlarge it.',
      screenFiles.map((file) => renderScreen(ctx, file)).join('\n')],
    ['components', 'Components', 'The reusable pieces of the interface. Solid pills are variants and states seen in the product; dashed ones were not observed. Hover a pill for detail.',
      componentFiles.length ? `<div class="comps">${componentFiles.map((file) => renderComponent(ctx, file)).join('\n')}</div>` : ''],
    ['flows', 'User flows', 'Step by step journeys. Each step shows the screen, what the user does and what the product answers; branches follow the steps.',
      flowFiles.map((file) => renderFlow(ctx, file)).join('\n')],
    ['rules', 'How it behaves', 'Business rules observed in the product, each with its evidence. They become the acceptance tests of the new product.',
      rulesFiles.map((file) => renderRuleFile(ctx, file)).join('\n')],
    ['data-model', 'Data model', 'The entities behind the screens: fields, types, relations and who may do what.',
      [renderFiles(ctx, listDir(kb, 'data-model/entities', (name) => name.endsWith('.md'))), read(kb, 'data-model/permissions.md') ? `<h3>Permissions</h3>${markdownSection(ctx, 'data-model/permissions.md', 2)}` : '', read(kb, 'data-model/types.ts').trim().length > 120 ? `<details class="notes"><summary>TypeScript types</summary><div class="nb"><pre class="ts"><code>${escapeHtml(read(kb, 'data-model/types.ts'))}</code></pre></div></details>` : '', read(kb, 'data-model/erd.mmd').split('\n').length > 4 ? `<details class="notes"><summary>Entity relationships <span class="dim">mermaid</span></summary><div class="nb"><pre class="mermaid"><code>${escapeHtml(read(kb, 'data-model/erd.mmd'))}</code></pre></div></details>` : ''].join('\n')],
    ['api', 'API', 'What the web app asks its server for each action, with the shape of the data and no real values.',
      markdownSection(ctx, 'api/endpoints.md')],
    ['design', 'Design system', 'Colors, typography, spacing, radius, shadow and motion as the product uses them.',
      read(kb, 'design/tokens.md') ? swatches(ctx) + markdownSection(ctx, 'design/tokens.md') : ''],
    ['plan', 'Build plan', 'What to build and in what order, the acceptance tests, and what to copy, avoid and improve.',
      [markdownSection(ctx, 'clone/prd.md'), read(kb, 'clone/parity.md') ? `<h3>Acceptance tests</h3>${markdownSection(ctx, 'clone/parity.md', 2)}` : '', markdownSection(ctx, 'clone/implications.md')].join('\n')],
    ['barriers', 'Before you launch', 'Approvals, licenses and certifications to start early, and what a new product cannot copy. Building can start now; these decide when you can sell.',
      markdownSection(ctx, 'clone/barriers.md')],
    ['topics', 'Cross-cutting topics', 'Behavior that spans many screens: search, notifications, permissions and more.',
      renderFiles(ctx, listDir(kb, 'topics', (name) => name.endsWith('.md')))],
    ['findings', 'Findings', 'Problems and strengths noticed in the product during the study.', markdownSection(ctx, 'findings.md')],
    ['questions', 'Open questions', 'What the study could not confirm, and how to answer it.', markdownSection(ctx, 'questions.md')],
    ['about', 'About this study', 'The goal, scope and terms of the study, the vocabulary of the product, and every public source used.', about],
  ];
  sections.push(['evidence', 'Evidence', 'Every statement cites its evidence: [obs EV-###] seen in the product, [net EV-###] captured on the network, [doc SRC-###] public documentation, [inf] an inference with an open question.',
    evidenceGallery(ctx)]);
  const present = sections.filter(([, , , html]) => html.replace(/<[^>]+>/g, '').trim() || /class="pic/.test(html));
  const rendered = present.map(([id, title, sectionLede, html], index) => section(id, index + 1, title, sectionLede, html));
  const picCss = [...ctx.pics.values()].map((p) => `.${p.cls}{background-image:url("${p.uri}")}`).join('\n');

  const meta = [updated && `Updated ${updated}`, level && `Environment ${level}`, phase && `Phase ${phase}`].filter(Boolean);
  return `<!doctype html>
${AGENT_COMMENT}
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Reverse engineering report of ${escapeHtml(product)}, generated by RES for people. Coding agents: read BUILD.md in this folder.">
<title>${escapeHtml(product)}: reverse engineering report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Mono:wght@400;500;600&amp;display=swap">
<script>${HEAD_SCRIPT}</script>
<style>${CSS}</style>
<style>${picCss}</style>
</head>
<body>
<div class="wrap">
<div class="topbar"><span>Reverse engineering study${meta.length ? ` · ${escapeHtml(meta.join(' · '))}` : ''}</span><button class="theme-toggle" type="button" id="themeBtn" aria-label="Switch between light and dark theme">Theme</button></div>
<header class="hero">
<p class="kicker">RES · Reverse Engineering SaaS</p>
<h1>${escapeHtml(product)}</h1>
<p class="lede">${renderInline(ctx, lede, '.')}</p>
<nav class="chips" aria-label="Sections">${present.map(([id, title]) => `<a href="#${id}">${escapeHtml(title)}</a>`).join('')}</nav>
</header>
${answer}
${tiles.length ? `<div class="tiles">${tiles.map(([value, label]) => `<div class="tile"><div class="v">${value}</div><div class="l">${label}</div></div>`).join('')}</div>` : ''}
<main>
${rendered.join('\n')}
</main>
<footer>Generated by RES (Reverse Engineering SaaS) from the knowledge base in this folder. The launch analysis is research, not legal advice. Rebuild from behavior; do not copy the original product's code, assets or brand.</footer>
</div>
<dialog id="lb" aria-label="Enlarged screenshot"><img alt=""><p></p></dialog>
<script>${BODY_SCRIPT}</script>
</body>
</html>
`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : null;
  const dir = args.find((arg, index) => !arg.startsWith('--') && (outIndex < 0 || index !== outIndex + 1));
  if (!dir) {
    console.error(USAGE);
    process.exit(2);
  }
  const kb = resolve(dir);
  if (!existsSync(join(kb, 'STATUS.md'))) {
    console.error(`Not a knowledge base (no STATUS.md): ${kb}`);
    process.exit(2);
  }
  const html = buildReport(kb);
  const target = resolve(out || join(kb, 'REPORT.html'));
  writeFileSync(target, html);
  console.log(`Report: ${target} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
