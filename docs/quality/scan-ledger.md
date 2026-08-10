---
owner: "@d-hinders"
status: current
covers:
  - .agents/skills/quality-scan/SKILL.md
last-verified: "2026-08-10"
---

# Quality-Scan Ledger

Append-only record of every [`quality-scan`](../../.agents/skills/quality-scan/SKILL.md)
run: date, scope, findings, and each finding's **disposition** — `shipped`,
`accepted-as-debt`, or `rejected`, with the reason. The skill reads this
BEFORE scanning and excludes prior findings unless it can cite evidence of
material worsening against the numbers recorded here. Never rewrite an old
entry; a changed disposition gets a new dated line under the finding.

---

## 2026-07 — full repo (the run that motivated the skill)

**Finding: the money path was proven against mocks, not against a database.**

- Evidence: per-layer source-vs-test ratio table showed the data layer as the
  thinnest-tested, heaviest-mocked stratum; **1,059 positional DB mocks**
  (`mockResolvedValueOnce` chains against `db.query`) counted across the
  backend route tests.
- Demonstrated cost: the `#775` workaround comment ("adding a query
  re-shuffles every chain") copy-pasted across 8 files; the `#757` incident;
  the partial `#773` guard — the codebase had named its own pain three times.
- Unlock: CI already ran Postgres in the same job, so a real-DB harness cost
  no new infrastructure.
- Slicing: harness (#1220) → repository conversions (#1221–#1225) → narrowed
  route tests (#1226) → shrink-only ratchet (#1227) → strategy doc (#1228).

**Disposition: `shipped`** — epic #1219, completed 2026-08-09 (#1226 tail
still open as a standalone). The ratchet (`npm run lint:db-mocks`) holds the
ceiling shrink-only, so the finding cannot silently regrow; a future re-surface
must cite a ratchet-ceiling INCREASE to qualify.
