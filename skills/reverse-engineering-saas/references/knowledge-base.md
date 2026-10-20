# Knowledge base format

`init-kb.mjs` creates this tree. `check-kb.mjs` validates it. Field labels, IDs and file names stay in English; prose follows the user's language.

## Tree

```
re-<product>/
  STATUS.md                 First file every session reads and last file it writes
  BUILD.md                  Build brief for a coding agent (added by pack-kb.mjs)
  REPORT.html               The report a person reads, generated from the KB (build-report.mjs)
  README.md                 How to read the KB: tags, IDs, tree
  00-charter.md             Goal, scope, priorities, mode, environment level, terms note
  sources.md                SRC-### public sources (docs, API reference, pricing) with dates
  glossary.md               The product's vocabulary, defined (Space, List, Deal, Stage)
  questions.md              Q-### open questions and how to answer each
  findings.md               B-### problems and friction; strengths
  sandbox/
    environment.md          Level, identifiers for the location check, preflight results, baseline counts
    ledger.csv              Every change made in the product (L-###)
    fixtures.md             Planned and created fixtures, by feature
  inventory/
    features.md             F-### feature tree: area, feature, plan, priority, status
    screens.md              S-### screen catalog: name, URL pattern, features
    coverage.md             Feature × aspect matrix: the work queue
  screens/S-###-<slug>.md   One file per screen
  components/C-###-<slug>.md One file per reusable component
  flows/FL-###-<slug>.md    One file per user journey
  rules/<area>.md           R-### business rules, Given/When/Then, by area
  data-model/
    entities/E-###-<slug>.md One file per entity: fields, types, enums, relations, lifecycle
    erd.mmd                 Mermaid ER diagram
    types.ts                TypeScript types
    permissions.md          Role × action matrix
  api/endpoints.md          Endpoint templates, the UI action that calls each, payload shapes
  design/tokens.md          Consolidated design tokens
  topics/<topic>.md         Cross-cutting topics (search, notifications, hidden writes)
  clone/
    prd.md                  Requirements for the clone
    barriers.md             BR-### production barriers: approvals, licenses, certifications, moats
    parity.md               Acceptance tests derived from R-### rules
    implications.md         Copy, avoid, improve
  evidence/EV-###-<slug>.*  Screenshots, script outputs, network shapes
  evidence/index.csv        One row per evidence file: date, session, route, what it shows, masked
  log/<YYYY-MM-DD>-s<NN>.md One log per session
  _templates/               Artifact templates (screen, component, entity, flow, rules, topic, session log)
```

## IDs

Take the next free number with `node <skill>/scripts/check-kb.mjs <kb> --next`. Three digits, never reused.

| Prefix | Item | Defined by |
|---|---|---|
| `F-` | Feature | First cell of a row in `inventory/features.md` |
| `S-` | Screen | File `screens/S-###-*.md`, or first cell in `inventory/screens.md` |
| `C-` | Component | File `components/C-###-*.md` |
| `FL-` | Flow | File `flows/FL-###-*.md` |
| `R-` | Rule | Heading `### R-###` in `rules/*.md` |
| `E-` | Entity | File `data-model/entities/E-###-*.md` |
| `BR-` | Production barrier | Heading `### BR-###` in `clone/barriers.md` |
| `B-` | Finding | Heading or first cell in `findings.md` |
| `Q-` | Question | Heading or first cell in `questions.md` |
| `SRC-` | Public source | First cell in `sources.md` |
| `EV-` | Evidence | File `evidence/EV-###-*` |
| `L-` | Ledger row | First column of `sandbox/ledger.csv` |

Any other mention of an ID is a reference. Every reference must resolve to a definition. HTML comments and fenced code blocks are ignored.

## Evidence

- Save every screenshot and script output to `evidence/` at once, named `EV-###-<slug>.<ext>`. Slug: screen and state, for example `EV-031-deal-next-activity-dialog.png`.
- Mask personal data before capture (L3, L4).
- Tag every claim: `[obs EV-###]`, `[net EV-###]`, `[doc SRC-###]`, or `[inf]` with a `Q-###` on the same line.
- Script outputs (`inventory.js`, `tokens.js`, `api-shapes.js`) are evidence: save the JSON as `EV-###-<script>-<screen>.json`.
- Add a row to `evidence/index.csv` for each file: `id,date,session,route,shows,masked`. The date tells engineers how old a claim is; products change weekly.
- A screenshot that shows unmasked personal data is deleted and retaken. It never enters the KB or git.

## STATUS.md

Keep these sections, in this order:

```markdown
# Status: <Product>
Updated: 2026-10-15 · Session: s03 · Phase: 5 Deep dive
Environment: L3 · Sandbox: 🧪 [RE] Sandbox (space Personal) · Open ledger rows: 0

## Summary
- Covered: board, task view, dates (F-001 to F-006). 24 rules.
- Not covered: automations and permissions, read only at L3 (not exercised).
- Decide: create a trial account (L1) to test them.

## Next actions
1. F-012 Board drag and drop: ...
2. ...
3. ...

## Needs human
- Create a trial account in a separate browser profile (L1) to test permissions (F-030).

## Blocked
- F-021 Automations: L3 forbids A4. Needs L1.

## Last session
- Covered F-010, F-011. 6 rules, 2 components. See log/2026-10-15-s03.md.

## Residuals
- None.
```

`Open ledger rows` must be 0 at the end of every session. Rows left as test data for the next session take status `fixture`; rows the user decided to keep take `kept`; rows only the user can resolve take `human`. All three need a note.

## Coverage matrix

`inventory/coverage.md` is one table. Rows are features in priority order. Columns are aspects. Cell values: `todo`, `partial`, `done`, `blocked`, `n/a`. The last column holds notes (reason for `blocked`, files written).

```markdown
| Feature | Anatomy | States | Interactions | Rules | Data | Network | Keyboard and a11y | Persistence | Design | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| F-001 Board view | done | done | partial | done | done | done | done | done | done | drag not automatable |
```

## Session log

`log/<date>-s<NN>.md`: goal, what was covered (IDs), ledger rows added, incidents, decisions, what to do next. Append only.

## Git

Initialize the KB as its own git repository (`init-kb.mjs --git`), even inside another repository. Commit after each feature with the feature ID in the message. Masked evidence images are part of the commit.

## Handoff

`node <skill>/scripts/pack-kb.mjs <kb>` writes `REPORT.html` in the KB and `<kb>-handoff-<date>.zip` next to the KB folder:

- `REPORT.html` is one self-contained page for people, in reading order: overview (summary, numbers, coverage, decisions needed), what the product does, screens, components, flows, how it behaves (rules), data model, API, design system, build plan (with acceptance tests), before you launch (barriers), topics, findings, open questions, about this study (charter, glossary, sources), and an evidence gallery. A notice at the top, and a comment at the top of the source, tell AI agents to read `BUILD.md` instead. Images are embedded once and reused, and IDs are links. Its only script is an inline theme toggle and click-to-zoom, and its only network request is Google Fonts (it falls back to system fonts offline). `build-report.mjs <kb>` regenerates it alone.

- It runs `check-kb` first and stops on errors (`--force` packs anyway and says so).
- It adds `BUILD.md` from `templates/handoff/BUILD.md` if the KB has none. Edit it in the KB to add instructions for a specific team.
- It leaves out `sandbox/` and `log/`, which hold account and workspace details, and `_templates/`. `--full` includes them.
- It keeps a copy of `sandbox/ledger.csv` with `object_id` and `location` blanked and URLs replaced by `[url]`. The receiver sees what the study changed and how each change ended, and `check-kb --closing` passes on the unzipped folder. Keep other account details (workspace names, real values) out of the ledger's other columns.
- `--out <file.zip>` chooses the path.

Send the zip to the user in the chat. The receiver unzips it and gives the folder to a coding agent, starting from `BUILD.md`.

## Triage

`node <skill>/scripts/triage-kb.mjs <kb>` turns a finished KB into issue drafts for the clone's tracker. It writes `<kb>-triage-<date>/` next to the KB folder:

- `TRIAGE.md`: summary, barriers, problems with their decisions, open questions, and how to file.
- `issues/`: one draft per barrier, and one per problem that has an Avoid, Improve or Copy row in `clone/implications.md`. A problem with no decision gets no draft; the report lists it as needing one.
- `issues.json`: `id`, `title` and `file` of each draft: barriers first, then problems, each most severe first.

It runs `check-kb` first and stops on errors (`--force` triages anyway and says so). It never overwrites: if the output folder exists it stops, so pass `--out <dir>` for another one. It never touches the network and files nothing. Read the drafts, then file them from the triage folder, with the clone's repository as `owner/repo`:

```bash
jq -r '.[] | [.title, .file] | @tsv' issues.json | while IFS=$'\t' read -r title file; do gh issue create -R owner/repo --title "$title" --body-file "$file"; done
```

## Checks

`node <skill>/scripts/check-kb.mjs <kb>` reports:

- Errors: unresolved references, duplicate definitions, rules, barriers or findings without evidence, invalid ledger rows, `fixture`, `kept`, `human` or `incident` rows without a note, missing `STATUS.md`; with `--closing`, an unfilled charter.
- Warnings: open ledger rows, `[inf]` lines without `Q-###`, features without a coverage row, artifact files without a "Not tested" section, entity field rows without an evidence tag, evidence files missing from `evidence/index.csv`, `STATUS.md` older than the newest log, template placeholders left in place.

Add `--closing` at the end of the study: `open`, `fixture` and `human` ledger rows become errors.
