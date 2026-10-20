# Changelog

## Unreleased

- `check-kb.mjs`: normalize path separators to POSIX so a knowledge base validates on Windows. `walk()` used `relative()`, which returns backslashes on Windows, but definitions are keyed to `/`-based tables (`FILE_ID_DIRS` such as `data-model/entities`, the `rules/` prefix, `evidence/index.csv`). Without normalization every nested heading/filename definition went unregistered on Windows, so every `E-`/`R-` reference was reported as "referenced but not defined" and `evidence/index.csv` drew a spurious naming warning. Added an importable `toPosix` helper (with an entry guard matching `build-report.mjs`) and a unit test.

## 0.4.0 (2026-10-17)

- `REPORT.html` redesigned as a UX study a person can read and navigate: IBM Plex type, a light and a dark theme with a toggle, a one-line answer with the key findings, stat tiles, section chips, and screenshots in framed figures that enlarge on click.
- Screens: anatomy screenshot beside a numbered legend linked to the components, a gallery of the screen's evidence, the states seen and the states not reached.
- Components: one card per component with a screenshot, variants and states as pills (solid when seen, dashed when not), and behavior notes.
- User flows: a strip of numbered step cards with arrows, a screenshot per step when the step cites one, the user action and the product's response; branches and untested paths below.
- Rules as Given/When/Then cards grouped by file; color swatches in the design system; an evidence gallery.
- Each image is embedded once and reused, so a screenshot cited by a screen, a component and a flow step adds no size. The page still builds when screenshots, screens or flows are missing.

## 0.3.1 (2026-10-16)

- `REPORT.html` redesigned for reading: a header with the product and study status, a notice that the page is for people and that AI agents should read `BUILD.md` (also as a comment at the top of the source), numbered sections in reading order (overview, product, screens, flows, rules, data, API, design, build plan, then what to prepare before launch), a coverage bar, rules and barriers as cards, IDs as badges.

## 0.3.0 (2026-10-16)

First end-to-end studies on real products, published in `examples/` (ClickUp at L2, Pipedrive at L3, each with `REPORT.html`), and fixes for the gaps the Pipedrive study found.

- Handoff: `pack-kb.mjs` keeps `sandbox/ledger.csv` in the zip with object IDs and locations blanked and URLs replaced by `[url]`. An unzipped handoff now passes `check-kb --closing`, and `L-###` references in the KB resolve.
- Baseline counts cover only the container and the operator's records since the first ledger row, by filter or count endpoint, never by pulling full record lists. Teardown compares those counts. `environment.md` records the filter.
- L3: when the container cannot be private, set each record's visibility to the operator only. An unattended session that starts during the team's working hours writes only when the team cannot see the records; otherwise it does the phases without writes first.
- "Stop and skip": deleting your own ledger items inside the sandbox is exempt from the "cannot be undone" stop when the dialog names only those items.
- `mask.js`: selectors become CSS rules that also blur elements rendered later (popovers, dropdowns), until `clear()`. Placeholders that match a pattern are blurred, and `placeholders: true` blurs all of them. Invalid selectors are reported. New "Masking" section in `extraction.md`.
- Report: `build-report.mjs` turns the knowledge base into `REPORT.html`, the main report a person reads. One self-contained page (images embedded, IDs linked, no scripts, no network), with summary, decisions, barriers, build plan, screens, rules, data model, tokens and an evidence gallery. `pack-kb.mjs` writes it and puts it in the zip, and the skill sends it with the zip.
- `tools.md`: Claude in Chrome notes. Long `javascript_tool` results are read through an offscreen `<article>` and `get_page_text`. Use `api-shapes.js` when `read_network_requests` misses app calls. Never load scripts from a local server in the user's tab. Check state after each click in a background window. Where `save_to_disk` screenshots land.

## 0.2.0 (2026-10-16)

- Handoff: `pack-kb.mjs` packs the knowledge base into a zip with `BUILD.md`, a build brief for any coding agent. It checks the KB first, leaves out `sandbox/` and `log/` unless `--full`, and needs no dependencies.
- The skill ends a study by sending the zip to the user in the chat.

## 0.1.0 (2026-10-16)

First public release.

- `reverse-engineering-saas` skill: phases from charter to close, environment levels L1 to L4, action classes A0 to A5, write gate, hidden writes, change ledger, teardown and incident procedures.
- Production barriers: permissioned integrations, regulation and licensing, certifications, distribution gatekeepers, moats, intellectual property, operating cost, recorded as `BR-###` with severity and evidence.
- Knowledge base templates and `init-kb.mjs`; `check-kb.mjs` for IDs, references, evidence, ledger, evidence index and status.
- Page scripts: `inventory.js`, `tokens.js`, `api-shapes.js`, `mask.js`, `annotate.js`.
- Page scripts return structure, counts and shapes; values that look like personal data are dropped or templated, with leak tests on a fake page.
- `init-kb.mjs` defaults to `./re-<product>` and creates the KB repository even when git has no identity.
- `check-kb.mjs` flags features without a coverage row and fails `--closing` on an unfilled charter.
- Scenario test protocol (`docs/testing.md`) and automated tests for the scripts, run on Node.js 22 and 24 in CI.
- Security policy, issue templates (bug report, study report), FAQ and documentation index.
