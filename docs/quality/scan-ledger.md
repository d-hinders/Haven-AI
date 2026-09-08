---
owner: "@d-hinders"
status: current
covers:
  - .agents/skills/quality-scan/SKILL.md
  - .agents/skills/quality-scan/references/dimensions.md
last-verified: "2026-09-08"
verified:
  - "2026-09-08 full-repo run appended (PARTIAL — dimension 1 and sizing only). Finding: 33 of 44 guard self-tests never run their script as a process and 13 guards keep a refusal in `main()` those tests cannot reach; approved as epic #2720 with slices #2721/#2722/#2723. The entry says plainly that block 1 was NOT a systematic mutation sweep — a per-guard harness was attempted and abandoned, and the two cited survivals come from this week's own PR work — because the conventions ask a later run to diff against recorded numbers, and a number gathered one way must not be read as gathered another. Blocks 2-7 are each marked NOT TAKEN or partial by number, per the #2501 rule that an untaken block must be distinguishable from a clean one. Two entries reworded on the `covers:` gap check's own finding against this file: it reads a path in prose as a claim about that file, so the remedy-2 rewrite names the check by behaviour and the measurement block by its npm script — a second false-positive class after the fenced-example one, noted for #2678 rather than baselined here. Body entries above unchanged."
  - "#2501 (second pass, after spec review on the issue): `covers:` gains `references/dimensions.md`, where the seven measurement blocks now live; the measurement-block bullet no longer names a `scripts/quality/` that does not exist; the wave-dimension bullet points at the reference file. Re-read in this pass: the front-matter, the Entry conventions list, and the 2026-08-19 entry's `Probed clean:` guard-mutation line (it keeps its name — block 1 is that dimension made executable). No dated entry edited; nothing appended."
  - "#2501: header only — the entry conventions gain the wave-dimension coverage bullet (`Probed clean:` names every Method § *Wave dimensions* block by number, so an untaken block is distinguishable from a clean one). No body entry re-verified; nothing appended."
  - "#1882: front-matter only — the `last-verified` chain had DROPPED `#1442`. A whole-entry silent replacement, not a compression: `be5bf280` (PR #1560, 2026-08-18) overwrote the 2026-08-14 run's entry with the 2026-08-18 run's. Restored verbatim from `be5bf280^` at the chain tail. Nothing in the body was re-verified in this pass. #1602: entry conventions added (measurement blocks `command → number`, mandatory `Probed clean:` baselines); dispositions now appended by ship-next's closeout when a scan-born epic closes."
  - "2026-08-18 full-repo run appended (epic #1554)"
  - "2026-08-14 full-repo run appended: the API-contract finding (epic #1442, approved); prior real-DB finding re-checked and excluded as improved"
---

# Quality-Scan Ledger

Append-only record of every [`quality-scan`](../../.agents/skills/quality-scan/SKILL.md)
run: date, scope, findings, and each finding's **disposition** — `shipped`,
`accepted-as-debt`, or `rejected`, with the reason. The skill reads this
BEFORE scanning and excludes prior findings unless it can cite evidence of
material worsening against the numbers recorded here. Never rewrite an old
entry; a changed disposition gets a new dated line under the finding.

Entry conventions (#1602, binding for entries from 2026-08-19 on; earlier
entries predate them and stand as written):

- **Measurement blocks:** every evidence number is written as
  `command → number`, or names the ratchet/script that produced it (an
  existing instrument under `scripts/ci/` or `scripts/docs/` first; a new
  one lives with its kind there — there is no `scripts/quality/`). This is
  what makes the
  exclusion rule's delta check a one-command re-measurement.
- **Probed clean:** every entry ends with a `Probed clean:` section —
  `dimension → command → number` for each dimension probed without a
  qualifying finding. These are the next run's diff baselines.
- **Disposition upkeep:** when a scan-born epic closes, the closer appends
  the dated disposition line in the same pass — `ship-next`'s closeout names
  this in its ready-to-close report, so the update is owned by the process,
  not by memory.
- **Wave-dimension coverage (#2501, binding for entries from 2026-09-03
  on):** `Probed clean:` names each of the seven blocks in the skill's
  `references/dimensions.md` by number — `block N → command → number` —
  including a block whose number became a finding. A block missing from the
  section means the run did not take it; a reader must never have to guess
  whether "no finding" meant "looked" or "did not look".

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

---

## 2026-08-14 — full repo

**Finding: the API contract is declared three times and checked across none of
the boundaries.**

- Evidence: **136** route registrations across 30 backend route files against an
  OpenAPI spec covering **46 paths / 48 operations** — **18 of 30 route files
  have zero spec presence** (`/user/safes`, `/contacts`, `/hybrid*`,
  `/delegations`, `/passkeys`, `/reporting`, `/fortnox` verified absent by
  direct search). The generated `api-types.ts` (**5,596** lines, CI-gated by
  `check:api-types`) is consumed by **2 frontend files / ~7 types**, while
  `packages/frontend/src/hooks/` hand-maintains **68** interfaces describing the
  same wire shapes. Request validation is hand-rolled per route (**0** zod
  imports, 181 `code(400)` sites, 42 `typeof … !== 'string'` checks). Every gate
  compares within a layer: `check:api-types` is spec → types generated from that
  spec; `docs-drift.test.ts` is CLAUDE.md's table → spec paths. Nothing compares
  spec ↔ actual route behaviour, or generated types ↔ what the frontend uses.
- Demonstrated cost: `scripts/generate-api-types.mjs` names the failure mode in
  its own header ("the frontend used to hand-maintain a parallel copy, which
  nothing kept honest") — and the remedy built for it reaches ~7 of 68 shapes.
  `packages/connect/src/runtime-manifest.ts` records an incident of the same
  class: a hand-maintained mirror of a canonical list "drifted out of sync with
  the MCP package … which broke the consent screen and the post-setup probe",
  fixed by deriving from the source. A `haven-doc-reviewer` pass the same day
  flagged the missing delegation routes as "a real capability gap" while noting
  it matches the file's own pattern — the gap is normalised.
- Honest negative result: a live-drift probe (frontend's hand-written `Agent`
  interface vs the backend's `AgentRow`) found **no** current mismatch. Filed on
  the precedent and the coverage gap, not on a live outage.
- Unlock: the spec is already importable in tests (`docs-drift.test.ts` reads
  `openapiSpec.paths`) and Fastify exposes its routing table at boot — the
  coverage gate needs no new infrastructure.
- Slicing: coverage gate (#1443, blocks the rest) → response-shape assertions
  (#1444) → frontend consumption (#1445) → spec backfill by domain (#1446) →
  shrink-only wire-shape ratchet (#1447).

**Disposition: approved by the owner 2026-08-14 → epic #1442** (backlog; no
`code-quality` label yet, so the loop will not pick the slices up until queued).
Becomes `shipped` when the epic closes.

**Excluded this run:** the 2026-07 real-DB finding — its ratchet reads 62
mocks / 465 calls against the 1,059 recorded above, i.e. materially improved,
so it does not qualify for re-surfacing.

---

## 2026-08-18 — full repo

**Finding: outbound relayer transactions have no lifecycle — the "interim"
in-process serialisation from July is permanent in practice.**

- Evidence: **9 files** share the relayer nonce lane
  (`rg -ln withRelayerSendLock packages/backend/src -g '!*.test.ts'`), of which
  **4 survive the Safe-rail retirement #1440** (hybrid-provisioning, sweep,
  passport attestation, relayer itself) — so the class does not die with the
  legacy rail. **6 issues in the class in 7 weeks**: #692 (2026-06-30), #718,
  #814 (phase-0 hardening, landed the lock 2026-07-07), #1533, #1537, #1546.
  The code names its own gaps twice: `infra/relayer.ts:16` ("Interim until the
  durable outbound-tx queue lands; in-process only") and `infra/relayer.ts:39`
  ("no bump path (yet) — the stuck tx blocks the relayer's nonce lane").
- Demonstrated cost: #1533 was a live incident four days before this scan —
  the relayer went backwards 5 nonces in 0.6s, both QA attempts red, a full
  diagnosis day (#1529 → #1533 → #1537). #1546 (the day before the scan) was
  the same class from another direction. The stuck-tx gap has no fix at all;
  the only defence is doubled fee headroom, which is a guess.
- Why #718's closure does not cover this: it closed as "solved for the session
  rail, stays for legacy until Stage 3 retires it" — but the 4 surviving
  submitters are delegation-rail and cross-rail, not legacy.
- Slicing: durable `outbound_txs` record (#1555, blocks the rest) →
  submit-through-queue for the non-money pair (#1556) → sweep, money-path
  (#1557) → leader-locked bump/replacement worker (#1558) → cross-replica
  leasing + retire the lock + re-point the #1546 scan (#1559).

**Second finding deliberately absent.** Probed and refused under the bar:
`any` density (≈10 hits repo-wide), local/hosted MCP tool mirroring (already
parity-tested), frontend source/test ratio (142/102, healthy), core's thin
tests (6,168 of 6,618 lines are generated `api-types.ts`), and the
merchant/QA-flakiness wave (eight fixes landed the same week — filing would be
nagging, not scanning).

**Disposition: approved by the owner 2026-08-18 → epic #1554** (backlog; drive
with `ship-next epic=#1554`). Becomes `shipped` when the epic closes.

**2026-08-19: `shipped`** — epic #1554 closed with all five slices merged and
the live evidence in: a stuck Base Sepolia tx was replaced at the same nonce
with bumped fees by the real worker and the replacement mined
(tx `0x48ef59bb…`, #1558's closing comment). The "interim" comment in
`infra/relayer.ts` is gone because the statement stopped being true; a future
re-surface must cite the queue lane failing, not the lock's existence —
multi-replica correctness is now gated only on the Safe-bound legacy sites
(#1440).

**Excluded this run:** the 2026-07 real-DB finding (`shipped`, ratchet holds)
and the 2026-08-14 API-contract finding (epic #1442 approved; #1446 still
open — in progress, not re-surfaceable).

---

## 2026-08-19 — full repo (first run under the #1602 conventions)

**No qualifying finding.** Every candidate failed at least one bar criterion —
recorded here with the refusal reasons so the emptiness is explained, per the
skill. This is the expected shape after five weeks in which three scan-born
epics (#1219, #1442 in progress, #1554) and two intensive fix waves (#1541
connect-flow, #1585 Codex feedback) drained the pool.

**Refused under the bar:**

- **Guard partial-nets** — sampled mutation survival across the guard stock
  (see Probed clean): 4 of 5 mutations caught; the one survivor
  (`(x?: number) => x ?? 8453` in a route file, vs the caught
  `input.chain_id ?? 8453`) falls inside the chain-default guard's own
  documented limits (LHS must be chain-named; over-matching is recorded there
  as the guard's founding mistake). No demonstrated cost from the documented
  gap itself — fails bar 3.
- **In-memory-state / restart class** — the run's biggest incident cluster:
  6 issues in 4 weeks (#1515, #1521, #1534, #1544, #1569, #1578), including
  one genuine double-transfer (#1521). ALL closed by the 2026-08-17..19
  waves with on-chain-probe fixes; filing a "give the demo merchant a real
  store" epic on a fixed, demo-surface class fails bars 3 and 4.
- **Frontend test-depth ratio** — 18,339 test lines against 40,352 source
  (0.45, vs backend 0.88), but the design-workflow-v2 gates (visual
  regression, rendered review, structural lint) cover the rendered surface
  and no frontend incident cluster exists — fails bar 3.
- **Stale gating comments** — 6 `until #N` references to issues that have
  since closed (#829, #834, #1443, #1456 among them): one small `new-task`,
  not an epic — fails the "remedy is one PR" refusal rule.

**Probed clean** (dimension → command → number):

- db-mock ratchet → `npm run lint:db-mocks` → 62 mocks / 465 positional calls
  / 66 files (unchanged from 2026-08-14's 62/465 — holding).
- `any` density → `rg -c ": any\b|as any" packages/*/src --type ts -g '!*test*'`
  → 14 (was ≈10 on 2026-08-18; immaterial).
- Request validation → `rg -l "from 'zod'" packages/backend/src | wc -l` → 0
  (unchanged; part of the #1442 record, epic in progress).
- CI health → `gh api …/actions/runs?per_page=100` → 4/100 runs with
  attempt > 1, 0/100 concluded failure (window post-dates last week's Azure
  apt-mirror flake).
- Sizing → `find packages/*/src -name '*.ts*' | xargs wc -l` per package →
  backend 44,461 src / 39,167 test; frontend 40,352 / 18,339; largest
  non-generated files: sdk/client.ts 3,603, openapi/spec.ts 3,470,
  mcp-server/tools.ts 2,865 (post-#1591).
- Gate-script self-tests → `ls scripts/*.mjs | wc -l` → 27 gate/utility
  scripts, 13 with their own test files.
- Guard mutation sample → 5 hand mutations (chain-default guard ×2, sweep
  validity-window policy, design-lint structural table rule, skill
  byte-parity) → 4 caught, 1 survivor within documented guard limits.
- Incident clustering → `gh issue list --state all` since 2026-07-01 grouped
  by class → restart/state-loss 6 (all closed), QA-harness brittleness 4
  (#1529–#1534, all closed), hand-maintained-map drift 3 (#1471/#1478/#1526,
  all closed); no open cluster.
- Comment archaeology → `rg "TODO|FIXME|HACK"` → 0 in src; most-repeated
  warning comment appears 5× and is a benign type-honesty note; 37
  interim/until mentions of which 6 are the stale refs above.

**Disposition: n/a** — nothing reported for decision.

## 2026-09-08 — full repo (partial: dimension 1 and sizing only)

**Finding: a guard's self-test exercises the functions it exports, not the path
CI runs.** 33 of 44 guard self-tests never run their script as a process, and 13
guards keep a refusal in `main()` that those tests cannot reach. A guard in that
shape can lose its refusal entirely and stay green.

Measured against `origin/dev` at `1671d2bf`:

- guard/gate scripts →
  `ls scripts/*.mjs scripts/ci/*.mjs scripts/docs/*.mjs | grep -v '\.test\.'` → **44**
- self-tests that never spawn the script →
  `grep -LE "spawnSync|execFileSync|execSync|child_process" scripts/*.test.mjs scripts/{ci,docs}/*.test.mjs | wc -l` → **33**
- self-tests that do → same grep, `-l` → **11**
- refusal-bearing guards whose tests cannot reach `main()` → for each
  non-spawning test's sibling script, count
  `process.exit(1)|process.exitCode = 1|throw new Error` after the last
  `^export ` → **13**

**Demonstrated cost — two survivals in one week, both by execution, both caught
by review rather than CI:**

- **#2690** — the `covers:` gap check's `--update` rise-refusal and its
  legacy-format error live only in `main()`. Mutated to `if (false)`, the suite stayed **22/22 green**
  and `docs:check` green.
- **#2704** — `lint-migration-constraint-scope.mjs` was green under
  `isScoped() → return true`, because the repo happened to be clean.

A third, same week, is the shape a function-level test cannot see by
construction: the reaper's host guard read `new URL(url).hostname` while `pg`
dials the host `pg-connection-string` resolves, so `?host=prod-db` walked past
it.

**Remedy exists and is proven in-repo.** The `covers:` gap check's own
self-test moved from the 33 to the 11 on 2026-09-08 by driving the real CLI
against a throwaway baseline; both mutations above now redden. (Named by
behaviour rather than by path: this check flagged the first draft of this entry
for asserting things about tracked files a ledger's `covers:` has no business
reaching — remedy 2, delete the claim, which is the one #2678 prefers.)

**Disposition: approved 2026-09-08** — epic #2720, slices #2721 (`scripts/`, 8
guards), #2722 (`scripts/ci/`, 3, `qa-freshness` first because it gates
promotion), #2723 (`scripts/docs/`, 2, after checking #2678 has not taken them).
Drive with `ship-next epic=#2720`. Becomes `shipped` when the epic closes.

**Excluded this run:** the 2026-07 real-DB finding (`shipped`), the 2026-08-14
API-contract finding (epic #1442), the 2026-08-18 outbound-lifecycle finding
(`shipped`, epic #1554). None re-surfaced; no evidence any has worsened.

**Probed clean** (dimension → command → number):

- Sizing → `ls scripts/*.mjs scripts/{ci,docs}/*.mjs | wc -l` → 44 guard scripts,
  44 `*.test.mjs` files, but 13 scripts with no sibling test at all — recorded as
  a baseline, not reported: "add tests here" without a structural thesis is under
  the bar.
- block 1 **Guard falsifiability by execution** → this run's finding. NOT a
  systematic mutation sweep: a per-guard harness was attempted and abandoned
  (`process.exit(1)` occurs 0–3× per script, so one pattern does not fit), and
  the two survivals cited are from this week's own PR work rather than from a
  sample. Weaker evidence than the block asks for, and the finding says so.
- block 2 **Contract-doc `covers:` completeness** → NOT TAKEN this run. Owned by
  #2679, shipped 2026-09-08; baseline `npm run docs:covers-gaps` → 128 pairs
  across 39 of 72 governed docs. (Named by npm script, not by file path — the
  check reads a path in prose as a claim about that file and cannot tell a
  measurement command from an assertion. Second false-positive class after the
  fenced-`covers:`-example one it already documents; worth a line on #2678
  rather than a baselined gap here.)
- block 3 **Stale numbers in prose** → NOT TAKEN this run.
- block 4 **Retired-vocabulary residue** → NOT TAKEN this run. A ratchet now
  exists (`npm run lint:retired-rail-prose`, #2685) and is green on `dev`.
- block 5 **Merge-method drift on `dev`** → NOT TAKEN this run.
- block 6 **Nets with holes** → partially, and it produced a `new-task` rather
  than an epic line: the migrations CODEOWNERS gate is configured
  `require_code_owner_review=true` with `required_approving_review_count=0`,
  which GitHub does not enforce. Filed as #2705, reproduced on a live PR.
- block 7 **Chain health** → NOT TAKEN as a finding, but re-measured while
  assessing #2681: 78 of 78 governed docs are on the one-entry-per-line list
  after #2637 (`ae7a3563`), 0 on the old single line; chain is 508 KB /
  76,670 words, 13.4% of all tracked Markdown bytes. Recorded because #2681's
  body carries the pre-#2637 figures.
- Incident clustering → NOT TAKEN as a systematic sweep this run.
- Comment archaeology → NOT TAKEN this run.
