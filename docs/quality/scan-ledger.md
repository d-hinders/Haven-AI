---
owner: "@d-hinders"
status: current
covers:
  - .agents/skills/quality-scan/SKILL.md
  - .agents/skills/quality-scan/references/dimensions.md
  - scripts/test-support/guard-cli.mjs
  - scripts/docs/scan-remeasure.mjs
  - docs/quality/scan-baselines.json
last-verified: "2026-10-27"
---

# Quality-Scan Ledger

Append-only record of every [`quality-scan`](../../.agents/skills/quality-scan/SKILL.md)
run: date, scope, structural findings, improvement candidates, and their **disposition** — `shipped`,
`accepted-as-debt`, or `rejected`, with the reason. The skill reads this
BEFORE scanning and excludes prior findings and candidates unless it can cite evidence of
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
- **Probed clean:** retain this heading as a coverage record. New entries
  follow the skill's examined / partial / not examined format, naming the
  revision, command/result, sample boundaries, and missing verification/reason.
  No unexecuted check supplies a clean result. Prior entries retain their
  historical format.
- **Disposition upkeep:** when a scan-born epic closes or a standalone
  scan-candidate task merges, the closer appends
  the dated disposition line in the same pass — `ship-next`'s closeout names
  this in its closeout, so the update is owned by the process,
  not by memory.
- **Block coverage (#2501, #4471, binding for entries from 2026-09-03
  on):** `Probed clean:` names each current numbered block in the skill's
  `references/dimensions.md` by number — `block N → command → number` —
  including a block whose number became a finding. A block missing from the
  section in an older entry means the run did not take it; new entries name
  even unexamined blocks explicitly. Never infer “clean” from missing evidence.
  Blocks 8 and 9 need Postgres, the core/SDK builds and about 288 s, so a run
  that skips them writes `block 8 → not examined → needs the backend suite's
  database and builds` (and the same for block 9), never a zero.
- **`partial` in the heading (#4757, binding for entries from 2026-11-11
  on):** a run that leaves block 1, 8 or 9 unexamined is titled `partial` in
  its heading and its report filename, the way the 2026-09-08 entry is
  (`partial: dimension 1 and sizing only`). Block 10 is not in that list: a run
  whose third-party tier was not requested is not `partial` for that reason.
- **Machine-readable figures (#4625, binding for entries from 2026-11-03
  on):** the `Probed clean` lines here are prose. The commands and their
  latest figures live in `docs/quality/scan-baselines.json`, which
  `scripts/docs/scan-remeasure.mjs` runs weekly at one SHA into a standing
  issue. A whole-repo entry updates `figures` and `sha` for every element of
  `rows` in the same PR, from a runner pass at its SHA; a scoped entry does
  not. The manifest's `docFigures` array is **not** refreshed by a scan: a
  figure quoted in a current doc moves in the PR that changes the sentence
  (#4631). No entry above is edited for it.
- **Candidate decisions (#3025):** apply the same exclusions to both output
  levels. Append pending owner decisions, later dispositions and approved
  issue links without rewriting runs. Implementation progress belongs in
  GitHub, not a parallel ledger queue.

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
  interface vs the backend's AgentRow) found **no** current mismatch. Filed on
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

**2026-09-08:** epic #1442 CLOSED 2026-08-15, so this finding is `shipped`. The
line was owed on the day the epic closed and is 24 days late — recorded here
rather than by editing the line above, per the append-only rule. Found by the
review of the 2026-09-08 entry, which is the pass that re-read this section.

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
  `grep -LE "spawnSync|execFileSync|execSync|child_process|guard-cli" scripts/*.test.mjs scripts/{ci,docs}/*.test.mjs | wc -l` → **33**
- self-tests that do → same grep, `-l` → **11**

  > **The `|guard-cli` term is not optional, and it was missing from the first
  > draft of this line.** The remedy PRs route their spawns through a shared
  > helper (`scripts/test-support/guard-cli.mjs`, #2721) rather than calling
  > `spawnSync` in each test, and the narrower pattern does not follow it. So a
  > future run re-running the recorded command verbatim reads the epic as having
  > shipped nothing. Measured at `940834f5` — dev with #2739 and #2740 already
  > merged, i.e. ten of the thirteen guards remediated: the narrow pattern still
  > says **33**, unmoved, while the pattern above says **23**. This is the
  > instrument counting itself: the number a ledger records is only a baseline
  > if the command that produced it can still see the thing it measured.
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

**2026-09-08 (later the same day):** slices #2721 (PR #2739, eight guards under
`scripts/`, plus the shared `scripts/test-support/guard-cli.mjs` harness) and
#2723 (PR #2740, `scripts/docs/`) MERGED. #2722 (`scripts/ci/`) remains, and
the epic stays open. Appended rather than edited, per the convention above.

**2026-09-09:** slice #2722 (`scripts/ci/`) ships in the pull request that adds
this entry, taking the epic's own headline figure to **zero**. Re-running the
recorded commands at that commit:

- self-tests that never spawn → **19** (22 before this slice; the three that
  moved are `qa-freshness`, `baseline-audit` and `baseline-push-followup`)
- refusal-bearing guards whose tests cannot reach `main()` → **0**, down from 13
  at the 2026-09-08 measurement

The zero was checked against a positive control before being written here: the
same command at the parent commit returns **3**, naming those three guards with
3, 1 and 1 refusals — the counts this slice's issue predicted. A zero from an
instrument that has not been shown able to return non-zero is not a result.

Appended rather than edited, per the convention above.

**2026-09-09 (later):** #2780 taught `covers-gaps.mjs` to resolve backticked
bare component names, which its path regex could not see because it needs a
`packages/`-style prefix. The block-2 reading of **128 pairs across 39 docs** above is
a record of 2026-09-08 and is left as written; the reading after this change is
**154 across 40**, from +38 newly visible pairs and −8 closed (4 in
`design-system.md` by #2779, 4 in `docs-quality-system.md`).

The +38 was measured with a read-only script BEFORE the gate changed, precisely
so the size was known rather than discovered as a wall of baseline entries, and
the gate then reported the same 38 — two instruments agreeing. Accepted into the
baseline with the explicit `--accept-new` override rather than by weakening the
ratchet; the plain `--update` correctly refused the rise.

One cost, found by the change catching its own pull request: the first draft of
THIS entry named two components in code spans as EXAMPLES of the token shape,
and the gate read them as claims about those files. That is the same
false-positive class block 2 records for paths — a measurement command read as
an assertion — now widened to bare names. Remedy taken is the one #2678 prefers:
delete the claim, since an illustration should not be a code span. Anyone
writing about this gate should expect it.

A second, disclosed in `covers-gaps.mjs` rather than here because it is a
property of the check: a bare-resolved gap depends on basename uniqueness, and a
second file with the same basename makes the gap vanish while `hasShrunk`
reports progress.

Appended rather than edited, per the convention above.

**Excluded this run:** the 2026-07 real-DB finding (`shipped`), the 2026-08-14
API-contract finding (epic #1442), the 2026-08-18 outbound-lifecycle finding
(`shipped`, epic #1554). None re-surfaced; no evidence any has worsened.

**Probed clean** (dimension → command → number):

- Sizing → `ls scripts/*.mjs scripts/{ci,docs}/*.mjs | grep -v '\.test\.' | wc -l` → 44 guard scripts,
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
  after #2637 (`ae7a3563`), 0 on the old single line; chain is 511 KB /
  77,142 words at `1671d2bf` — **12.1% of all tracked Markdown bytes**, or
  13.5% counting only `docs/**` plus the root gravity files. Recorded because
  #2681's body carries the pre-#2637 figures.
  The first draft of this line said `508 KB / 76,670 words, 13.4% of all
  tracked Markdown bytes`, which was the only figure in this entry with no
  command beside it — and review could not reproduce it. 13.4% was real but
  measured against `docs/**` + root, not against all tracked Markdown, which
  excludes ~560 KB under `packages/**` and `.agents/**`. Corrected against a
  recorded instrument: sum each doc's `verified:` block from the ref's own
  blobs (`git ls-tree -r --name-only <ref>` → for each `*.md`, the lines from
  `verified:` to the end of the front-matter) and divide by the byte sum of the
  same file list. A size figure quoted without its denominator is not a
  measurement, and this block deliberately retired size as a finding.
- Incident clustering → NOT TAKEN as a systematic sweep this run.
- Comment archaeology → NOT TAKEN this run.
---

## 2026-09-10 — packages/mcp-server (finding: the hosted-MCP monolith, epic #2806)

**Finding: the hosted tool-contract surface has no seam — names, schemas,
input-policy decisions, descriptions, parsing and all 22 handlers live in one
monolithic money-path file, so every hosted tool change edits and reviews the
same file.** Measured against `origin/dev` at `3f9ba290` (the SHA the epic
review re-derived everything at); the slice's git history names the file
this entry counts lines of.

- sizing → `git show 3f9ba290:<mcp-tools-module> | wc -l` → **4277**
  (`git show 7a07b321:<mcp-tools-module> | wc -l` → **1350** at the #980
  closeout commit, the epic's baseline)
- companion suite → `git show 3f9ba290:<mcp-tools-tests> | wc -l` → **6391**
- churn, pinned window →
  `git log origin/dev --oneline --since=2026-08-09T00:00:00Z --until=2026-09-09T23:59:59Z -- <mcp-tools-module> | wc -l` → **81**
  of `git log origin/dev --oneline -- <mcp-tools-module> | wc -l` → **111** all-time
- incident class the seam hardens → #2051, #2282, #2312, #2348 (repeated
  money-path failures landing in this one file; the repo records them)

**Approval: 2026-09-09 (epic #2806, slices #2807–#2812, linear build order).**
Slice #2807 establishes the typed contract and registration seam without
moving handler behaviour; #2808 extracts shared safety support; #2809–#2812
extract the capability handlers and enforce one-owner-per-tool. Drive with
`ship-next epic=#2806`. This entry records the approval the slices already
carry; it lands with slice #2807's pull request so the ledger and the code
move together. Reproduce the slice (the files are named in its PR):

- contracts extracted, facade preserved → line counts of the facade and of
  the three new contract/registry/parsing modules in the PR head (the facade
  shrinks; its export surface unchanged, pinned by the new characterization
  suite)
- characterization-before-structure → the PR's commit order: the
  characterization commit precedes the structural commit
- registration runtime twin, five failure modes → run the two new registry
  test files in the slice's PR (missing schema / description / input-policy /
  handler and duplicated ownership each fail naming the tool; the server
  builder refuses to boot an incomplete registry). Compile-time twins:
  TS2741 on the `Record` annotations, TS2322 on the input-policy
  double-decision sentinel, TS1117 on a duplicated literal key —
  mutation-proven per mode in slice #2807's handoff evidence, byte-identical
  restores sha-verified. One documented asymmetry: a duplicate key WITHIN one
  shipped object literal collapses last-wins at construction, so its twin is
  compile-time only plus the entries-injection unit test.
- test-name parity across the move → grep `^it\('` counts before/after:
  **329** both sides, zero changed names (the two new test files are additive)

**Post-slice re-measurement (this PR's tree, slice #2807 applied):** the
facade line count and the three new module line counts, as stated in the PR
and its handoff — the facade holds handlers and error normalization only; the
contract data, registration seam and parsing live in typed modules. The
remaining shrink happens in #2809–#2812 and is measured by the same command.

Becomes `shipped` when epic #2806 closes with its promotion checklist run.
Appended rather than edited, per the convention above. Written WITHOUT
concrete repo paths for the measured files: the covers-gate reads a path in
prose as a claim about that file (the same false-positive class the
2026-09-09 entry records for bare names), and a ledger has no business
growing `covers:` over its own repro commands — the PR names the files.

## 2026-09-13 — agent surface (safe-retirement, MCP hosted + local, signer, demo merchant; owner mandate 2026-09-12)

Full report: [`docs/bug-reports/quality-scan-2026-09-13-agent-surface.md`](../bug-reports/quality-scan-2026-09-13-agent-surface.md)
— it carries the file:line evidence; this entry stays path-free per the
2026-09-10 convention. Method: live exercise on dev (two testnet purchases —
the skip-settle fixture and a real erc7710 settlement) through the hosted MCP
+ local signer, plus four read-only explorations verified claim by claim.
Prior findings excluded (the 2026-08-19 restart/state-loss refusal not
re-surfaced; no delta measured). The report deliberately exceeds the skill's
top-1–2 shape (mandate: bugs and proposals too); this entry keeps it.

**Finding 1 — no single party model; three addresses are "the payer" of one payment.**
- Evidence: for one settled payment, receipts name the treasury account,
  payment status names the delegate EOA, and the merchant's receipt/invoice
  names the delegate smart account. Tally of payer-named wire fields over the
  spec, SDK types, demo-merchant x402 and signer core → 27 sites (7/10/4/6).
  Cost: a #2906 review round on the `components.account` collision; the
  invoice buyer appears in no Haven receipt.
- Disposition: **pending owner decision.**

**Finding 2 — "settled" is the merchant's 200, not settlement evidence.**
- Evidence: the hosted erc7710 settle path sets `settled` from the merchant
  `ok` and passes the hash through unchecked → live `settled:true` with a
  zero hash and `next_action none`; the backend evidence seam (#2092) is
  fail-closed and leaves the intent `submitted / check_status_later`, no
  receipt row. Cost: the runbook's "NEVER `storage_50gb`" line; three
  "settled but no evidence" log lines in the settlement sweeper.
- Disposition: **pending owner decision.**

**Finding 3 — retry/idempotency is prose, not protocol.**
- Evidence: catalog prepare twice without a key → two intents with
  `idempotencyKey: null`; the plain-x402 key is derived over a 5-minute
  bucket with no boundary surfaced; `PRICE_EXCEEDS_MAX` and the signer's
  success shape carry no `next_*`.
  `gh issue list --state all --search idempotency --limit 500 --json number | jq length`
  → 55; same for `next_action` → 27.
- Disposition: **pending owner decision.**

Thirteen verified `new-task`-sized defects (B1–B13) and ten proposals are in
the report; refused under the bar as epics (one-PR remedies).

**Probed clean** (dimension → command → number, all at `c3f0eddc`):
- Sizing → `find packages/<p>/src -name '*.ts' ! -name '*.test.ts' ! -path '*__tests__*' | xargs wc -l | tail -1`
  and `find packages/<p>/src \( -name '*.test.ts' -o -path '*__tests__*' \) -name '*.ts' | xargs wc -l | tail -1`
  → signer 2,864 src / 4,091 test; mcp 1,762 / 3,386; mcp-server 6,128 /
  11,903; demo-merchant-mcp 3,169 / 2,767; connect 10,223 / 12,093; cli
  2,562 / 2,368; sdk 10,053 / 11,080.
- Live path (dev) → `haven_get_agent` … `haven_settle_mcp_tool` → real
  erc7710 purchase confirmed, budget 1.0 → 0.999, receipt row present.
- Retired rail fail-closed → `git grep "process.env.SAFE" -- packages/backend/src`
  → 0 (positive control: 54 backend files match `process.env\.`); the rail
  decision has one resolver, pinned by the live-census pin test.
- Guard net → `git grep -l "vi.doMock(" -- 'packages/backend/src/**/*.test.ts'`
  → 3 (outside the mock-factory guard's `vi.mock(`-only net; B10).
- Catalog badges → `haven_discover_tools verified=verified` → 0 of 6 (B1).
- Incident clustering → `gh issue list --state all --search <term> --limit 500 --json number | jq length`
  → idempotency 55, next_action 27, stranded 74, PAYMENT-SIGNATURE 125,
  settled 129 (raw search counts; the classified cluster is in the report).
- block 1 (guard falsifiability) → not taken this run.
- block 2 (`covers:` completeness) → not taken this run.
- block 3 (stale numbers in prose) → not taken this run.
- block 4 (retired-vocabulary residue) → not taken this run; the #2907
  naming census (`node scripts/ci/<the #2907 census script> c3f0eddc` → 2,920;
  the script is named in the report) is a rename census, not the retired-rail one.
- block 5 (merge-method drift) → not taken this run.
- block 6 (nets with holes) → only B10 above; the block's full sweep not taken.
- block 7 (chain health) → not taken this run.
The run was scoped to the owner's four areas and the live path; a full-repo
run should take the seven blocks from the 2026-09-03 baselines.


## 2026-09-15 — full repo (all seven wave blocks taken)

Measured on `origin/dev` @ `89fadec0` by three read-only workers in detached
worktrees (review-isolation guard ACCEPTED on the mutation worktree); `rg` is a
shim on this machine, so every command below is `grep`/`git grep`.

**Finding 1 — re-surfaced with its delta: the request edge of the API contract
is the one boundary with neither runtime nor test enforcement.** The 2026-08-14
finding named request validation ("0 zod imports, 181 `code(400)` sites, 42
`typeof` checks") and epic #1442 shipped the coverage gate, response-shape
assertions, generated types, spec backfill and the wire-shape ratchet without
taking it. Since then every axis the August entry recorded has moved the wrong
way, and the response side gained a validator, so the asymmetry is new state:

- route handlers → split `packages/backend/src/routes/*.ts` on
  `app.(get|post|put|patch|delete)(` → **137**; with a Fastify `schema:`
  option → **0**; with any `typeof` check → **33**; with neither → **104**
- hand-rolled idioms in the route layer → `grep -c "typeof "` → **95** (was 42);
  `grep -rn "code(400)"` → **178** sites in 23 files (was 181)
- the spec → `wc -l` on the OpenAPI module → **9,042** (was 3,470); whole-spec
  constraints (requests and responses; 101 of the `required` are the OpenAPI
  `required: true` boolean) → `grep -c` **397** / **121** / **121** / **54**;
  **request-side** (the 60 `requestBody` blocks plus the 16 component schemas
  reachable from them by `$ref`, bracket-balanced walk) → `required: [...]`
  **56**, `enum` **12**, `additionalProperties: false` **28**, `pattern` **20**;
  parameters → `in: 'query'` **60**, `in: 'path'` **45**
- request-body-vs-spec checks anywhere → `grep -rn requestBody packages/backend/src | grep -v` the spec module → **0**
- response-vs-spec checks → `grep -rl expectMatchesSpec | grep -c '\.test\.ts'`
  → **26** test files; all ajv wiring (`Ajv2020|addFormats|compile`) lives in
  the response-shape module and points one way — and it closes every object
  schema (`closeObjects`), so it cannot be reused for requests as-is

Demonstrated cost since the August entry, from the issue record: #1464
(malformed UUID path params → 500, not a documented 4xx), #1469 (a null hole
in `accepts[]` crashed x402 option selection instead of refusing), #2245 (a
caller-supplied `settlementScheme` diverted a retired-rail account off its
fail-closed path), #2282 (a snake-case request field passed through unchecked).
In code: the "… is a 400" ordering rule is hand-restated in **6** non-test
source files plus the spec (`git grep -l "is a 400"`). The spec is already
wrong on the money path: `X402AuthorizeRequest` is `additionalProperties:
false` without `settlementScheme`, which the current SDK sends at three call
sites. Unlock, proven in-repo
twice: the hosted MCP validates every tool input with zod strict and has a
transport-level refusal test (#2312); the backend already compiles ajv against
the spec for responses. Fastify 5's `onRoute` + `setValidatorCompiler` take the
same spec's `requestBody` schemas with no new dependency. Risk stated up front: the
spec was largely backfilled (#1446) and describes what routes were believed to
accept, so enforcement lands behind a shadow mode that logs would-be refusals
against dev traffic and the QA harness before it refuses anything; money-path
routes go second, not first.

**Disposition: approved by the owner 2026-09-15 → epic #3028**. Drive with
`ship-next epic=#3028`. Becomes `shipped` when the epic closes.

**Finding 2 — three mock families describe one frontend API; the parity gate
pins two.** `grep -l "vi.mock('@/lib/api"` over frontend unit tests → **34**
files with ad-hoc inline literals typed `unknown`; of those importing the typed
e2e fixture → **1**; the fixture → `wc -l` → **1,597**; symbols the parity gate
pins → **12**; hand-written wire shapes still baselined → **6 files / 11
shapes**. Cost: the parity gate's own header names the 2026-07-12 `/accounts`
error-boundary incident it exists for, and it covers two of the three families
by construction. **Disposition: `accepted-as-debt` (owner, 2026-09-15)** — a
typed mock builder exported from the fixture plus the parity gate extended to
it is one PR (filed as a `new-task`), and the naming epic's frontend slice
(#2913) converts tests to the builder as it touches them; no campaign.

**Refused under the bar:** error-code vocabulary spelled two ways (29 literals,
11 SCREAMING / 18 lower_snake, the spec enumerates 6) — no cost evidence, bar 3;
env-example drift gate scoped to one of nine packages (20 of 28 non-backend vars
absent) — one PR; `@tanstack/react-query` mounted with 0 call sites — one PR;
5,862 issue-number references in backend non-test source — the code twin of the
CLAUDE.md pattern, reading cost only, bar 3; `design-lint` silently skipping a
vanished scan directory where `copy-lint` throws — one PR.

**Excluded this run:** #1219, #1442, #1554, #2720, #2806 (all `shipped`; #2806
closed 2026-09-15) and the 2026-09-13 agent-surface findings (#2960 and
#2970/#2972 landed since; the third pending). Finding 1 above is the request
half of #1442's finding, re-surfaced on the delta recorded, not re-filed.

**Probed clean** (block → command → number):

- block 1 **guard falsifiability** → the block's candidate script → **18**
  candidates (control 9); 5 mutations (two hosted-MCP scheme gates, the signer's
  `instanceof HavenSignContextError` gate, the sign-context 410 re-quote gate,
  the SDK's in-flight `getAgent` guard) → **5 caught, 0 survivors**; 2 backend
  candidates `could not run` (no local Postgres); every file restored,
  `git status --porcelain` empty.
- block 2 **`covers:` completeness** → the block's bash loop → 8 contract docs,
  **47** cited-but-not-covered; worst: the runtime-compatibility contract 17 of
  27, the docs-quality system 15 of 20, the CASP guardrails 6 of 17; over-wide:
  the delegation security model declares 31, cites 1; `npm run docs:covers-gaps`
  → **146** pairs across 37 docs (was 154 / 40).
- block 3 **stale numbers** → 25 newest shards → **5** figure-bearing lines,
  **0** with a command; re-derivations: `any` **18 → 23**, db-mock gauge
  **58/312/61 → 54/280/57**, zod in backend **0 → 0**, guard scripts
  **44 → 49**, non-spawning self-tests **19 → 20**.
- block 4 **retired vocabulary** → the block's term list → **192** files
  (176), **46** historical / **146** live (39/137); positive control 31+ shards;
  live hits are enforcement tests and drop migrations; the three x402 exports
  each have one non-test importer; `npm run lint:retired-rail-prose` → green,
  34 hits / 32 files, below baseline.
- block 5 **merge-method drift** → first-parent since 2026-09-03T00:00:00Z at
  `89fadec0` → **17** merge-commit / **251** squash; all 17 before
  2026-09-07T12:00Z, **0** after the squash-only `dev` ruleset (22449193);
  two rulesets target `dev` with different allowances, intersection squash.
- block 6 **nets with holes** → copy lint **75** unscanned / **6** with hits
  (all in comments or a regex literal); money-path perimeter **20 of 29** verb
  files outside every glob (unchanged); visual gate **8 of 24** routes (was 4);
  docs boundary, pinned → **39** (was 36; `.claude/` 22, `.agents/skills` 16);
  `qa-freshness` exit branches unchanged; `design-lint` skip-vs-throw asymmetry
  refused above.
- block 7 **chain health** → `grep -rl "^verified:"` outside the archive → **0**
  after #2775; archive **586,040** bytes.
- incident clustering → `search/issues.total_count` since 2026-08-19 → **718**
  (sample 400): other 207, stale-doc 63, process 33; no open product-logic
  cluster.
- workflow archaeology → `gh run list --workflow ci.yml --limit 200` → **4**
  re-attempted, **19** failures, **6** head SHAs with >1 run; **63** merged-PR
  comments mention flake or rerun since 2026-08-19.
- sizing → backend **69,517** source / **83,443** test lines; largest
  non-generated file is the OpenAPI module at **9,042**; largest route file
  1,379.

## 2026-09-16 — Analytics page (epic #2944; owner mandate 2026-09-16)

Full report: [`docs/bug-reports/quality-scan-2026-09-16-analytics.md`](../bug-reports/quality-scan-2026-09-16-analytics.md)
— file:line evidence lives there; this entry stays path-free. Measured on
`origin/dev` @ `886781d4`. Method: full read of endpoint, SQL, hook, page,
doc; 5 executed mutations (block 1); blocks 2, 3, 6; incident clustering;
a refusal-writer census; a deferral census over 80 merged PR bodies. No
prior ledger finding covers this surface; none re-surfaced.

**Finding 1 — refusal recording is per-site opt-in with no choke point; the
"Refused" tile is only as complete as the last grep.**
- Evidence: `git grep -n "recordRefusalFireAndForget(" -- 'packages/backend/src/**' | grep -v test`
  → 6 writers; four refusal-shaped returns on the same conditions have no
  writer beside them (three on the x402 authorize legs, one in the hosted
  MCP's guided-purchase pre-check, which refuses before any backend call
  and is not the price cap the page disclaims). A degraded RPC read on the
  3009 leg turns a recorded refusal into an unwritten one. Cost: the
  epic's first-class metric under-counts on the preferred path with no
  failing test; the enum is closed and a new refusal class has nowhere to go.
- Disposition: **filed as epic #3056** (sub-issues #3052–#3055) on 2026-09-16.

**Candidates (five, one PR each):** C1 (**filed as #3051, shipped in PR #3057**) the spend-by-agent chart with the
refusal marker series is built, tested, showcased and never mounted on the
page (deferred from D to C in a PR body, lost); C2 route-seam guards for the
two executed survivors, the untested merchant-label order and the refusal
count/amount window mismatch; C3 the product doc contradicts the code since
the ledger-floor change and the coupling gate blocked nothing (not
`contract: true`); C4 fee-flag-on and sparse are rendered nowhere; C5 a PR-body
deferral gets a home on the target issue at closeout. Refused under the bar:
budget-read latency (hypothesis, unmeasured). C2–C5: pending owner decision.

**Probed clean** (dimension → command → number, all at `886781d4`):
- block 1 (guard falsifiability) → 5 mutations, real-DB harness + vitest →
  **3 of 5 caught**; survivors: the route dropping `basis.unsettled_submitted`
  (19/19 green) and the page's `isEmptyWindow` losing its refusal clause
  (43/43 green) — both *weak test*.
- block 2 (`covers:` completeness) → the covers-gaps script (`npm run docs:covers-gaps`) →
  0 new gaps, the doc absent from the baseline; recipe → declared 7,
  cited-backticked 2, ~12 claimed in prose. Instrument cannot see prose.
- block 3 (stale numbers) → every figure re-derived → 4 stale in the doc
  (one now false), 1 stale placeholder comment hiding C1, 3 stale gate-scope
  comments ("five spec files" → 8).
- block 4 (retired vocabulary) → not taken (scope post-dates #1440).
- block 5 (merge-method drift) → not taken (out of scope).
- block 6 (nets with holes) → partial: matrix and harness read, not run →
  fee-flag-on asserted nowhere (`git grep flag_on` → `false` at every site);
  no sparse visual scenario; 12 analytics baselines inventoried.
- incident clustering → `gh issue list --search analytics` → 11 since
  2026-09-13; cross-slice gap ×3.
- workflow archaeology → `gh run list --limit 200` on the epic's branches →
  0 reruns, 0 failures.
- deferral census → 4 of 80 merged PR bodies defer an item to another slice.
- sizing → 33 files; source 3,383 / tests 4,830 lines.

## 2026-09-17 — agent surface, second pass (safe-retirement, MCP hosted + local, signer, demo merchant; owner mandate 2026-09-12)

Full report: [`docs/bug-reports/quality-scan-2026-09-17-agent-surface.md`](../bug-reports/quality-scan-2026-09-17-agent-surface.md)
— file:line evidence lives there; this entry stays path-free. Measured on
`origin/dev` @ `4ed69592`. Method: live exercise on dev through the hosted
QA MCP (discovery, quotes, allowances, receipts; no intent created, nothing
signed — the connected signer serves the mainnet agent), five block-1
mutations in the main checkout behind `cp` backups with byte-identical
restores, blocks 2, 3, 4 and 6 in scope, incident clustering over 120
`area:mcp` issues since 2026-08-01, workflow archaeology over 200 runs.

**Excluded this run:** every 2026-09-13 item — F1 and F2 `shipped` (#2960;
#2970/#2972/#2968), F3 still pending the owner, B1–B13 all shipped (B10 via
#2997, which the first draft of this run's report had mis-read as open: the
guard now covers the pattern, the unchanged file count is not a gap), and
proposals 4/7/8/9 still undecided. #1219, #1442, #1554, #2720, #2806, #3028
(`shipped` / in flight) not re-surfaced.

**Finding 1 — the agent's next step is named but never spelled.** Re-surfaced
as the argument half of the 2026-09-13 F3 / proposal 1, on a live delta after
the argument-spelling convergence (#2366) was declared done.
- Evidence (`grep -rn "<field>:" <package>/src --include='*.ts' | grep -v test`,
  camelCase builders included): hosted MCP 46 `next_action` sites, 15 raw
  tool-naming hits (13 emissions), 14 raw argument hits (12 real, 3 emit a
  null id); signer 4 raw / 5 decision sites / 0 tools; local runtime 5 raw /
  1 decision site / 0 tools; discovery emission sites 2, `suggested_arguments`
  0 (the wider grep's 25 hits are 14 wrong-tool hints and 11 declarations;
  the two discovery hints are the ones this finding is about — recorded as
  the artefact it was; the spec review of the epic measured the split). Live: discovery hands the agent `resource_url`, the suggested tool takes
  `url`, the strict refusal explains bodies and idempotency. Cost: thirteen
  issues in the class in five weeks (#2282, #2343, #2348, #2349, #2353, #2366,
  #2393; #1308, #1588, #2550, #2557, #2975, #3001).
- Disposition: **approved by the owner 2026-09-17 → epic #3105**, slices
  #3100 (foothold, ships independently), #3101, #3102, #3103, #3104. Drive with
  `ship-next epic=#3105`. Becomes `shipped` when the epic closes.

**Candidates and defects (one PR each), filed on the owner's word 2026-09-17:**
- D1 → **#3097** — the paid x402 retry adopts the merchant-declared resource
  URL with no scheme check; the Ampersend sandbox declares `http://` (live,
  308 to https), so the hosted quote → pay path sends `PAYMENT-SIGNATURE` in
  clear on the first hop.
  - **2026-09-18:** D1 `shipped` — PR #3112.
- C1 → **#3098** — two money-path perimeters: the CASP guardrails doc's
  `covers:` and the classifier's glob file disagree on five package globs; the
  demo merchant's settlement file is outside every glob (block 6 in scope: 3
  verb files, 1 outside), and #2969/#2979 shipped without the label.
  - **2026-09-18:** C1 `shipped` — PR #3115. The #2979 half of the label claim
    above was wrong when written: PR #2982 carried `money-path`, because it
    also touched `packages/mcp-server/src/**`; the demo-merchant file
    contributed nothing to that label, which is the finding's real shape.
- C2 → **#3099** — block-1 survivor: the demo merchant's settled-cache cleanup
  clause deletes green (33/33); *not load-bearing at the tested condition*.
- D2 → **#3100** — discovery `resource_url` vs the suggested tool's `url`
  (also the epic's first slice).

**Probed clean** (block → command → number, all at `4ed69592`):
- sizing → `find <package>/src -name '*.ts' ! -name '*.test.ts' ! -path '*__tests__*' | xargs wc -l`
  / tests → signer 3,042 / 4,417 (09-13: 2,864 / 4,091); mcp 1,863 / 3,577
  (1,762 / 3,386); mcp-server 6,830 / 13,407 (6,128 / 11,903);
  demo-merchant-mcp 3,556 / 3,746 (3,169 / 2,767).
- block 1 (guard falsifiability) → the block's candidate script → 149
  candidates (the naming-P5 landing touched most); 5 in-scope mutations →
  **4 caught** (retired dual-send disagreement, signer consent refusal, local
  MCP missing delegate key, signer typed-data digest commitment — the last
  only after `npm run build -w packages/sdk`; a stale dist errors the signer
  suite first), **1 survivor** (C2 above, diagnosed).
- block 2 (`covers:` completeness) → the block's loop under `bash` → 8
  contract docs; in scope the runtime-compatibility contract cites 28, covers
  22, 17 cited-but-not-covered (09-15: 17 of 27 — unchanged, not re-reported).
- block 3 (stale numbers) → the four package READMEs → 0 figure-bearing
  lines; the runtime doc 4, of which 2 real test counts inside dated notes
  (historical, correct); ledger re-derivations are the sizing deltas above.
- block 4 (retired vocabulary) → the block's term list over its full tracked
  file set → 190 files (192 on 09-15), 46 historical / 144 live (146); positive control 36 shards; in
  scope 15 live files, all enforcement tests, drop migrations or comments;
  `npm run lint:retired-rail-prose` → 33 hits / 31 files (34 / 32), green;
  the rename census → 752 surviving hits, all in allowed classes; #2851 closed.
- block 5 (merge-method drift) → not taken (out of scope; 09-15 baseline).
- block 6 (nets with holes) → in scope: 3 money-verb files, 1 outside every
  glob (C1); the doc perimeter and the JSON perimeter differ on 5 package globs.
- block 7 (chain health) → not taken.
- incident clustering → 120 `area:mcp` issues since 2026-08-01 (69 Aug, 51
  Sep); by title class x402 32, signer 23, settle 19, erc7710 18,
  quote/prepare 17, connect 17, next_* 12, catalog 11, demo merchant 10. The
  `qa-dev` money-flow cluster (20 `qa-failure` issues 2026-08-12 → 09-08) is
  **closed**: one standing tracker (#2767) and
  `gh run list --workflow qa-dev.yml --limit 40` → 40 / 40 success.
- workflow archaeology → last 200 Actions runs: 16 attempt > 1 (docs quality
  4, copy lint 3, docs coupling 3, DS coupling 3 — parked-run re-runs after
  bot baseline pushes), 4 failures; `ci.yml` last 60: 45 / 5 / 10 cancelled;
  4 of 135 in-scope commits since 08-15 mention flake or rerun.
- comment archaeology → `TODO|FIXME|HACK` in the four packages → 0; the most
  repeated warning (×4) explains a refusal, not a workaround.

## 2026-09-18 — x402 requirement echo candidate C2

The scoped x402 protocol scan at `475e5eaedaf93d6c20797c8d497b7777656ce051`
found SDK timeout normalization and backend ERC-7710 encoding changed the
merchant's selected `accepted` requirements. Official core matching rejected
advertised timeouts clamped before echo and stripped `extra` metadata; unchanged
controls passed. Reproduction scripts and owner-approved acceptance criteria
are preserved in [#3117](https://github.com/d-hinders/Haven-AI/issues/3117).

Disposition: approved, filed as standalone #3117, and implemented there. The
other approved candidates remain separately tracked: *Reject unsupported x402
transfer methods and payment flows before funding or signing*
[#3116](https://github.com/d-hinders/Haven-AI/issues/3116) and *Support native
MCP x402 tool-result challenges and payment metadata*
[#3118](https://github.com/d-hinders/Haven-AI/issues/3118). No new scan conducted
in the implementation pass; no new structural finding.

## 2026-09-21 — agent surface, third pass (safe-retirement, MCP hosted + local, signer, demo merchant; owner mandate 2026-09-12, re-invoked 2026-09-21)

Full report: [`docs/bug-reports/quality-scan-2026-09-21-agent-surface.md`](../bug-reports/quality-scan-2026-09-21-agent-surface.md)
— file:line evidence lives there; this entry stays path-free. Measured on
`origin/dev` @ `e42ed68f`. Method: live exercise on dev through the hosted
QA MCP and the local qa-dev signer (fifteen read-only calls: agent,
allowances, receipts, status, discovery ×2, x402 quote ×2, two more quote
shapes, four sufficiency checks, one signer refusal; no intent, no signature), five
block-1 mutations in a `npm ci`'d detached worktree behind `cp` backups
with byte-identical restores, blocks 2, 4 and 6 in scope, incident
clustering over the 30 in-scope issues since 2026-09-17, workflow
archaeology over 200 runs.

**Excluded this run:** every 2026-09-13 and 2026-09-17 item — B1 confirmed
shipped live (9 / 9 badges); F1's `parties` triple, F2 (a)/(b), F3's key half,
#3097, #3100, #3102 all confirmed live; F3's success half (proposal 1) still
pending the owner (carried as a note, not re-surfaced); #3105, #3119, #3130
(shipped / in flight) not re-surfaced.

**Structural findings — none in the examined sample.**

**Defects and candidates (one PR each), pending the owner's word:**
- D1 — the hosted sufficiency check refuses the token SYMBOL every other
  read hands the agent (`token: "USDC"` → `MAX_AMOUNT_UNCONVERTIBLE`, remedy
  copy points at atomic units; the address works and the answer echoes
  `token: "USDC"`), and its no-cap refusal borrows the paid-call copy.
  Live ×4. Tracking: no open issue; the tool shipped 2026-09-18.
- D2 — the hosted MCP's generic refusal branches (SDK API error, SDK error,
  unknown) carry no `next_action` and no next-step family; a transient
  merchant/backend 500 during an x402 quote landed there live (retry
  succeeded) with nothing to tell the agent. Mutation M5 shows the
  next-step ratchet guards the state-error branch only. Tracking: none
  open; the epic's slice did not enumerate these branches.
- C1 — the runtime-compatibility contract cites 44 tracked paths and
  declares 42 `covers:` entries; 7 cited paths sit outside every declared
  glob (sdk ×3, one frontend hook, scripts ×3), 0 in scope, and the coupling
  gate names the doc for none of them. *Corrected before merge:* first
  recorded as "21, 9 in scope" — the reference loop's unquoted
  `for g in $declared` globbed every `**` entry into directory names, so
  glob-covered signer/mcp files counted as misses; the 09-15 and 09-17
  figures for this doc were taken the same way and are not comparable.
- Notes, not filed: the strict-refusal copy for an unknown key is the cap
  paragraph; the local qa-dev signer runtime on the scanning machine is the
  2026-09-15 dev build (#3119's class — every signer claim this run is from
  the tree, not the live runtime); the legacy `payerAddress` divergence
  between status and receipt is unchanged and `parties` is canonical on
  both; the sufficiency check's success step is prose (proposal 1's half).

**Probed clean** (block → command → number, all at `e42ed68f`):
- sizing → `git ls-tree -r --name-only origin/dev packages/<p>/src`, split
  on `.test.ts|__tests__`, `git show | wc -l` summed → signer 3,536 / 5,190
  (09-17: 3,042 / 4,417); mcp 1,959 / 3,691 (1,863 / 3,577); mcp-server
  7,627 / 14,683 (6,830 / 13,407); demo-merchant-mcp 3,741 / 4,042
  (3,556 / 3,746).
- block 1 (guard falsifiability) → the reference's census script → 64
  candidate files; 5 in-scope mutations, newest landing first → **5 caught**
  (bare-hash refusal 4 red in the signer server suite; audit rotation bound
  2; demo-merchant `-32001` recovery data 2; sdk unsupported-only 4 after an
  sdk rebuild; hosted state-error next-step family 3). Instrument lesson:
  a BSD-`sed` `\s` substitution that did not apply reported green for two
  of them on the first pass (`grep -c` caught it); a `node_modules` symlink
  resolves workspace packages to the main checkout — `npm ci` the worktree.
- block 2 (`covers:` completeness) → the reference's loop under `bash`
  (`grep -rl`, since `rg` is not on bash's PATH; `set -f` before the match
  loop — without it the published loop reads 21 for the runtime doc) → 8
  contract docs; in scope 44 cited / 42 declared / 7 not covered (C1); the
  x402 sequence doc 26 / 45 / 3 with or without `set -f` (out of scope).
- block 3 (stale numbers) → partial: the 09-17 sizing re-derived (above);
  package READMEs not re-swept.
- block 4 (retired vocabulary) → the reference's term list over the full
  tracked set → 192 files (192 on 09-15), 46 historical / 146 live;
  positive control 36 shards; in scope 16 live files (09-17: 15; first
  written as 10, a hand sub-count corrected before merge) — 7 tests, 2
  package READMEs and 7 history-describing files (9 lines); `npm run lint:retired-rail-prose` →
  green. Safe-retirement pins: `git grep -l 'process.env.SAFE' --
  packages/backend/src` → 0 (positive control 57), guard test + middleware
  present, the four `retiredSafeInflowRoute(` registrations from #3030.
- block 5 (merge-method drift) → not taken (out of scope).
- block 6 (nets with holes) → money-verb half → 28 verb files, 18 outside
  the perimeter (09-15: 29 / 20); in scope 3 verb files, 0 outside (#3098
  held). Other halves not taken.
- block 7 (chain health, ledger name) → partial → dev `/health` db ok; the
  agent's on-chain remaining and the sufficiency read both `from_chain:
  true`; the Ampersend sandbox 402 on all three endpoints by direct curl.
- incident clustering → `gh issue list --state all --search
  "created:>=2026-09-17"` filtered to the three area labels → 30 of 65;
  next_* 6 (closed epic), connector/doctor 6 (#3119 open, #3210 open —
  `packages/connect`, out of scope), vocabulary 4 (#3130 open), x402 3,
  agent reads 3, demo merchant 3, perimeter 1.
- workflow archaeology → last 200 runs: 0 with attempt > 1, 4 failures;
  `ci.yml` last 60: 45 / 10 / 5 cancelled (09-17: 45 / 5 / 10) — the ten
  failures are feature branches mid-build (four visual-baseline round
  trips, #1777), none on `dev`; `qa-dev.yml` last 40 → 40 / 40.
- comment archaeology → `TODO|FIXME|HACK` in the four packages → 0.
- live path → reads and quotes only; no prepare, no signature — the QA
  agent's budget is 0.001 USDC and the pass was read-only by design.

**Disposition (owner, 2026-09-21): file all three, drop proposal 1.**
D1 → #3213 (`area:mcp`, money-path by file); D2 → #3214 (`area:mcp`,
money-path by file); C1 → #3215 (`area:docs`, filed at the corrected figure
of 7). Proposal 1's success half (2026-09-13 F3 / this run's N4): **`rejected`**
— not carried forward. N1–N3: not filed (below the bar / tracked under
#3119). Instrument: the block-2 loop in the skill reference gains `set -f`
in the same PR (#3212). Drive: `ship-next 3213`, `ship-next 3214`,
`ship-next 3215`.

**D1 → #3213: `shipped` 2026-09-21** — PR #3217, squash `52515ed7` on `dev`
(symbol resolved through the agent's own allowances; the no-cap refusal names
the check; two reviewer passes bound clean at `e535e76b`).

## 2026-09-22 — whole repo, weighted to the least recently scanned surfaces (owner request 2026-09-22, no scope named)

Full report: [`docs/bug-reports/quality-scan-2026-09-22-whole-repo.md`](../bug-reports/quality-scan-2026-09-22-whole-repo.md)
— file:line evidence lives there; this entry stays path-free. Measured on
`origin/dev` @ `fd7b1289` by the captain and three read-only workers in
detached worktrees (backend data layer and accounting module; CI and
reporting scripts as instruments; frontend, CLI and connect), all removed
with a plain `git worktree remove`. Mutations used `cp` backups with
byte-identical restores; real-database runs used a disposable local
database, dropped afterwards. No live call was made.

**Excluded this run:** every item from 2026-09-13, 09-17 and 09-21 (D1
shipped; D2 → #3214 closed 2026-09-21 via PR #3220; C1 → #3215 closed
2026-09-21 via PR #3219), the 2026-09-15 mock-families
finding (`accepted-as-debt`), and the parked-run re-run mechanism (recorded
2026-09-17).

**Structural findings (pending the owner's word):**
- F1 — the visual-baseline net cannot tell an intended screen change from
  a re-blessed failing comparison. The regeneration dispatch's default
  mode rewrites exactly the failing baselines. Nothing reads its audit
  trailer. No diff image survives a passing comparison. The bot-push
  follow-up comment asserts the images are correct, and a test pins that
  wording. The visual check is not required on `dev`. Measured since
  2026-09-01: 35 baseline landings, 24 of them modifying an existing
  baseline; 19 carrying a design-review verdict at merge, 5 skipped or
  pending, 11 with none (a hand classification); 13 of the 24 modifying
  ones carry a verdict, and 2 of the 9 landings since 2026-09-18 do.
  *Corrected in review:* the report first recorded 17 / 6 / 12 and 1 of
  9, and this entry first recorded 17.
  Cost: #2217 / #2218 (a silent re-bless caught by a hand blob-hash audit),
  #3167 → #3197 (a known regression blessed and defended by the gate) and
  #3222 (filters removed, baselines re-committed, all gates green, caught
  by the PR's combined code-and-design review, not by any gate). Four disjoint slices proposed: a trailer gate,
  the follow-up comment's wording, a before/after artifact, and the
  design-reviewer brief.

**Improvement candidates (one PR each), pending the owner's word:**
- C1 — three repository writes (`setDefaultAccountForUser`,
  `deleteAccountForUser`, `replaceAgentLabels`) take a user id but scope
  their SQL by row id alone. On a real database, a second user's id deleted,
  re-defaulted and relabelled the victim's rows. The route pre-checks are
  load-bearing and tested, so nothing is reachable today, and a repository
  test pins the unscoped shape as correct. SQL census over 66 files: 168
  mutating statements, 112 scoped by a principal column and 56 not. The
  three account statements (from two functions) are the request-id cases
  among the 56; the labels pair counts among the 112 as scoped by
  `agent_id` only (45 statements, not traced beyond this pair).
  *Corrected in review:* first placed the labels pair among the 56.
- C2 — two of #3019's webhook acceptance criteria are met by tests that
  cannot fail: the trailing-slash loop never sends its suffix, and the
  dedupe decision has no real-database test (the migration test pastes
  its own INSERT). Proposed as a comment on #3019, not a new issue.
- C3 — the branch-hygiene meter counts resync merges in `dev`'s history,
  which the squash-only ruleset (2026-09-07) removed. It reads 0 since
  2026-09-08 and prints the target state, while at least 29 resync
  commits sat inside 23 of the 259 PRs merged in that window (first
  recorded as 17 in 13 of a 200-PR sample).
- C4 — five files that gated jobs read are routed to no surface by the
  change classifier (the env example, two lint baselines, a vitest setup
  hook and a lint helper). A PR that breaks one merges green: shown for the
  env example and the request-schemas baseline. (The lint helper is still
  exercised on every PR by two ungated jobs; only the frontend job's run
  over real source is skipped.)
- C5 — the next-steps and wire-types ratchets and their self-tests pass
  when every scan target is hidden (0 files read, ✓).
- Notes, not proposed: facets pinned only by pixels at the AgentPanel level
  (closes if #3222's round-3 test lands); the webhook token lookup's two
  clauses are individually redundant; the dist-freshness check's ✓
  wording for a missing dist; one real CI timeout in the hosted MCP's
  tool-contracts test (09-19, release branch).

**Probed clean** (block → command → number, all at `fd7b1289`):
- sizing → `git ls-files -z packages/<p>/src`, filtered to
  `.ts|.tsx|.mjs`, split on `.test.|__tests__|.spec.`, `xargs -0 cat | wc -l` → backend 77,152 /
  95,359. The same command at `89fadec0` gives the 09-15 figures of 69,517 /
  83,443 exactly, so the one-week delta is +11 % source and +14 % test.
  frontend 50,187 / 44,347; connect 11,389 / 14,047 (09-13: 10,223 /
  12,093); cli 2,567 / 2,416.
- block 1 (guard falsifiability) → 20 mutations over two hand-chosen
  non-money samples → accounting 4 caught / 4 survived (C2, token-lookup
  note); connect, cli and frontend 11 red / 1 survived (facets note).
- block 2 (`covers:` completeness) → the reference's loop under bash with
  `set -f`, each miss confirmed with the strict coupling gate → 17 across 5
  of 8 contract docs. The runtime-compatibility doc is down from 7 to 0; the
  CASP guardrails 6 (09-15) and x402 sequence 3 (09-21) are unchanged, and
  2 new each sit on the docs-quality system and package-dev-channel docs.
  `npm run docs:covers-gaps` → 138 pairs / 36 docs (09-15: 146 / 37).
- block 3 (stale numbers) → 25 newest shards → 12 figure matches on 11
  lines, 0 with a command; `any` → 24 (23 at `89fadec0`), but only 6 of those lines
  are code; db-mock gauge → 54 / 273 / 57 (09-15: 54 / 280 / 57).
- block 4 (retired vocabulary) → the reference's term list with the
  corrected exclusion → 191 files, 46 historical / 145 live, equal to the
  corrected `e42ed68f` reading; positive control 36 shards; the ratchet is
  green below baseline.
- block 5 (merge-method drift) → first-parent since 2026-09-15T00:00:00Z
  → 0 merge-commit / 122 squash (clean). Since 2026-08-10T00:00:00Z → 282
  / 693 of 978, of which 4 are sync-backs. The newest counted landing is
  #2646 (2026-09-07), itself a `main` sync-back under a prefix the block
  does not recognise.
- block 6 (nets with holes) → partial → the 15 required checks on `dev`
  read for skip paths (C4, C5 undocumented); the visual net is F1;
  copy-lint, the money perimeter and the docs boundary were not taken.
- scripts as instruments on empty input → 30 of 41 run → 8 give a clean
  verdict on empty input: 2 correct, 5 hide that nothing was read, 1 is
  deliberate (the coupling gate's explicit empty list).
- incident clustering → issues created since 2026-09-15 → 111 (99 / 12
  open); every open one is tracked; no untracked cluster.
- workflow archaeology → `ci.yml` last 200 → 10 with attempt > 1 (9 are
  parked bot-push runs, 1 is a real timeout), 23 failures (0 on `dev`), 19
  cancelled; `qa-dev.yml` last 40 → 40 / 40. The three local 5 s timeouts
  were not seen in CI, but only 1 failed-job log in the sample ran the
  backend suite at all, so this is weak evidence, not a clean bill.
- comment archaeology → `git grep -c -w -E 'TODO|FIXME|HACK|XXX' --
  'packages/*/src/*'` → 0 with or without tests; positive control `import`
  over the same pathspec → 1,437 files (`-- 'packages/*/src'` without the
  trailing `/*` matches nothing at all).
- live exercise → not taken.

Instrument lessons: `rg` is a zsh function here and absent from `bash -c`
(the #3224 guard stopped the loop, as intended); `\b` in `git grep -E`
reads 0 against a true 1; the first sizing pass word-split wrong in zsh and
a rerun died silently after its header; the coupling gate reports "no
covered docs implicated" for a non-existent path; the block-3 `any` regex
counts prose; the branch-hygiene meter reads only `--since=` and silently
falls back to 7 days on `--since <date>`; a `git grep` pathspec of
`packages/*/src` matches no file.

**Disposition (owner, 2026-09-22): file all; C2 as a comment on #3019.**
F1 → epic #3231 (`epic`, `area:frontend`, `area:ci`, `area:docs`) with
slices #3232 (trailer and verdict gate), #3233 (follow-up comment wording),
#3234 (before/after artifact) and #3235 (design-reviewer brief); the epic's
spec review was posted on it (38 claims re-run, 4 wrong and fixed). C1 →
#3227 (`area:backend`, `money-path` by file; owner decisions: a cross-tenant
call is a silent no-op, and a census ratchet for the class is filed
separately later). C2 → a comment on #3019, no new issue. C3 → #3228,
C4 → #3229, C5 → #3230 (`area:ci`). Notes: not filed. Filed to the backlog
(no `code-quality`).

**Shipped 2026-09-23** (squash on `dev`):
- C1 → #3227: `shipped` — PR #3237, `79592c11`.
- C3 → #3228: `shipped` — PR #3239, `a98c7903`.
- C4 → #3229: `shipped` — PR #3238, `62b1e8da`.
- C5 → #3230: `shipped` — PR #3242, `257b0553`.
- F1 slice #3232: `shipped` — PR #3243, `4fd4ec07`.
- F1 slice #3233: `shipped` — PR #3240, `ef6ba51b`.

F1 (#3231) stays open until #3234 and #3235 have landed and its promotion
checklist is ticked.

## 2026-09-25 — whole repo, weighted to the least recently scanned surfaces and the day's landings (owner request 2026-09-25, no scope named)

Full report: [`docs/bug-reports/quality-scan-2026-09-25-whole-repo.md`](../bug-reports/quality-scan-2026-09-25-whole-repo.md)
— file:line evidence lives there; this entry stays path-free. Measured on
`origin/dev` @ `2cc23374` by the captain and three read-only workers in
detached worktrees (the day's landings; the SDK, core, the QA harness and the
backend modules and workers outside the 09-22 sample; CI, docs and history),
all removed with a plain `git worktree remove`. On the owner's instruction
during the scan, every candidate was re-run by the captain in a separate
pinned worktree before it was written; three worker figures were corrected
there. Mutations used `cp` backups with byte-identical restores; real-DB
runs used disposable local databases, dropped afterwards. The only live calls
were two read-only nonce reads on the public Base Sepolia endpoint. Two
landings of the day were the captain's own; they were mutated and read by a
worker, not by the captain.

**Excluded this run:** every prior finding and candidate. The 2026-08-18
outbound-lifecycle finding's re-surface bar ("the queue lane failing") is met
on the day, but the incident is tracked on #2769 and is recorded as context
there, not as a new item.

**Structural finding (pending the owner's word):**
- S1 — qa-dev goes red on RPC-provider behaviour in waves, each triaged as a
  flake, absorbed by the in-step retry and fixed one quirk at a time: 6 of
  the 9 `qa-failure` issues of 09-02 → 09-06 (classified from each issue's
  triage comment); 3 of 4 money-flow failures 09-18 → 09-23 (Alchemy 429s);
  18 of 22 on 09-24 → 09-25 (the dRPC plan's batch and `pending`-tag
  refusals). Over the last 100 dev deployments: 592 money-flow check-runs →
  472 skipped / 90 success / 26 failure / 3 cancelled / 1 in flight, 21 of
  the 26 with a provider signature; 19 of the 90 passed only on the in-step
  attempt 2. Partly a re-surface: the 09-17 entry recorded the qa-dev cluster
  (2026-08-12 → 09-08, containing the first wave) as closed; the later two
  waves are its recurrence. Cost: promotion #3325 shipped with `qa-override`
  and three relayer legs red. Four slices proposed: a conformance probe with
  its swap-runbook step, failure signatures and a class in the QA failure
  issue, an explicit attempt-2 count, and a classification step replacing the
  failure template's "transient flake" sentence.
  *Corrected in review:* the first wave was first recorded from a regex that
  matched the template sentence every such issue carries (so it could not say
  no), and the check-run breakdown omitted 3 cancelled runs and 1 in flight.

**Improvement candidates (one PR each), pending the owner's word:**
- C1 — the promotion digest upserts the newest open issue carrying the
  `promotion` label; #3262 (the prod RPC swap procedure) carries it and has
  been overwritten 33 times since 2026-09-24T09:04Z. Its author was notified
  on #3262 during the scan.
- C2 — the passport UID repair landed 2026-09-25 (#3327): every tick re-reads
  the ten oldest rows that already match (20 chain reads, logged as
  unrepairable), and with ten such rows older than a phantom one it stalls
  (three ticks, 0 repaired, on a real database); its reader accepts an `Attested` log the mint path's reader
  refuses; and the mint path's attester guard has a test that cannot fail
  (mutation survived, 7 / 7).
- C3 — three owner revoke submit routes record a revocation without checking
  that the signed calldata disables those delegations; the rule exists at
  the other two submit sites (#906). A `disableDelegation` → `enableDelegation`
  mutation survives 120 / 120.
- C4 — two gating QA scenarios (the within-budget settle and the delegation
  lifecycle's revoke) read no chain effect from any node; their PASS tests
  stay green with the observer RPC on a dead port.
- C5 — both balance monitors commit their "alerted" state before sending and
  never check the webhook's status: a 404 is posted once, never logged, never
  retried while the condition persists.
- Verified and held back by the cap: guard-freshness files a new issue per
  qa-dev flap (five in 28 hours); the change classifier routes the four
  served docs to no surface (incident #3288); the copy lint does not scan the
  app's message catalog; three instruments in this skill's reference misread.
- Context, not new: the nonce hole a post-stamp broadcast failure leaves
  (#2769); a class note that C2, C3 and C4 share one shape with #3294 and
  #2968 (an on-chain effect recorded without chain evidence) — no census
  was taken, so it is not proposed as a structural finding.

**Probed clean** (block → command → number, all at `2cc23374`):
- sizing → the 09-22 command (control at `fd7b1289` reproduces 77,152) →
  backend 80,798 / 101,079; frontend 51,892 / 45,854; sdk 13,481 / 13,991;
  core 18,316 / 347; qa-agent 7,306 / 5,229.
- block 1 (guard falsifiability) → 10 mutations over two samples → the day's
  money-path landings 3 caught / 1 survived (C2), plus the captain's own
  landing caught; the least-scanned code 3 caught / 2 survived (C3; a
  QA-harness merchant-leg check, a note).
- block 2 (`covers:` completeness) → the reference loop under bash with
  `set -f`, misses confirmed with the strict gate → 18 across 6 of 8 contract
  docs (09-22: 17 across 5); `npm run docs:covers-gaps` → 138 / 36
  (unchanged).
- block 3 (stale numbers) → partial → 25 newest shards: 1 figure line by the
  block's regex, 0 with a command (the regex misses its own specimens — a
  held-back candidate); `any` → 24 and db-mock gauge 54 / 273 / 57, both
  unchanged.
- block 4 (retired vocabulary) → positive control 36 shards → 192 files, 46
  historical / 146 live (+1 live, a new test file).
- block 5 (merge-method drift) → since 2026-09-22T00:00:00Z → 0 merge-commit /
  53 squash (clean); since 2026-08-10T00:00:00Z → 282 / 743 of 1,028
  (unchanged merge count).
- block 6 (nets with holes) → examined, all four halves → copy lint 87
  unscanned / 6 with hits (hole: the message catalog); money perimeter 31
  verb files / 19 outside; visual 9 of 26 routes (12 resolving concrete ids);
  docs boundary 39; the freshness gate's completeness warning is dead under
  the require-all-legs variable.
- incident clustering → issues created since 2026-09-22T00:00:00Z → 52; the
  untracked recurring class is S1.
- workflow archaeology → `ci.yml` last 200 → 5 with attempt > 1 (4 parked
  bot-push runs), 14 failures, 0 on `dev`; qa-dev read at the `money-flow`
  job level (see S1).
- comment archaeology → TODO / FIXME / HACK / XXX → 0 (control `import` →
  1,499 files).
- live exercise → not taken beyond two read-only nonce reads.

Instrument lessons: run-level qa-dev conclusions count gate-skipped runs as
success (the 60 newest "successful" runs held no harness log); BSD `sed`
accepts a GNU-only address as a silent no-op (print the applied diff before
trusting a mutation); a fresh worktree needs the core and SDK builds before
backend suites, and Vitest's `Tests` line hides files that failed to import;
`ethers`' provider bypasses a stubbed global `fetch`; `fetch` resolves on
4xx/5xx.

**Disposition (owner, 2026-09-25): file all; merge the report (#3334, `5a3ad38b`).**
S1 → epic #3335 (`epic`, `area:ci`, `area:qa`, `area:docs`), with slices #3336
(conformance probe), #3338 (per-attempt logs and the attempt-2 count), #3337
(failure class and signatures; it absorbed #3339, which was closed after the
spec review found both rewriting the same body builder) and #3340
(guard-freshness window and reopen). The held-back guard-freshness candidate
became #3340. C1 → #3341 (it widened in review to the docs-audit workflow's
copy of the same upsert). C2 → #3342, C3 → #3343 (`money-path`; each carries a
threat model pending the owner's confirmation). C4 → #3344. C5 → #3345 (`money-path`; it
widened in review to a third alert sender, the catalog ops alert). The
held-back candidates: the classifier → #3346, the copy lint → #3347, the scan
reference → #3348 (it widened in review to the release skill's run-level
qa-dev read). The #2769 context was posted there as a comment. Filed to the
backlog (no `code-quality`); every issue has a spec-review verdict (the
epic's slices share one, posted on #3335).

*Scan figures corrected after filing, found by the spec reviews* (each
issue's verdict comment lists its other corrections):
- C4's dead-port "3 passed" was 2 PASS tests plus 1 SKIP test (#3344).
- C-extra-2's incident was a backend PR (51 files, 47 backend) that also
  edited a served doc, not a docs-only one (#3346).
- The C-extra-4 "1 vs 9" count-noun figure could not be reproduced, because
  no regex was recorded; it was dropped (#3348).

## 2026-10-03 — whole repo, weighted to the landings since 2026-09-25 (the budget wave of epic #3328 and the ops console; owner request 2026-10-03, no scope named)

Full report: `docs/bug-reports/quality-scan-2026-10-03-whole-repo.md` (it is
held outside the repo until the owner decides; it carries the file:line
evidence). This entry stays path-free, per the 2026-09-10 convention.
Measured on `origin/dev` @ `b00d75bd7` in one isolated detached checkout. The
checkout was `npm ci`'d, and core and the SDK were built. Mutations were
restored with `git checkout --` and a `cmp` against a `cp` backup. Real-DB runs
used a disposable local database, dropped afterwards. GitHub was read-only. No
live call was made. At the end, `git status --porcelain` → 0.

**Excluded this run:** every prior finding and candidate, whatever its
disposition, including the 2026-09-15 mock-families item (`accepted-as-debt`).
None is re-surfaced. The re-measurable deltas are in the coverage record below.
None worsened materially.

**Structural finding (pending owner decision):**
- S1 — each payment entrypoint decides its own budget question.
  - The direct payment route, the two x402 legs and the MPP pre-check each
    decide which delegation the remaining-budget pre-check reads, whether the
    task cap applies, which replay is exempt, and how the typed
    `delegation_budget_exceeded` body is spelled.
  - The hosted and local tool schemas thread `task_budget_id` /
    `sub_budget_id` tool by tool.
  - Parity is kept by comment. One comment says the direct route answers "the
    same body the x402 legs answer"; another says the pre-check's replay rule
    is "STRICTER than" the x402 replay's.
  - Measured:
    - the typed body's error code is written at 9 sites in 3 files: 5
      response bodies and 4 refusal-ledger `detail` objects
      (`git grep -h "error_code: 'delegation_budget_exceeded'" b00d75bd7 -- 'packages/backend/src/*' ':!*.test.ts' ':!*__tests__*' | wc -l`
      → 9; split corrected by the epic's spec review);
    - with a sub-budget there are three different rules for which links the
      period pre-check reads: all three links with the minimum winning (the
      direct route), the delegating agent's parent only (x402 erc7710), and
      the paying agent's own token/recipient selection (x402 EIP-3009 funding
      leg);
    - route test files per entrypoint × scope: payments 6 task / 2 sub, x402
      3 task / **0 sub**
      (`git grep -l <key> b00d75bd7 -- packages/backend/src/routes`, filtered to
      `/<entrypoint>[^/]*\.test\.ts$`, key `task_budget_id` / `sub_budget_id`
      → 6 / 2 / 3 / 0).
  - By execution:
    - disabling sub-budget resolution on both x402 legs left 27 x402 test
      files / 403 tests and 4 other sub-budget files / 113 tests green;
    - the matching direct-route mutation turned its sub-budget suite 3 red of
      16;
    - the hosted plain-HTTP pay tool refuses `sub_budget_id` (strict parse),
      though its handler forwards that key on both branches and the local
      tool of the same name declares it.
  - Cost: 11 issues in the class in 7 days, created 2026-09-26 → 10-02 (#3378,
    #3392, #3464, #3476, #3492, #3500, #3503, #3504, #3518, #3527, #3609; a
    hand classification). The issue numbers appear 316 times in 53 non-test
    source files
    (`git grep -h -o -P '#3(378|392|464|476|492|500|503|504|518|527|609)\b' b00d75bd7 -- 'packages/*/src/*' ':!*.test.ts' ':!*__tests__*' | wc -l` → 316; `-l` → 53).
    Instrument lesson: the scan's first regex listed 8 of the 11 cluster
    issues (206 / 40); the epic's spec review caught it.
  - Five slices: a shared budget-scope resolver (blocks the rest), x402
    adoption with the first x402 × sub-budget tests, direct-route adoption, one
    replay predicate, and an entrypoint × scope × replay matrix ratchet that
    also covers hosted-vs-local payment tool schemas.

**Improvement candidates (one PR each), pending owner decision:**
- C1 — the #3609 source-scan guard for raw error text in responses is
  key-shaped (`details:` only).
  - Two probes on the sweep relay's 502 stayed green (4 / 4): a cast form,
    `details: (err as Error).message`, and the raw text under `error:`.
  - One response already answers `String(err)` under `error` in the Fortnox
    voucher push's `failures[]`. Its content is not tested; only the shape is
    observed.
  - Context: #3609 is still open.
- C2 — the ops on-chain view's single-flight cache test is timing-flaky. It
  asserts deep equality across two calls whose `generated_at` is stamped per
  call with no injected clock. It turned `dev` CI red twice in the last 200
  `ci.yml` runs (runs 37023532565, 36969879117; the diff in both is 1 ms of
  `generated_at`). Untracked.
- C3 — the hosted plain-HTTP pay tool refuses `sub_budget_id`, which its
  handler forwards and the local tool declares (S1's concrete defect). The
  owner decides whether to declare it or delete the forwarding. Untracked.
- Context, not proposed: qa-dev `money-flow` → 15 failure / 85 skipped /
  0 success over the last 100 runs (since 2026-10-02T12:47Z), all at the
  harness preflight (QA wallet USDC below its floor). The #3609 deploy is not
  QA-exercised. The remedy is the operator top-up; tracked on #2769 (17 bot
  comments, 0 human, in the window).

**Probed clean** (block → command → number, all at `b00d75bd7`):
- sizing → the 09-22 command, pinned with `git ls-tree`/`git show`. The
  control at `2cc23374` reproduces backend 80,798 / 101,079. Now: backend
  101,373 / 127,733 (+25 % / +26 % in 8 days); frontend 60,143 / 54,473; sdk
  16,876 / 18,196; core 23,676 / 500; qa-agent 8,567 / 6,513; mcp-server
  10,123 / 19,659; signer 4,664 / 7,767; connect 11,620 / 14,592; cli
  2,643 / 2,651.
- block 1 (guard falsifiability) → examined. The census script gives 15
  candidate files. 5 mutations, one per file, newest landing first:
  - **4 caught**: raw-details guard 1 red of 4; prepare-failure redaction 2
    of 17; x402 task-cap erc7710 1 of 11; hosted PREPARE_REVERTED mapping 1 of
    20.
  - **1 survivor in its named file**: the direct route's sub-budget
    min-of-links, 11 / 11 in the period-budget file. Diagnosis: *not
    load-bearing at the tested condition*. The sibling sub-budget suite
    catches it, 3 red.
  - 10 census files were not mutated (budget is 5).
- block 2 (`covers:` completeness) → examined. The reference loop under bash
  with `set -f`, each miss confirmed with the strict gate → 18 across 6 of 8
  contract docs (unchanged from 09-25). Two raw "misses" were glob strings,
  not paths. `npm run docs:covers-gaps` → 134 pairs / 36 docs (09-25:
  138 / 36).
- block 3 (stale numbers) → partial.
  - The positive control matches all 3 specimens.
  - The 25 newest shards give 1 figure line, and it is a false match; 0 have
    a command.
  - Blind spot: the newest shard's `label: N;` list of about 26 mutation
    counts is unmatched. One of those counts was re-derived (the sweep-relay
    raw-variable mutation: 1, equal to this run's M1).
  - `any` 24 → 30 (code lines 6 → 10). db-mock gauge 54 / 273 / 57 →
    54 / 270 / 57.
- block 4 (retired vocabulary) → examined. Positive control 36 shards.
  194 files, 46 historical / 148 live (+2 live: a demo page and a hosted test;
  a Button moved packages). The ratchet is green below baseline. The three
  x402 repository exports still have 0 non-test importers; one gained a new
  comment that names it as a live writer.
- block 5 (merge-method drift) → examined. Since 2026-09-25T00:00:00Z →
  0 merge-commit / 169 squash (clean). Since 2026-08-10T00:00:00Z →
  282 / 895 of 1,180.
- block 6 (nets with holes) → examined, all four reference halves plus four
  probes:
  - copy lint 98 unscanned / 6 with hits;
  - money perimeter 32 verb files / 20 outside (the new one is a comment
    hit);
  - visual gate 15 of 31 frontend routes;
  - docs boundary 39 (unchanged);
  - freshness-gate exit branches unchanged;
  - probes as in C1, C3 and S1;
  - the ops app's routes are outside the visual measure (not examined).
- incident clustering → issues created since 2026-09-25 → 147 (131 closed /
  16 open). The untracked recurring class is S1.
- workflow archaeology → `ci.yml` last 200 → 8 with attempt > 1 (all feature
  branches), 18 failures, 4 on `dev` (2 = C2, 1 = the budget-suite race fixed
  in `b00d75bd7`, 1 design-visual not diagnosed). qa-dev is read at the
  `money-flow` job level (see Context).
- comment archaeology → TODO / FIXME / HACK / XXX → 0 (control `import` →
  1,844 files).
- live exercise → not taken.
- Novelty: tracker checked (open issues 25, open PRs 2, issue searches named
  in the report). Bug-report bodies were not re-read, so novelty against them
  is unverified.

Instrument lessons:
- An unquoted `$T` in zsh passes the whole file list as one argument, and
  vitest answers "No test files found" with exit 1. Not a green, but it reads
  as nothing ran — use `${=T}`.
- Slicing a refusal message at 160 characters hid a declared key and nearly
  produced a false claim. Read the full text before asserting a list.
- The block-3 regex still misses the `label: N;` list shape the newest
  measured shard uses.

**Dispositions (owner decision 2026-10-03):**
- **S1 → filed** as epic [#3615](https://github.com/d-hinders/Haven-AI/issues/3615), slices #3616–#3620 (backlog, `pending-review`); spec-review verdict posted on the epic (34 claims re-run, 5 corrected, `## Threat model` added).
- **C3 → folded into #3617** as an explicit acceptance item (declare `sub_budget_id` on hosted `haven_pay_x402_quote`, or delete the dead forwarding); that choice is owner decision 2 on the epic and blocks the slice.
- **C1, C2 → not filed.** The owner chose to file S1 only; no `accepted-as-debt` or `rejected` disposition has been recorded for either, so both remain pending owner decision; as prior candidates they are excluded from re-surfacing unless they materially worsen.

## 2026-10-13 — whole repo, weighted to the landings since 2026-10-03 (owner request 2026-10-13, no scope named)

Full report: [`docs/bug-reports/quality-scan-2026-10-13-whole-repo.md`](../bug-reports/quality-scan-2026-10-13-whole-repo.md)
— file:line evidence lives there; this entry stays path-free. Measured on
`origin/dev` @ `641f527d` by the captain and three read-only workers (two
census workers in detached worktrees, one GitHub worker). The clone arrived
shallow at 50 commits and was unshallowed before any history figure was taken.
Mutations used `cp` backups with `cmp` restores; real-database runs used a
local Postgres 16 cluster and a disposable database; one temporary probe test
was written, run and deleted. GitHub was read-only. No live call was made. At
the end, `git status --porcelain` → 0.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. None is re-surfaced. Deltas are in the coverage record below;
none worsened materially.

**Structural finding (pending owner decision):**
- S1 — whether a budget is live is decided at about forty sites with three
  different answers, and the one shared predicate is four days old and
  reaches seven of them.
  - Three tables hold spend authority (delegations, task budgets, sub
    budgets). The one helper encodes the expiry window only; it was
    introduced by the #3802 fix (`0108c6d9`, 2026-10-09: 11 code files, 6
    call sites) and today has 7 call sites in 5 files, beside 3 inline copies
    of the same window on the same table. A second definition, the LIVE
    status set with no expiry, has 7 SQL uses in 3 files plus 2 hand copies
    in TypeScript (dashboard dialog, CLI). A third is status-only or no
    predicate: the budget list route, the dashboard's received-sub read, the
    merchant funding picker. Task and sub budgets have no helper: 10 SQL
    expiry sites against an app clock, 2 of them payment selectors with no
    production caller while TypeScript copies decide.
  - 11 pairs of sites classify the same row differently (enumerated with
    file:line in the report); 7 are verdict conflicts on one row. Two proven by execution on the real database: an
    expired `active` delegation returns 0 rows from the budget view and
    counts 1 in `live_delegation_count` (no budget, yet cannot be archived or
    revoked); an expired `open` received grant reads `open = true` for the
    dashboard and is absent from the agent's own open list, so the Needs-you
    "usable budget" predicate is satisfied by an expired grant.
  - Cost: #3542, #3553 (10-01), #3729 (10-07), #3773 (10-08), #3802 (10-09) —
    five issues in nine days, each the same defect at a different site, each
    fixed at that site; the #3615 resolver (the 10-03 S1) consolidated which
    delegation the pre-check reads and still reads liveness through the
    inline by-hash SQL and the task/sub TypeScript predicates. No open issue
    names the predicate (semantic search → two of the fixes and two unrelated
    issues).
  - Five slices: name the two delegation sets in one module and adopt the
    spendable one at the inline copies and the list route; one predicate per
    table for task and sub budgets with one clock; liveness on the wire
    consumed by SDK/CLI/frontend instead of recomputed; the proven and hard
    conflicts fixed as behaviour with real-DB tests; a shrink-only census
    ratchet.

**Improvement candidates (one PR each), pending owner decision:**
- C1 — the agent-reported EIP-3009 merchant settlement hash is attributed by
  shape (the evidence module passes no delegation hash or nonce) while the
  passive sweep attributes by the derived nonce since #3888; the writer's own
  comment names the residual. Hypothesis, no incident. One PR.
- C2 — the 2026-10-03 scan report never landed: the entry above names a path
  absent from the tree ten days after the owner's decision, so #3615's
  file:line evidence and that run's one still-undecided candidate (its C1)
  are recoverable only outside the repository. One docs PR.
- C3 — block-1 survivor: removing the `merchant_settlement_tx_hash IS NULL`
  compare-and-set left 76 / 76 green across five suites, only two of which
  (43 tests) reach the writer (corrected in the new-task spec review). Diagnosis: *not load-bearing at the
  tested condition* — the writer pre-reads under an advisory lock keyed by
  the hash, so only a two-different-hashes-one-payment race reaches the
  clause, and the one concurrency test drives the opposite race. One PR (a
  real-DB concurrency test, optionally a lock on the intent id).
- Notes, not proposed: two `status: archived` docs outside the archive
  folders make `docs:covers-gaps` warn on every run; the advisory visual job
  is 7 of 13 determinable CI failures in the window (decided on #3231);
  the tools/list golden went red on `dev` when two green PRs crossed (#3886;
  up-to-date off by O1; #3890 watcher shipped); the sign route's `failed`
  booking after a landed UserOp is reachable only through the confirm's own
  DB write (read, not executed).
- Refused under the bar: settlement evidence per leg — no write is gated on a
  merchant's 200, two of three chain-verifying legs share the #2092
  verifier, and the EIP-3009 wave (10 issues) is a shipped feature.

**Dispositions observed (upkeep the ledger lacked):** 2026-10-03 C2 →
`shipped` via #3624 (`0224c883`, 2026-10-04). 2026-10-03 S1 → epic #3615
closed (all five slices) → `shipped`. 2026-09-25 S1 → #3335 closed
2026-09-29 → `shipped`. 2026-09-22 F1 → #3231 closed 2026-09-26 → `shipped`.
2026-09-15 F1 → #3028 closed 2026-09-29 → `shipped`. 2026-09-16 F1 → #3056
closed 2026-09-20 and 2026-09-17 F1 → #3105 closed 2026-09-20 → `shipped`.

**Probed clean** (block → command → number, all at `641f527d`):
- sizing → the 09-22 command, pinned with `git ls-tree`/`git show` → backend
  109,321 / 140,397 (10-03: 101,373 / 127,733; +7.8 % / +9.9 %); frontend
  62,690 / 61,829; sdk 18,387 / 19,977; core 24,845 / 607; qa-agent 9,693 /
  7,784; mcp-server 12,586 / 23,237; signer 5,271 / 8,404; connect 12,436 /
  15,676; cli 3,159 / 3,454; ops 3,127 / 2,114; ui 2,203 / 1,639.
- block 1 (guard falsifiability) → examined. The census script gives 31
  candidate files over 4 of the last 20 landings. 5 mutations, one per file,
  newest landing first → **4 caught** (supersession read 2 red of 98;
  verified-settlement outranking 1 of 28; dismissal user scoping 1 of 15,
  real DB; SDK supersession mapping 1 of 58), **1 survivor** (C3, diagnosed;
  76 / 76 green under the mutation).
  26 census files not mutated (budget is 5).
- block 2 (`covers:` completeness) → examined. The reference loop under bash
  with `set -f`, each miss confirmed with the strict gate → 18 across 6 of 8
  contract docs (unchanged from 10-03 and 09-25); 2 raw misses were glob
  strings. `npm run docs:covers-gaps` → 130 pairs / 35 docs (10-03: 134 / 36).
- block 3 (stale numbers) → partial. Positive control 3 / 3. The 25 newest
  shards → 20 figure lines, 6 with a command (10-03: 1 / 0). `any` 30 → 37
  (lines not led by a comment marker 16, about 6 of them prose; no code-line
  delta claimed). db-mock gauge 54 / 270 / 57 (unchanged). Guard
  scripts 69 (09-15: 49); non-spawning self-tests 23 of 71 (09-15: 20). zod 0.
- block 4 (retired vocabulary) → examined. Positive control 36 shards. 195
  files, 46 historical / 149 live (10-03: 194 / 46 / 148). Ratchet green,
  33 / 31. Code half unchanged.
- block 5 (merge-method drift) → examined. Since 2026-10-03T00:00:00Z → 0
  merge-commit / 162 squash (clean). Since 2026-08-10T00:00:00Z → 282 /
  1,054 of 1,339.
- block 6 (nets with holes) → examined, all four halves → copy lint 52
  unscanned / 4 with hits (10-03: 98 / 6); money perimeter 32 verb files / 20
  outside (unchanged); visual gate 15 of 28 app routes (10-03: 15 of 31; the
  site switch-over deleted pages), 8 ops routes outside the measure; docs
  boundary 39 (unchanged); freshness-gate exit branches unchanged.
- incident clustering → issues created since 2026-10-03 → 138 (9 open /
  129 closed); dashboard redesign 39, connect pair naming 12, budget
  lifecycle 11, EIP-3009 settlement 10, Gnosis removal 10, the rest smaller.
  The untracked recurring class is S1.
- workflow archaeology → `ci.yml` newest 100 → 77 / 15 / 8; 13 with attempt
  > 1 (all feature branches); `dev` 35 → 30 / 1 / 4, the failure the #3886
  golden skew; failing jobs: visual 7, MCP server 3, browser smoke 3, backend
  1, CI-config 1. qa-dev at the `money-flow` job level → 60 newest runs all
  `success` at run level, so 0 `money-flow` failures; of the 25 newest created
  at or before 2026-10-13T15:42Z, `money-flow` ran in 5 (5 success) and was
  gate-skipped in 20; attempt-2 passes 0 of 5 logs; 31 scheduled runs 09-13
  → 10-13 → 4 failures (3 wallet preflight 10-02..10-04, 1 backend 09-24),
  nine green days since #3631. *Corrected in review:* first written as "25
  looked up, 10 ran" from a hand-chosen run set.
- comment archaeology → TODO / FIXME / HACK / XXX → 0 (control `import` →
  1,994 files).
- live exercise → not taken.
- Novelty: tracker checked (138 issues, 0 open PRs, one semantic search).
  Bug-report bodies were not re-read, so novelty against them is unverified.

Instrument lessons: the cloud checkout is shallow (50 commits) — unshallow
before block 5 or any `git show` at a prior SHA; an empty variable in
`rg -l "$fn"` matches every file; a sub-budget grant row needs its
parent-child row or the self-parent check refuses the seed; the coupling
gate's `--changed=` is shell-expanded, so glob-string misses must be dropped
before confirmation.

**Disposition: pending owner decision** (S1, C1, C2, C3).

**Disposition (owner, 2026-10-14): file all four.** S1 → epic
[#3919](https://github.com/d-hinders/Haven-AI/issues/3919) (`epic`, `money-path`,
`area:backend`, `area:sdk`, `area:frontend`, `area:docs`) with slices #3920 (A,
delegation predicates named and adopted), #3921 (B, task and sub predicates),
#3922 (C, liveness on the wire), #3923 (D, the five verdict conflicts; the
owner's five semantics decisions recorded on the issue the same day), #3924 (E,
the census ratchet); one spec-review verdict posted on the epic. C1 → #3925
(`money-path`, `area:backend`, `area:docs`; threat model confirmed, attribution
by the posted header's own nonce). C2 → #3926 (`area:docs`; one partner
question on where the 10-03 report lives, not a hold). C3 → #3927 (`money-path`,
`area:backend`; the lock is widened to a prefixed intent key). Filed to the
backlog (no `code-quality`); each issue carries a spec-review verdict and no
owner question remains open, so `pending-review` is lifted on all nine. Drive:
`ship-next epic=#3919`, `ship-next 3925`, `ship-next 3926`, `ship-next 3927`.

**Disposition upkeep (2026-10-14):** C2 → `shipped` via #3942 (2026-10-14): the
2026-10-03 report was recovered from the scan session's record of its write
and committed at the path the 2026-10-03 entry names.

**Disposition upkeep (2026-10-14):** C3 → `shipped` via #3948
(2026-10-14): the writer takes a prefixed intent lock after its hash lock; the
direct-SQL interleave test is the compare-and-set's mutation proof.

## 2026-10-19 — whole repo, weighted to the landings since 2026-10-13 (owner request 2026-10-19, no scope named)

Full report: [`docs/bug-reports/quality-scan-2026-10-19-whole-repo.md`](../bug-reports/quality-scan-2026-10-19-whole-repo.md).
The report holds the file:line evidence; this entry stays path-free. Measured
on `origin/dev` @ `595b43c07` by one agent in an `npm ci`'d worktree, one
heavy job at a time, with core, the SDK and the signer built. The window is
`641f527d..595b43c07` → 101 first-parent landings. Seven mutations were run
behind `cp` backups, each restored with `cp` and checked with
`git diff --quiet`. Real-DB runs used a disposable database, dropped at the
end. GitHub was read-only. No live call was made.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. None is re-surfaced. C1 sits beside the 2026-09-25 S1 (epic
#3335, `shipped`): it is one capability that finding's shipped probe does not
check, with two incidents since, not a re-surface of the qa-dev triage
finding. None of the re-measured figures worsened materially.

**Structural findings:** none in the examined sample. The four candidates
share a resemblance (an instrument checking a copy or a neighbour of what it
claims to check), but they have four mechanisms and four remedies and no
common census. The eval suite's first-live-week fix wave was refused: it is
an open epic, and each defect is tracked.

**Improvement candidates (one PR each), pending owner decision:**
- C1 — the RPC conformance probe checks five capabilities and not
  `eth_getLogs` range (a grep of the probe for `getLogs` → 0). Alchemy's
  probe pass is recorded in the swap issue's body for 2026-09-29, and the
  post-swap 2026-10-01 output there reads "all 5 checks passed". The free
  tier's 10-block
  log cap then broke the x402 settlement sweepers (#4012: 76–80
  `chainsUnavailable` per tick, 16.4M of a 30M-CU monthly pool by
  mid-month) and the QA harness's transfer probe (#4086: the eval pilot
  graded three real payments missing). Each was fixed in its own package with
  its own window logic. Untracked.
- C2 — qa-dev's EIP-3009 legs prove both on-chain legs and never that Haven
  recorded the merchant settlement (the scenario directory's grep for any
  evidence field → 0 lines). The hosted signer leg's docblock still says
  Haven never observes that settlement. From #3925's landing (2026-10-14) to
  #4075 (2026-10-19), the hosted settle path's settlement report carried no
  header and was refused (tree at the parent of #4075; #4075's SDK commit).
  The hosted signer leg passed on the first attempt of all five scheduled
  runs in that interval. Four runs' jobs succeeded. On 10-16 the job failed:
  the leg failed on attempt 2 only, on a merchant refusal after funding, not
  on an evidence check. #4061 was found by a hand-run purchase.
- C3 — the SDK makes the post-funding merchant-answer decision twice (the
  hosted path in the client facade, 267 lines; the local path in the
  merchant-completion module, 187 lines). Of 17 commits to the second since
  the facade refactor, 15 also touched the first, and both of 2026-10-19's
  money-path fixes edited both. By execution: the hosted copy's #4062 guard
  disabled leaves every SDK suite that drives it green (90 / 90). It is
  caught only by the hosted MCP suite against a rebuilt SDK build (1 of 58).
- C4 — the eval graders' hosted and signer tool lists are hand copies, and
  their pinning test asserts each copy's own length. A 30th hosted tool added
  to the hosted snapshot left three eval suites green, 79 / 79 (*weak test*).
  A missing payment tool would make the no-retry grader false-pass. The
  repo's precedent for the class is the connect runtime-manifest drift
  (2026-08-14 entry).
- Notes, not proposed: a month-to-date spend reader with no caller and
  calendar-month SQL in the session zone; the unpinned session time zone
  (#4084 tracks the one live site; the scan's census found 2, one of them
  in a dead function); a
  block-1 hazard in which deleting the only clause that references a bind
  parameter reddens on a SQL error, not the guard.

**Dispositions observed (upkeep the ledger lacked):** 2026-10-13 S1 → epic
#3919 closed 2026-10-19, all five slices merged → `shipped`. 2026-10-13 C1 →
#3925 closed 2026-10-14 via PR #3961 (`bd808304c`) → `shipped`. Its
follow-on #4061 (the hosted report tools could not meet the new requirement)
is open, and its fix #4075 has landed.

**Probed clean** (block → examined / partial / not examined → command → number, all at `595b43c07`):
- sizing → examined → the 09-22 command pinned with `git ls-tree`/`git show`;
  the control at `641f527d` reproduces backend 109,321 / 140,397. Now: backend
  112,970 / 146,150; qa-agent 12,691 / 10,530 (+31 % / +35 %, the eval
  suite); frontend 67,922 / 69,530; sdk 18,567 / 20,176; mcp-server 13,311 /
  24,264; the rest within a few percent of 10-13.
- block 1 (guard falsifiability) → examined. The census script → 31
  candidate files over 5 of the last 20 landings. The brief chose the sample
  from the window's landings: five census files and two eval-suite files.
  7 mutations → **5 caught in their targeted file** (owner-send insert
  ownership 1 of 12, real DB; sibling-header refusal 1 of 44, real DB;
  verifier pairing 1 of 7; SDK local-path #4062 guard 1 of 46; grader
  unsettled filter 1 of 25), **1 caught only across a package boundary** (C3,
  90 / 90 green in the SDK, 1 of 58 in the hosted suite), **1 survivor** (C4,
  79 / 79, *weak test*). The suites run cover 8 of the 31 census test files
  (the census output intersected with the run list), so 23 of 31 were not
  exercised.
- block 2 (`covers:` completeness) → examined. The reference loop under bash
  with `set -f`, each miss confirmed with the strict gate → 18 across 6 of 8
  (unchanged since 09-25); 2 raw misses were glob strings.
  `npm run docs:covers-gaps` → 129 pairs / 35 docs (10-13: 130 / 35).
- block 3 (stale numbers) → partial. Positive control 3 / 3. The 25 newest
  shards → 11 figure lines, 1 with a command (10-13: 20 / 6). Two shard
  figures re-derived and matching. One stale docblock found (C2). `any`
  37 → 38. db-mock gauge 54 / 270 / 57 (unchanged). Guard scripts 69 → 71.
  Non-spawning self-tests 23 of 71 → 25 of 74. zod 0.
- block 4 (retired vocabulary) → examined. Positive control 36 shards. 195
  files, 46 historical / 149 live (unchanged). Ratchet green, 32 / 30
  (10-13: 33 / 31). Code half unchanged.
- block 5 (merge-method drift) → examined. Since 2026-10-13T00:00:00Z → 0
  merge-commit / 109 squash (clean). Since 2026-08-10T00:00:00Z → 282 /
  1,155 of 1,440.
- block 6 (nets with holes) → examined, all four halves → copy lint 56
  unscanned / 4 with hits (10-13: 52 / 4); money perimeter 32 / 20
  (unchanged); visual gate 15 of 28 (unchanged); docs boundary 39
  (unchanged); freshness-gate exit branches unchanged. Probes beyond the
  reference: C1 and C2.
- incident clustering → examined. Issues created since
  2026-10-13T00:00:00Z → 87 (11 open / 76 closed). By hand: marketplace 14,
  dashboard and agents UI 12, navigation 9, agent evals 8, account-page epic
  7, budget-liveness epic 6, multiple accounts 6, release/docs/CI/ops 5,
  time windows 4, then 3 or fewer each. The untracked recurring mechanisms
  are C1 and C2.
- workflow archaeology → examined. `ci.yml` newest 100 → 64 / 13 / 23; 7
  with attempt > 1, all feature branches. `dev` 32 → 26 / 2 / 4. Visual
  regression is 6 of the 8 failures with a failed job.
  - qa-dev at the `money-flow` job level: of the newest 30 runs, it ran in 6
    (5 success, all on attempt 1/2; 1 failure) and was gate-skipped in 24.
  - Scheduled runs 10-15 → 10-19: 4 success and 1 failure (10-16). In the
    failure, attempt 1 failed only the catalog-guided purchase
    (`CALL_EXCEPTION`); attempt 2 failed four legs, the hosted signer leg
    among them.
  - `agent-evals` on 10-19: 14 runs (1 success, 9 failure, 3 cancelled, 1 in
    progress).
- comment archaeology → TODO / FIXME / HACK / XXX → 0 (control `import` →
  2,057 files).
- live exercise → not taken (a tree scan by brief).
- SKILL step 3's unnumbered probes → fat controllers: not examined.
  Data-layer coverage: not examined as a census (db-mock gauge only).
  Validation and contract enforcement: partial (only the #3925 → #4061
  chain). Cross-package duplication: partial (the C3 and C4 probes only).
- Novelty: the tracker was searched per candidate. The ledger and bug
  reports were grepped for C3's surface. Bug-report bodies were not otherwise
  re-read.

Instrument lessons: a mutation must keep every bind parameter referenced;
hosted MCP suites see an SDK mutation only after an SDK rebuild (rebuild
again after the restore); `\b` in `git grep -E` misread again; a fresh
worktree needs core built before backend suites that import it.

**Disposition: pending owner decision** (C1, C2, C3, C4).

**Disposition (owner, 2026-10-20): file all four and build them.** C1 →
[#4118](https://github.com/d-hinders/Haven-AI/issues/4118) (`area:ci`,
`area:docs`). C2 → #4119 (`area:qa`, `area:docs`; scope widened to all four
EIP-3009 legs, reading `merchant_settlement_recorded` against the leg's own
proven hash). C3 → #4120 (`area:sdk`, `area:ci`, `area:docs`, `money-path`;
owner decisions the same day: a `PAYMENT-RESPONSE` header with no transaction
beside a `_meta` settlement that has one is **accepted on both paths** with the
`_meta` hash, so the hosted path changes; `merchant-completion.ts` and the new
shared module join the money-path globs, `client.ts` stays off). C4 → #4121
(`area:qa`, `area:docs`, `area:ci`). The spec reviews spawned two siblings:
#4122 (`money-path`, `area:ci`, `area:docs`; `merchant-completion.ts` onto the
runtime perimeter and the Merge Gate matcher's wildcard-only-token blind spot,
landing before #4120) and #4123 (`money-path`, `area:mcp`, `area:docs`; the
hosted retryable settlement-evidence arms never name `payment_header`). Each
issue carries a spec-review verdict; no owner question remains open (#4120
keeps one non-blocking follow-up question), so `pending-review` is lifted on
all six. Filed with shipping requested.

**Disposition upkeep (2026-10-20):** C1 → `shipped` via #4124 (`afcfac0eb`):
the probe's sixth check asks `eth_getLogs` over `DEFAULT_LOGS_RANGE` = 500
blocks, pinned to the sweepers' widest batch.

## 2026-10-21 — whole repo, weighted to the landings since 2026-10-19 (owner request 2026-10-21, no scope named)

Full report: [`docs/bug-reports/quality-scan-2026-10-21-whole-repo.md`](../bug-reports/quality-scan-2026-10-21-whole-repo.md).
The report holds the file:line evidence; this entry stays path-free. Measured
on `origin/dev` @ `8cc3717c8` by one agent in an `npm ci`'d worktree, one
heavy job at a time, with core, the SDK, the signer and the local MCP built.
The window is `595b43c07..8cc3717c8` → 55 first-parent landings. Seven
mutations were run behind `cp` backups, each restored with `cp` and checked
with `cmp` and `git diff --quiet`. A measurement preload that refuses and
records non-loopback connections ran outside the tree. Real-DB runs used a
disposable database, dropped at the end. GitHub was read-only. No MCP or dev
call was made.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. None is re-surfaced. C1 sits beside the 2026-10-19 C2 (#4119,
`shipped` via #4144): C2 was the qa-dev legs not checking Haven's record of
the merchant settlement; C1 is what that check found once it ran. None of the
re-measured figures worsened materially.

**Structural findings:** none in the examined sample. A "tests depend on the
machine" pattern (cold imports, real network, wall clock) was weighed and
refused: the repo has a recorded decision to keep vitest's 5000 ms default
and accept load-proportional costs (#2319, #2329, #2354), and only the
network mechanism has an executed census (C3).

**Improvement candidates (one PR each), pending owner decision:**
- C1 — the SDK's one-shot EIP-3009 merchant-settlement report rarely
  records, and qa-dev has been red on every `money-flow` run since #4144
  started requiring it. From #4144's own deploy (2026-10-20 12:21Z) to the
  scheduled run at the scan SHA: 21 failure, 1 cancelled, 0 success (the 24
  hours before: 17 success, 2 failure, neither on a settlement-record check;
  `gh run list --workflow qa-dev.yml --created '2026-10-19T00:00:00Z..2026-10-21T12:00:00Z' --limit 500`,
  then each run's `money-flow` job). Every failure names the SDK-direct legs.
  Over all 21 failed jobs (42 attempts) the SDK legs recorded within the
  window 10 times in 84 attempts (71 of 74 failures "did not record", 2 rate
  limit, 1 "already settled"), and of the hosted leg's 41 passes 39 went
  through the agent's guided follow-up, 2 through the settle's own report. The SDK's local path posts the report
  once and discards the outcome by design (#3764 D1/D2), and #4144's PR body
  named this residual and said the fix belongs in the SDK. The standing
  tracker #2769 carries 21 bot comments in the period and none from a person;
  no claim names the red. Whether dev answered `retryable` or refused, and
  whether the passive sweep recorded later, are not determinable from the
  tree. Untracked as a remedy. Money-path by file (the SDK's merchant
  completion module). *Corrected in review:* the baseline was first written
  as 11 success / 0 failure, from a run listing without `--limit` (20 newest
  runs), and the record counts came from a 7-job sample only.
- C2 — the backend's delegation builders send MetaMask SDK analytics to a
  third-party host, and nothing in the tree turns it off. Under the preload,
  31 of the 428 backend test files run opened 87 connections to the kit's
  analytics endpoint; with `DO_NOT_TRACK=1` the same `src/modules` run opened
  0 (was 11 files / 37). The kit (1.6.0) disables itself only on `CI` or a
  do-not-track signal, and `DO_NOT_TRACK` resolves in 0 tracked files. The
  payload, read from the kit's source: an initialization event with the
  session fields (SDK version, a random id, platform and, in a browser, the
  page's hostname), then per call the function name and its parameters
  (scope type and caveat names for a delegation; implementation, two
  booleans and the chain id for a smart account; the chain id for the
  enforcer client and its amount read); no address or amount. The kit tracks
  22 names (a multi-line regex over its build). Callers: 7 backend files and the
  frontend's passkey signing (read, not executed). The deployed environment
  is not determinable. Untracked.
- C3 — the backend's "a test body must not dial the real network" rule
  (written once, in a test comment, after #3969 and #3974 turned `dev` red
  twice on 2026-10-14) is enforced by no net, and 2 test files (11 tests) still
  dial the price API: 12 connections at the scan SHA, all harmless to refuse.
  The preload, in refusing mode, is the net's prototype: 425 of the 428 files
  passed under it (no baseline run was compared); the 3 reds are an environment role grant, the SSRF guard's
  loopback-pinned hostnames (match the resolved address) and the deliberate
  live-chain contract test (exempt it by name). Untracked.
- Notes, not proposed: a heuristic census of cold dynamic imports in test
  bodies (105 sites / 43 files; controls find the #4126 and #4134 sites at
  their parents, but the one remaining site sampled ran warm in 50 ms); 11
  files with wall-clock-bound assertions (#4189 fixed the one that reddened
  `dev` twice in the window); adding or reverting one hosted tool edited the
  same 8 existing test or test-support files (#4148, #4195; deliberate literal
  pins); one stale "28 hosted tool names" docblock.

**Dispositions observed (upkeep the ledger lacked):** 2026-10-19 C2 → #4119
closed 2026-10-20 via PR #4144 (`aa818795d`) → `shipped`. 2026-10-19 C3 →
#4120 closed via PR #4153 (`688b5c8dc`) → `shipped`. 2026-10-19 C4 → #4121
closed via PR #4140 (`5bb6d4ae7`) → `shipped`, re-verified by execution (the
30th-hosted-tool mutation below). The spec-review siblings: #4122 closed by
hand 2026-10-20 after PR #4131 (`44ce131a9`, `Refs`) landed;
#4123 open, its build #4133 landed with `Refs`, awaiting a live check.

**Probed clean** (block → examined / partial / not examined → command → number, all at `8cc3717c8`):
- sizing → examined → the 09-22 command pinned with `git ls-tree`/`git show`;
  the control at `595b43c07` reproduces backend 112,970 / 146,150. Now: backend
  113,538 / 147,443; qa-agent 14,550 / 12,678 (+14.6 % / +20.4 %); frontend
  71,713 / 73,900 (+5.6 % / +6.3 %); sdk 18,678 / 20,769; mcp-server 13,332 /
  24,360; the rest within a few percent of 10-19.
- block 1 (guard falsifiability) → examined. The census script → 8 candidate
  test files over 1 of the last 20 landings (the #4148 revert, the only
  money-path landing among them), 7 of them existing at the SHA. Five census
  mutations, one per file → **5 caught** (hosted strict schema 31 red of 213;
  registry missing-handler 2 of 10; blank description 2 of 9; issue reference
  in a description, byte length unchanged, 1 of 3; a 30th hosted tool in the
  snapshot 2 of 130, the 10-19 M7 that was 79 / 79 green). Two probes →
  **both caught**: the handler-side strict parse, the second copy of the
  first guard, 27 of 213; a count-only pin in the claim-release tests (the
  pin itself stayed green, 6 sibling tests of 94 caught the mutation). Census
  files exercised: 5 of 8.
- block 2 (`covers:` completeness) → examined. The reference loop under bash
  with `set -f`, each miss confirmed with the strict gate → 18 across 6 of 8
  (unchanged since 09-25); 2 raw misses were glob strings.
  `npm run docs:covers-gaps` → 129 pairs / 35 docs (unchanged).
- block 3 (stale numbers) → partial. Positive control 3 / 3. The 25 newest
  shards → 9 figure lines, 0 with a command (10-19: 11 / 1). Two shard
  figures re-derived and matching. One stale docblock (notes). `any` 38,
  db-mock gauge 54 / 270 / 57, guard scripts 71, non-spawning self-tests 25 of
  74, zod 0 (all unchanged).
- block 4 (retired vocabulary) → examined. Positive control 36 shards. 196
  files, 46 historical / 150 live (10-19: 195 / 46 / 149; +1 live, a frontend
  fixture carrying the always-0 compat field). Ratchet green, 30 / 28 (10-19:
  32 / 30). Code half unchanged. The reverted tool's name survives in 3 files,
  all history.
- block 5 (merge-method drift) → examined. Since 2026-10-19T00:00:00Z → 0
  merge-commit / 78 squash (clean); the window 0 / 55. Since
  2026-08-10T00:00:00Z → 282 / 1,210 of 1,495.
- block 6 (nets with holes) → examined, all four halves → copy lint 60
  unscanned / 4 with hits (10-19: 56 / 4); money perimeter 32 / 20
  (unchanged); visual gate 16 of 28 (10-19: 15); docs boundary 41 (10-19: 39;
  two new ship-next references); freshness-gate exit branches unchanged.
  Probes beyond the reference: the connection recorder (C2, C3) and the qa-dev
  job read (C1).
- incident clustering → examined. Issues created since 2026-10-19T00:00:00Z
  → 60 (6 open / 54 closed). By hand: account page 12, list controls 12,
  process hardening, preflight and claims 11, the 10-19 candidates 6, agent
  evals 6, tests timing out under load 2, settlement follow-ons 2, other 9.
  The untracked recurring mechanism is C1.
- workflow archaeology → examined. `ci.yml` newest 100 → 67 / 18 / 15; 9 with
  attempt > 1, all feature branches. `dev` 42 → 29 / 3 / 10: the hung-receipt
  wall-clock test twice (fixed by #4189) and one TS2304 crossing. Failed jobs:
  visual regression 6, browser smoke 5, frontend checks 4, QA agent checks 3.
  qa-dev at the `money-flow` job level: C1.
- comment archaeology → TODO / FIXME / HACK / XXX → 0 (control `import` →
  2,098 files).
- live exercise → not taken (a tree scan by brief).
- SKILL step 3's unnumbered probes → fat controllers: not examined.
  Data-layer coverage: not examined as a census (db-mock gauge; 428 backend
  test files run against a real database). Validation and contract
  enforcement: not examined. Cross-package duplication: partial (the hosted
  tool-roster census only).
- Novelty: the tracker was searched per candidate; the ledger and bug
  reports were grepped for each candidate's terms. Bug-report bodies were not
  otherwise re-read.

Instrument lessons: a connection recorder that refuses by hostname misreads
a test that pins a hostname to a local server; one backend suite needs a
role-creating database owner; batched analytics posts cannot be attributed to
a test; the block-1 census can return a deleted test file (count files that
exist at the SHA); a static census of imports in test bodies is not a census
of cold loads.

**Disposition: pending owner decision** (C1, C2, C3).

**Disposition (owner, 2026-10-21): file all three.** The owner's answers in
the captain's session were "1. a, 2. stäng av, 3. ja filera alla tre, 4. ja":
option (a) for C1, turn the analytics off for C2, file all three, and merge
the scan PR (#4202, `91257f4c2`).

- C1 → [#4215](https://github.com/d-hinders/Haven-AI/issues/4215)
  (`money-path`, `area:sdk`, `area:qa`, `area:docs`). The SDK retries the local
  path's EIP-3009 settlement report when Haven answers `retryable`. This
  revisits #3764's D2; a refusal is still never retried.
- C2 → [#4216](https://github.com/d-hinders/Haven-AI/issues/4216)
  (`area:backend`, `area:frontend`, `area:docs`). The smart-accounts-kit
  analytics are turned off in backend, scripts and frontend. The dashboard's
  other third-party telemetry (`pulse.walletconnect.org`,
  `cca-lite.coinbase.com`) is a possible follow-up for the owner, not in scope.
- C3 → [#4217](https://github.com/d-hinders/Haven-AI/issues/4217)
  (`area:backend`, `area:docs`). A backend test net refuses non-loopback
  connections and fails the test or file that made them; the two files that
  dial the price API are stubbed.

Each issue carries a spec-review verdict, all three "ready after corrections".
Main changes per issue:
- #4215 gained the hosted-twin evidence that dev answers the hosted leg's
  immediate report `retryable`; the SDK legs' own answer stays the
  builder's first step.
- #4216 established that a bundler define reaches the kit in the browser
  bundle (a runtime variable does not) and recommends it, non-binding; the
  builder decides the mechanism.
- #4217's stub criterion was corrected to the seam each file actually dials
  through.

No owner question remains open, so `pending-review` is lifted on all three.
They were filed to the backlog (no `code-quality`); shipping was not
requested with the filing.

## 2026-10-26 — whole repo, weighted to the landings since 2026-10-21 (owner request 2026-10-26, no scope named)

Full report: [`docs/bug-reports/quality-scan-2026-10-26-whole-repo.md`](../bug-reports/quality-scan-2026-10-26-whole-repo.md).
The report holds the file:line evidence; this entry stays path-free. Measured
on `origin/dev` @ `b9f9f1e47` by one agent in an `npm ci`'d worktree, one
heavy job at a time, with core, the SDK, the signer and the local MCP built.
The window is `8cc3717c8..b9f9f1e47` → 135 first-parent landings. The block-1
census and one follow-up probe ran through the repo's mutation runner, which
backs up, restores and checks each file itself. One more mutation and three
temporary probe lines were made by hand behind `cp` backups, each restored
with `cp` and checked with `cmp` and `git diff --quiet`. Real-DB runs used a
disposable database, dropped at the end. GitHub was read-only. No MCP, dev or
prod call was made.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. None is re-surfaced and none of the re-measured figures worsened
materially. The two live signer observations from the captain's purchases
(no next step on a successful x402 sign; the erc7710 MCP-merchant successor
not named) were filed as #4449 during the scan and are context, not items.
Tree instruments agree with it: the characterization suite pins refusals
only, and three temporary probes printed success keys with no next-step
field. Runtime identity: prod signer 0.8.1-alpha.0, the dev pairs
0.10.0-alpha.0, published alpha 0.11.0-alpha.0. That lag is the
stale-runtime class.

**Structural findings:** none in the examined sample. Test tooling (14 of
the 119 window issues) has several mechanisms, each fixed per site; the
repo-config self-tests ran 1778 / 1778 green under a hostile host
environment. Egress (5 issues) has one mechanism, but no executed census
shows a live instance at the SHA.

**Improvement candidates (one PR each), pending owner decision:**
- C1 — the mutation runner reads the backend's two commonest failing-assertion
  shapes as "mutation-red, fix the mutation": vitest's `.rejects` on a
  resolved promise, and the OpenAPI response-shape helper's plain `Error`.
  This run's census table read 5 mutation-red / 1 caught / 1 shadowed. By
  the mutants' own JSON reports, 4 of the 5 mutation-red cells were assertion reds
  (3 on the named guard, 1 on a sibling), so under the runner's own classes
  the guards caught 4 and 1 more is shadowed. The runner's stem
  allowlist, executed on the observed first lines → `false`, `false`
  (controls `true`, `true`). Reach: the helper in 53 backend test files / 199
  call lines; `.rejects.` in 156 test files / 598 lines (85 backend files;
  only its resolved-promise arm is affected, uncounted). This is the
  runner's third unrecorded idiom in five days, after the frontend's
  Testing Library stems and Playwright's custom-message `expect`, both
  fixed one at a time. Untracked. Off the money path; the runner files route
  to the always-run repo-config job.
- Notes, not proposed:
  - Migration-file mutations under the real-DB harness. The worker schema
    persists across runs, so a column-type mutant is refused as inherited
    drift (this run's count-only probe never ran to a class). A routine
    mutant outlived the verified file restore, unseen by a fingerprint of
    columns and indexes. Routines are in 1 of 121 migrations.
  - Egress. The third-party-URL rule is enforced per site, written as a
    warning in three places, and was broken twice in two days (#4281, #4309,
    both found by reading). 13 backend files reach the global `fetch`
    (control: 15 and 14 at the two fixes' parents), all to fixed or
    operator-configured hosts by reading. A file-level net would have caught
    neither incident; a process-wide default is a design question.
  - A shadowed tint guard whose title its test cannot fail; context for
    #4448.
  - The 2026-10-24 `dev` red came from a PR merged four minutes before its
    advisory browser smoke finished red. 9 of 134 landings merged with an
    advisory browser check red at head; advisory on `dev` is the recorded
    design.

**Dispositions observed (upkeep the ledger lacked):** 2026-10-21 C1 →
#4215 closed 2026-10-25 → `shipped`. Its build landed as PR #4222
(`01ffaa494`, `Refs`) and the issue closed after a qa-dev run with both SDK
legs green; this run's qa-dev read confirms it. 2026-10-21 C2 → #4216 closed
via PR #4223 (`715b294bd`) → `shipped`. 2026-10-21 C3 → #4217 closed via PR
#4230 (`22790a587`) → `shipped`.

**Probed clean** (block → examined / partial / not examined → command → number, all at `b9f9f1e47`):
- sizing → examined → the 09-22 command pinned with `git ls-tree`/`git show`;
  the control at `8cc3717c8` reproduces backend 113,538 / 147,443. Now:
  backend 119,096 / 158,650 (+4.9 % / +7.6 %); frontend 75,800 / 81,996
  (+5.7 % / +11.0 %); sdk 19,149 / 21,941; qa-agent 15,073 / 13,145;
  mcp-server 13,332 / 24,389; core tests 669 → 945; the rest within a few
  percent of 10-21.
- block 1 (guard falsifiability) → examined. The census script → 23
  candidate test files over 3 of the last 20 landings (all money-path); the
  first five are one landing's. Five census mutations, by the mutants' JSON
  reports → **4 caught** (CHECK widened, 2 red of 6; Agent schema range, 3 of
  29; analytics golden count, 1 of 8; analytics spec item, 1 of 38) and **1
  shadowed** (supersession dropped from the held predicate; diagnosis: not
  load-bearing at the tested condition). The runner's own table read 1 caught
  (C1). Two probes → the dashboard twin of the schema guard, **shadowed**
  (a sibling test red), 1 of 15; a count-only restore pin, **not run to a class**,
  refused twice by the harness's drift guard. Census files exercised: 5 of 23.
- block 2 (`covers:` completeness) → examined. The reference loop under bash
  with `set -f`, each miss confirmed with the strict gate → 17 across 6 of 8
  (10-21: 18; the CASP guardrails doc 6 → 5); 2 raw misses were glob
  strings. `npm run docs:covers-gaps` → 124 pairs / 33 docs (10-21: 129 / 35).
- block 3 (stale numbers) → partial. Positive control 3 / 3. The 25 newest
  shards → 7 figure lines, 0 with a command (10-21: 9 / 0). One shard figure
  re-derived and matching (0 of 12 files at a PR head). `any` 38 → 39 (one
  code line in a test helper). db-mock gauge 54 / 270 / 57 (unchanged).
  Guard scripts 71 → 75, self-tests 74 → 75; non-spawning not re-derived.
  Zod 0.
- block 4 (retired vocabulary) → examined. Positive control 36 shards. 196
  files, 47 historical / 149 live (10-21: 196 / 46 / 150; the 10-21 report
  added, a settings component removed). Ratchet green, 32 / 30 (10-21: 30 /
  28), below baseline. Code half unchanged.
- block 5 (merge-method drift) → examined. Since 2026-10-21T00:00:00Z → 0
  merge-commit / 139 squash (clean); the window 0 / 135. Since
  2026-08-10T00:00:00Z → 282 / 1,345 of 1,630.
- block 6 (nets with holes) → examined, all four halves → copy lint 64
  unscanned / 4 with hits (10-21: 60 / 4); money perimeter 32 / 20
  (unchanged); visual gate 15 of 27 (10-21: 16 of 28; one route merged away);
  docs boundary 43 (10-21: 41; the runner's skill and command); freshness-gate
  exit branches unchanged. Probes beyond the reference: the repo-config
  self-tests under a hostile host environment (1778 / 1778 both ways); the
  egress census; the advisory-check merge census.
- incident clustering → examined. Issues created since 2026-10-21T00:00:00Z
  → 119 (10 open / 109 closed). By a title regex, then by hand: product UI
  epics 62, test tooling 14, documentation drift 13, egress 5, catalog 5,
  signer / x402 4, the 10-21 candidates 3, agent evals 2, other 11. One
  deploy incident: a comment stripper importing typescript was put in the
  core barrel and crashed hosted-MCP dev deploys; it was fixed and then
  guarded.
- workflow archaeology → examined. `ci.yml` newest 100 → 73 / 14 / 13; 7
  with attempt > 1, all on feature branches. `dev` 35 → 29 / 2 / 4, both
  reds the one browser-smoke test. Failed jobs: browser smoke 7, visual
  regression 7, lint/type/build 2, repo config 1, SDK 1. qa-dev at the
  `money-flow` job level: 615 runs since 2026-10-21 → 77 success, 3 failure,
  535 skipped. The 3 failures are the tail of the 10-21 C1 red, before its
  fix. The 77 green jobs' logs → 77 passed on attempt 1/2, 0 on 2/2, no leg
  FAIL lines (control: a failed job shows 4).
- comment archaeology → TODO / FIXME / HACK / XXX → 0 (control `import` →
  2,175 files). The egress rule is the repeated warning (notes).
- live exercise → not taken by this agent. Runtime identity for the
  captain's calls is recorded above; the observations are #4449's.
- SKILL step 3's unnumbered probes → fat controllers: not examined.
  Data-layer coverage: not examined as a census (db-mock gauge re-read).
  Validation and contract enforcement: partial (three spec-shape guards
  mutated). Cross-package duplication: not examined.
- Novelty: the tracker was searched per item; the ledger and bug reports
  were grepped for each item's terms. Bug-report bodies were not otherwise
  re-read.

Instrument lessons: the mutation runner's census table is its own class, so
read each mutant's report before quoting caught counts. A migration-file
mutation needs the worker schemas dropped around it. `git grep -E` with `\b`
silently matched nothing where `-P` found 39 files. `rg` resolves only in the
harness's zsh. The census sample can be all one landing.

**Disposition: pending owner decision** (C1).

**Disposition (owner, 2026-10-26): file C1, merge the scan PR.** The owner's
answer in the captain's session was "ja fila c1 och merga scan-pr:en". The
scan PR #4454 merged as `d270642c7`.

- C1 → [#4456](https://github.com/d-hinders/Haven-AI/issues/4456)
  (`area:ci`). The mutation runner reads vitest's resolved-promise
  `.rejects` and the backend's two OpenAPI test helpers as assertions (a
  runner stem, or the helpers throwing `AssertionError`; the builder
  chooses), with recorded fixtures and counter-cases. The spec review added the
  helpers' twin, a guard against a stem broad enough to catch
  `.resolves`-rejected (which stays an error on purpose), and the rule's
  docblock copy. Verdict: 9 corrections, no owner question. `pending-review`
  is lifted; the issue is filed to the backlog (no `code-quality`).

## 2026-10-26 (run B) — whole repo, weighted to the landings since 2026-10-21 (owner invocation 2026-10-26, no scope named; a second run of the same day beside run A)

Full report: [`docs/bug-reports/quality-scan-2026-10-26-whole-repo-b.md`](../bug-reports/quality-scan-2026-10-26-whole-repo-b.md).
The report holds the file:line evidence; this entry stays path-free. Measured
on `origin/dev` @ `b9f9f1e47` by the captain in the main checkout for the
read-only counts (one re-taken in a pinned worktree, below), one read-only
worker for the GitHub reads, and the block-1 census through the new mutation
runner in a detached, `npm ci`'d worktree at the scan SHA with core, the SDK
and the signer built, against a disposable database dropped at the end. One
cell the runner cannot drive ran as a hand rig behind a `cp` backup, restored
and proven with `cmp` and `git diff --quiet`. The window is
`8cc3717c8..b9f9f1e47` → 135 first-parent landings (the 2026-10-21 entry
covered `595b43c07..8cc3717c8`). GitHub was read-only. No live call was
made. The worktree ended clean with no runner journal.

**A concurrent run.** Run A (PR #4454, pushed 2026-10-26T20:21Z while this
run was being written) measured the same SHA and window independently; its
entry is the one above this when both have merged. Every re-measured figure
agrees between the two once one reading here was re-taken in a clean
worktree. Three first-draft claims of this run were corrected against run A's
evidence and re-verified (the three 2026-10-21 issues are closed; the
`dev` smoke red was fixed by a landing, not a flicker; a bare-fetch allowlist
would not have caught the window's egress incidents), and one drafted
candidate is run A's C1, cited as tracked. This entry carries the two
candidates run A does not.

**Excluded this run:** every prior finding and candidate, whatever its
disposition, including the 2026-10-21 candidates (#4215, #4216, #4217, all
`shipped`) and that entry's refusal of the "tests depend on the machine"
pattern, which this window's ten host- or load-dependent test issues would
otherwise re-raise. None is re-surfaced. C1 sits beside the 2026-10-03 S1
(epic #3615, `shipped`): a refusal reason added after the epic closed,
spelled through the shared builder at one of its three sites; the S1 figure
(9 typed-code sites) now reads 3, so the epic held and C1 is a candidate, not
a re-surface. None of the re-measured figures worsened materially.

**Structural findings:** none in the examined sample. Six recurring
mechanisms in the window's 172 issues; four untracked by any one issue, each
with a one-PR remedy or a standing refusal, none with a census that would
make it splittable work. The two largest verbatim copies in the tree are both
parity-pinned and not proposed.

**Improvement candidates (one PR each), pending owner decision:**
- C1 — the x402 legs answer an expired-only budget (the #4352 refusal, landed
  2026-10-25) with a prose-only 403 — `error` text, no `error_code`, no
  `next_action`, no `budget_ended_at` — while the hosted pre-check answers
  the typed body from the shared builder. The builder has 1 caller; 2 inline
  expired bodies sit in the x402 authorize module, whose 7 403 sites read
  as 3 typed (task budget, period exceeded on both legs) and 4 prose-only
  (the two expired bodies and the two no-delegation bodies they were shaped
  to match). By execution: misnaming the builder's reason reddens the
  pre-check's suite 3 of 45 and leaves the x402 suite 119 of 119 green
  (block-1 probes M6 / M7). No non-test client code reads
  `delegation_expired` — the hosted pre-check handler and the error
  normaliser branch on `delegation_budget_exceeded` alone — so the typed
  body is unconsumed where it exists and absent where it does not: the
  2026-09-21 D2 class, a refusal with nothing machine-readable to branch on.
  No incident recorded. Money-path by file. *Corrected in review:* first
  written as "the direct route", "5 of 7 typed" (a count of ledger `detail`
  objects) and "the clients branch on it".
- C2 — the weekly docs staleness audit ranks dated records: it excludes only
  `archived` and `research`, every one of the 18 bug reports is
  `status: current` with `covers:`, 10 of the 15 docs in the 2026-10-26
  audit issue are bug reports (ranked by commits since `last-verified`, so a
  record's write-day date carries it high whatever its width — the scan
  reports declare 8–42 paths; the issue's rank 1 is a dated retrospective
  outside the folder), and the
  landing that closed it appended +425 of its +536 lines as re-check
  sections to dated reports (the previous audit: 3 of 9 files; 11 weekly
  audit issues since 2026-07-20). The script's own #2638 comment states the
  principle for `research`. One PR; the owner picks the mechanism (a folder
  rule, which would keep ranking the retrospective, or a `record` status)
  and whether the reports keep `covers:`. *Corrected in review:* first
  written as "the widest `covers:` in the tree" and "13 audits".
- Notes, not proposed: the egress perimeter (5 bare fetch sites in 3
  backend files outside the SSRF seam, fixed or operator-configured hosts,
  none caller-influenced; 0
  tests enumerate fetch sites; a by-file allowlist ratchet was drafted and
  withdrawn on run A's reasoning that both of the window's backend
  incidents were URL-source changes at existing sites); three block-1
  survivors on the #4429 display-only colour column (dropped from the
  single-agent read: 29 / 29 green in the mocked route suite and 39 / 39 in
  the real-DB repository sibling; dropped from the analytics select: 8 / 8,
  stripped by design; a constant tint on the analytics route: 38 / 38 — run
  A's out-of-range mutations of the same three files were each caught by the
  spec round trip, so the field is pinned by the spec's range alone; the
  2026-09-15 mock-families shape, `accepted-as-debt`); one mobile e2e spec
  is all 7 of the window's 7 browser-smoke failures, both `dev` reds among
  them and two merged PRs, red from its own merge until the PageHeader fix
  landed eleven and a half hours later (advisory on `dev` by the recorded
  decision; run A counts 9 of 134 landings merged over a red advisory
  check); a source-reading guard census that is not an instrument (a
  hand-written comment skipper defeats it, and the one probe came back
  clean); the 21-copy #1464 call-site comment (reading cost, bar 3); agent
  evals 2 / 12 / 4 over 18 runs (tracked under the closed epic #3957's fix
  wave). The runner's `.rejects` misclassification, reproduced here on cell
  M1, is run A's C1 and is decided there.

**Dispositions observed (upkeep):** 2026-10-21 C1 → #4215 closed 2026-10-25
after its operator check (build PR #4222, 2026-10-21, `Refs`) → `shipped`;
C2 → #4216 closed 2026-10-21 via PR #4223 → `shipped`; C3 → #4217 closed
2026-10-21 via PR #4230 → `shipped`. (Run A records the same three.)

**Probed clean** (block → examined / partial / not examined → command → number, all at `b9f9f1e47`; parentheses are the 10-21 entry at `8cc3717c8`):
- sizing → examined → the 09-22 command pinned with `git ls-tree`/`git show`;
  the control at `8cc3717c8` reproduces backend 113,538 / 147,443 and
  frontend 71,713 / 73,900. Now: backend 119,096 / 158,650 (+4.9 % /
  +7.6 %); frontend 75,800 / 81,996 (+5.7 % / +11.0 %); sdk 19,149 / 21,941;
  core 25,740 / 945; qa-agent 15,073 / 13,145; mcp-server 13,332 / 24,389;
  signer 5,422 / 8,788; connect 12,436 / 15,676; cli 3,207 / 3,609; ops
  3,143 / 2,222; ui 2,574 / 2,023; mcp 2,817 / 5,038; demo-merchant-mcp
  3,788 / 4,210. Fat controllers: examined as a census only (largest route
  file 1,561 lines), no finding.
- block 1 (guard falsifiability) → examined. The census script → 23
  candidate test files over 3 of the last 20 landings; the runner took the
  first five, all from the avatar-tint landing. 5 census cells + 2 probes →
  runner line "1 caught, 4 survived, 0 shadowed, 1 mutation-red, 0 refused,
  1 not run"; read with two corrections: **3 caught** (M1 by its message —
  the runner's `.rejects` gap, run A's C1; M2 by the hand rig, 2 red of 14
  on a fresh database, since the real-DB harness memoises applied
  migrations and the runner's baseline installs the unmutated function; M6,
  3 of 45), **4 survived with diagnoses** (M3 weak test at both layers, M4
  not load-bearing by design, M5 weak test, M7 not load-bearing → C1).
  Census files exercised 5 of 23, plus 2 probe files and 1 sibling; 18 of 23
  not exercised (budget). Run A took the same five files with different
  edits (4 caught, 1 shadowed) and reaches the same reading of them.
- block 2 (`covers:` completeness) → examined. The reference loop under bash
  with `set -f`, each miss confirmed with the strict gate → **17 across 6 of
  8** (18 across 6 of 8); the runtime-compatibility contract 0. `npm run
  docs:covers-gaps` → **124 pairs / 33 docs** (129 / 35). Run A: the same.
- block 3 (stale numbers) → partial. Positive control 3 / 3. The 25 newest
  shards → **7 figure lines, 0 with a command** (9 / 0); 3 of the 7 are
  measured figures. `any` **39** (38); db-mock gauge **54 / 270 / 57**
  (unchanged); guard scripts **75** (71); non-spawning self-tests **25 of
  75** (25 of 74); zod 0. One stale comment found by execution (M4). *First
  reading corrected:* the shard sample read 0 under an unexpanded zsh
  variable; the figure above is the corrected run. Run A: the same 7 / 0.
- block 4 (retired vocabulary) → examined. Positive control 36 shards. **196
  files, 47 historical / 149 live** (196 / 46 / 150). Ratchet green, **32 /
  30** at the scan SHA in a pinned worktree and with the report present
  (30 / 28 — within the ceiling, not re-measured per file); the first
  reading in the shared main checkout was 34 / 31, the 2 extra hits from a
  gitignored build-generated doc copy under the frontend's public folder
  (instrument lesson). Code half unchanged. Run A: the same 196 / 47 / 149
  and 32 / 30.
- block 5 (merge-method drift) → examined. Since 2026-10-19T00:00:00Z → **0
  merge-commit / 213 squash** (clean); the window 0 / 135. Since
  2026-08-10T00:00:00Z → 282 / 1,345 of 1,630. Run A: the same.
- block 6 (nets with holes) → examined, all four halves → copy lint **64
  unscanned / 4 with hits** (60 / 4); money perimeter **32 / 20**
  (unchanged); visual gate **15 of 27** (16 of 28); docs boundary **43**
  (41; the prove-red skill and command); freshness-gate exit branches
  unchanged. Probes beyond the reference: the advisory-check merge census
  (2 merged PRs with a red smoke job at merge in the two date slices that
  answered; the third slice answered HTTP 504 twice and was read per PR; run
  A's full read 9 of 134) and the classifier routing the staleness audit to
  no surface (C2; its own workflow's path filter still runs it). Run A: the
  same four halves.
- incident clustering → examined. Issues created since 2026-10-19T00:00:00Z
  → **172 (161 closed / 11 open)** (run A, from 10-21: 119 / 10 open); by
  mechanism: outbound fetch outside the seam 5, agent-facing text asserting
  a false state 6, host- or load-dependent test reds 10 (refused 10-21),
  source-parsing guards 8, catalog ingestion 7, docs drift 12 (C2), EIP-3009
  settlement 10 (epic #4318), agent evals 9 (epic #3957). Open PRs 0 at the
  worker's read (run A's PR opened after it); open issues 18; `code-quality`
  on 2 of the 172.
- workflow archaeology → examined. `ci.yml` newest 100 → **72 / 14 / 13**
  (1 in progress; run A minutes later 73 / 14 / 13); 7 with attempt > 1, all
  feature branches; `dev` 34 → 28 / 2 / 4, both failures the one smoke spec.
  Failing jobs: browser smoke 7, visual regression 7, lint-type-build 2, SDK
  1, CI-config 1. qa-dev at the `money-flow` job level: newest 30 runs → ran
  in **6 (6 success, all on attempt 1/2, 17 legs PASS)**, gate-skipped in
  24; scheduled 10-19 → 10-26 → 7 success / 1 failure (10-21, the #4215
  check). Agent evals → 18 runs, 2 / 12 / 4.
- comment archaeology → TODO / FIXME / HACK / XXX → **0** (control `import`
  → 2,175 files); most-repeated non-lint comment 21 copies (notes).
- cross-package duplication → examined as a census (10-line normalised
  windows over 1,216 non-test files) → 52 file pairs, 11 cross-package; the
  two largest (431 and 48 windows) are parity-pinned copies; not proposed.
- validation and contract enforcement → partial (the enforce list read; no
  shadow-residue census). Data-layer coverage → not examined beyond the
  db-mock gauge. Live exercise → not taken.
- Novelty: the tracker was searched per candidate; the ledger and bug
  reports were grepped for each candidate's terms; run A's report and entry
  were read in full for overlap. Bug-report bodies were not otherwise re-read.

Instrument lessons: a filesystem-walking gauge must run in a pinned worktree,
not the shared main checkout (34 / 31 there, 32 / 30 clean, `git status`
empty — a gitignored generated doc copy under a package's public folder is
the difference); a migration-body mutation whose test goes through the memoising
harness needs a test that re-applies the migration itself, or a fresh
database per run; a failed `.rejects` expectation reads as mutation-red (run
A's C1); `${=S}` in zsh for a newline list; `statusCheckRollup` over ~200
merged PRs answers HTTP 504 — slice by `merged:` date; job logs need
`--allow-escape-sequences`; the dimensions reference changed under the scan
when the checkout moved — re-read it; two scans of one day collide on the
report path and the ledger's append point — read the other first and
reconcile item by item.

**Disposition: pending owner decision** (C1, C2).

**Disposition (owner, 2026-10-26): file C1 and C2; merge the scan PR.** The
owner answered in the captain's session: file both through new-task; for C2
use a `status: record` front-matter value rather than a folder rule, and keep
the reports' `covers:` for now; for C1, the two no-delegation x402 403s that
share the prose-only shape stay as they are (expired bodies only). The scan PR
#4455 merged as `01551ec84`.

- C1 → [#4458](https://github.com/d-hinders/Haven-AI/issues/4458)
  (`money-path`, `area:backend`, `area:mcp`, `area:sdk`, `area:docs`),
  filed as slice 5 of epic #4349 (sub-issue and build-order line added). Its
  spec review re-ran 27 claims, 24 reproduced, 3 wrong and fixed; 12
  corrections, among them a third hosted reader the scan had not named (the
  catalog prepare preflight decides a budget refusal on the same single
  `error_code`), the funding leg's `merchant_address` pinned to the merchant
  address, and the hosted criterion moved to the agent-visible warning and
  next-step text. No owner question open; `pending-review` lifted.
- C2 → [#4459](https://github.com/d-hinders/Haven-AI/issues/4459)
  (`area:docs`, `area:ci`, `money-path` by file — the front-matter
  validator is a control glob, #2200). Its spec review re-ran 24 claims, 22
  reproduced, 2 wrong and fixed; 11 corrections, among them: the run-report
  template stays `current` and the four report writers set `record` on the
  copy; eight vocabulary copies in comments and prose join the scope; the
  audit's self-test must drive the real CLI with a positive control; a
  record-disposition rule for the doc-reviewer (never append a re-check,
  never bump the date) joins the contract doc. No owner question open;
  `pending-review` lifted.
- Notes: not filed. The runner's `.rejects` misclassification is run A's C1,
  decided in that entry's disposition.

Drive: `ship-next epic=#4349` (C1 is its only open slice), `ship-next 4459`.

---

## 2026-10-30 — whole repo, weighted to the landings since 2026-10-26

Full report: `docs/bug-reports/quality-scan-2026-10-30-whole-repo.md`.
Measured on frozen `origin/dev` @ `99ef8d063`; window
`b9f9f1e47..99ef8d063` → **51** first-parent landings / 438 changed files /
+22,263 −2,230 lines. Two isolated read-only worktrees took the repository and
GitHub/history samples. No live call, mutation, database suite or browser run.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. None materially worsened in the re-measured dimensions.

**Structural findings:** none in the examined sample.

**Improvement candidates (one PR each), pending owner decision:**

- **C1 — block 2's contract-doc selector reads a body example as front
  matter.** Exact selector: 8 documents / 19 raw misses; actual front-matter
  sample: 7 documents / 15 literal misses across 5, equal at the prior scan
  SHA. The 2026-10-26 entries' "17 across 6 of 8" (18 across 6 of 8 in the
  2026-09-25 to 10-21 entries) is these 15 plus the false document's two
  real-path misses. One shared selector plus a
  body-example counter-control. Routing `(none)`, off money-path.
- **C2 — accounting purchase parents and public payment ids use different UUID
  domains.** `parent_payment_id` stores the purchase evidence/receipt id while
  the feed's `paymentId` is the intent id. PR #4544 records that joining the
  two misses. Decide intent id versus an explicit receipt-domain name.
  Routing `code backend`; `mpp/evidence.ts`, `mpp/purchase-group.ts` and
  `infra/repositories/machine-payments.ts` are **money-path**, `entry.ts` off.
- **C3 — a direct payment is classified as an unknown merchant.** The new
  direct-feed branch supplies none of the classifier's route/document signals
  (its MCP tool name is selected but null in practice), so execution returns
  `unknown / none` and “Unknown merchant (unclassified)” although the closed
  enum includes `transfer`. PR #4546 records the residual.
- **C4 — the served receipt schema omits a live field the SDK consumes.**
  `delivery_reference` is emitted by the backend and mapped by the SDK but
  absent from the OpenAPI `MachinePaymentReceipt` and generated core type;
  `additionalProperties: true` hides the gap. PR #4479 records the follow-up.
- **C5 — two sibling PR gates retain the concurrency group proven to create
  empty suites.** PR ownership and Baseline change still use a per-PR group
  (with `cancel-in-progress: true`) on `pull_request_target`, bursting through
  `opened` + `edited` rather than labels. The group alone cancels pending runs
  (#4524 *Verified* 3), so the remedy is removing it or `queue: max`. PR #4526
  names both as planned follow-up; #4524's operator verify (probe PR #4528)
  recorded the 5/5 burst after the fix. PR ownership gate is the pending 17th
  required context on `dev`.

**Probed clean** (block → coverage → command → result, at `99ef8d063`;
parentheses are the 2026-10-26 entry at `b9f9f1e47`):

- sizing → examined → the 09-22 command pinned with `git ls-tree`/`git show`
  → backend 120,895 / 160,644 (119,096 / 158,650); frontend 77,394 / 84,225
  (75,800 / 81,996); sdk 19,621 / 22,603; core 25,730 / 985 (24,096
  generated); qa-agent 15,133 / 13,283; mcp-server 14,114 / 25,456; signer
  5,564 / 9,363; connect 12,436 / 15,676; cli 3,207 / 3,609; ops 3,143 /
  2,222; ui 2,603 / 2,057; mcp 2,817 / 5,038; demo-merchant-mcp 3,788 /
  4,210. Fat controllers: census only → 50 route files, 4 ≥ 1,000 lines,
  `grep -oE '\b(app|ownerApp)\.(get|post|put|patch|delete|route)\b'` → 212
  registrations; largest route file payments 1,572 lines (1,561). No
  material structural delta.
- block 1 → not examined → no dependencies/mutation run under this bounded
  four-day scan.
- block 2 → examined → 8 / 19 raw, corrected 7 documents / 15 literal gaps
  across 5 (C1); coupling baseline green, 124 pairs / 33 docs.
- block 3 → partial → positive control 3/3; the reference's two `rg` lines
  over the 25 newest shards (`2026-10-25-4372` … `2026-10-30-4552`) → **16
  figure lines, 2 with a command** (7 / 0); 12 of the 16 are measured
  figures, 7 of those on or directly under the two commanded release-shard
  lines. *First reading corrected in review:* 7/0 was the `b9f9f1e47`
  sample. `any` 39 (39); DB mocks 54 / 270 / 57 (unchanged).
- block 4 → examined → positive control 36; 196 files, 47 historical / 149
  live; prose ratchet green 32 / 30; unchanged.
- block 5 → examined → since 2026-08-10: 282 merge / 1,396 squash / 1,681
  total; merge count unchanged, current window squash-only.
- block 6 → examined, all four halves → copy lint **66 unscanned / 4 with
  hits** (64 / 4; script unchanged, +2 new files `frontend/src/lib/agent-facet.ts`
  and `sdk/src/test-support/low-s.ts`); money perimeter 32 / 20, visual gate
  15 of 27, docs boundary 43 (all unchanged).
- block 8 → not examined → requires builds, Postgres and backend recording.
- block 9 → not examined → shares block 8's recording prerequisite.
- incident clustering → examined → 81 issues created since 2026-10-26, 25
  open / 56 closed; large clusters already tracked.
- workflow archaeology → examined → newest 100 CI runs 82 success / 11
  cancelled / 7 failed, no sampled `dev` failure; five sampled QA money-flow
  jobs passed every leg on attempt 1/2.
- comment archaeology → examined → 0 TODO/FIXME/HACK/XXX package-source hits;
  positive control `import` 2,204 files.
- cross-package duplication / validation / data-layer coverage → partial;
  live exercise → not examined.
- novelty → the full ledger, `docs/bug-reports/`, open GitHub issues and the
  source PRs (#4544, #4546, #4479, #4526) and issue #4524; none of C1–C5 is
  a prior ledger item or has an open issue.

**Review:** `haven-reviewer` at `7141367` re-derived every local figure; no
blocking, four should-fix (block 3 reading, the 257-registration figure, the
missing *Verified at scan* field, block 6 "all unchanged"), six nits. All
applied in place; corrected figures are marked above and in the report's §5.

**Disposition: pending owner decision** (C1–C5).

**Disposition (owner, 2026-10-30): file all five; C2 as the rename, C5 as
removing the group.** The owner answered in the captain's session. C2: name the
parent field for what it holds (a receipt id) additively, and keep storing the
evidence id. C5: remove the two gates' concurrency group, as #4526 did. Every
issue went through new-task with an independent spec review; none has an open
owner question, and `pending-review` is lifted on all five. The scan PR is
#4575, merged before this disposition (stacked PR #4581).

- C1 → [#4576](https://github.com/d-hinders/Haven-AI/issues/4576)
  (`area:docs`). Spec review re-ran 11 claims: 9 reproduced, 2 wrong and
  fixed; 9 corrections. One wrong claim was also in this entry and the report:
  the ledger's block-2 series is 18 across 6 of 8 from 2026-09-25 to 10-21
  (09-22: 17 across 5), and 17 across 6 of 8 only in the 2026-10-26 entries.
  It was corrected in place on #4575 before merge (its first correction also
  misdated the start as 10-03; the review of #4581 caught that). Among the other corrections: a fixture-based
  counter-control, the `set -f` constraint on the selector, and a stated
  17 → 15 series conversion.
- C2 → [#4577](https://github.com/d-hinders/Haven-AI/issues/4577)
  (`money-path`, `area:backend`, `area:sdk`, `area:docs`). Spec review re-ran
  15 claims: 14 reproduced, 1 wrong and fixed (`FeedTransaction` is internal,
  so only the receipts API/SDK and the PDF are public; the internal types are
  renamed in place, no alias); 12 corrections. Among them: `Receipt ref` only
  on protocol underlags, a line-array (not byte) identity probe, SDK mapper
  tests, ten live comment copies, and the Accounted re-file risk stated and
  accepted.
- C3 → [#4578](https://github.com/d-hinders/Haven-AI/issues/4578)
  (`area:backend`, `area:docs`). Spec review re-ran 12 claims: 11 reproduced,
  1 wrong and fixed; 10 corrections. Among them: a CASP shard joins the scope;
  the label is the canonical address only (contact names are out, since they
  would change Fortnox's supplier); exact-string pins; prose copies of the
  rung list.
- C4 → [#4579](https://github.com/d-hinders/Haven-AI/issues/4579)
  (`area:backend`, `area:sdk`, `area:docs`). Spec review found one blocking
  issue: **six** emitted receipt keys are undeclared, not one (39 emitted /
  33 declared). The scope now declares all six behind an empty-allowlist
  guard, and the title is updated. 11 claims re-run, 10 reproduced, 1 wrong
  and fixed; 8 corrections.
- C5 → [#4580](https://github.com/d-hinders/Haven-AI/issues/4580)
  (`area:ci`). Spec review re-ran 12 claims: 9 reproduced, 3 wrong or
  incomplete and fixed; 9 corrections. Among them: re-run-the-newest wording,
  the no-`if:` pin, the payload-safety argument with a `types:` pin, a
  re-anchored permissions slice, and an operator-verify instrument.

Drive: `ship-next 4576`, `ship-next 4577`, `ship-next 4578`, `ship-next 4579`,
`ship-next 4580`. C2 and C4 both edit `MachinePaymentReceipt`; whichever lands
second regenerates `api-types.ts`.

## 2026-11-02 — whole repo, weighted to the landings since 2026-10-30

Full report: `docs/bug-reports/quality-scan-2026-11-02-whole-repo.md` (it
carries the file:line evidence; this entry stays path-free). Measured on
`origin/dev` @ `e0617aa9f` by one agent in the main checkout (the branch tip
equals `origin/dev`, no linked worktree), `npm ci`'d under Node 24 with core,
the SDK, the signer and the hosted MCP built; the clone arrived shallow and was
unshallowed before any history figure. The window is `99ef8d063..e0617aa9f` →
**24** first-parent landings / 334 files / +11,033 −3,385. Blocks 8 and 9
recorded the backend suite against a disposable local Postgres 16 database;
the block-1 census ran through the repo's mutation runner, which restored and
verified each file. One read-only worker took the GitHub Actions reads. GitHub
was read-only. No live Haven, MCP, dev or production call was made.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. None is re-surfaced and none of the re-measured figures worsened
materially. C1 sits beside the retired block 7 and the 2026-10-26 run B's C2
(#4459, `shipped`): that candidate took dated records out of the audit's
ranking and forbade re-check sections on them; C1 is the same growth on the
docs the audit still ranks, which no prior entry measured.

**Structural findings:** none in the examined sample. The window is one
tracked frontend epic (13 slices, 4 walkthrough rounds) plus the builds of the
2026-10-30 candidates.

**Improvement candidates (one PR each), pending owner decision:**
- C1 — the weekly docs audit regrows the retired `last-verified` chain as body
  prose on the docs it still ranks. #2681 (2026-09-07) retired the per-doc
  chain — "a plain `last-verified: <date>` and nothing else", because "prose
  to prove prose was checked" had reached 20 % of governed prose — and #2775
  archived it verbatim. Since the second audit after that (2026-09-21; the
  first added none), audit closings append a dated `Re-verified …` paragraph
  to docs they re-verified, and the #4372 re-verify epic adopted the shape: at
  the scan SHA **69 paragraphs in 30 non-archive docs** (65 in 28
  `status: current` docs, 4 in 2 records), 68,773 bytes in the current docs;
  by the wider shape (heading, bold, blockquote or bare opener) 92 openers in
  42 docs (73 in 28 current, 19 in 14 records). Control: 0 at the parent of
  the first landing that added the shape, 9 at it; 22 landings added one (3 in
  September, 18 in October, 1 in November) — 40 from 9 weekly-audit closings,
  23 from 8 #4372 parts, 6 from 5 unrelated landings. The architecture
  overview is 35 % re-verification prose by bytes (7,533 of 21,626). Cost on
  record: #2938 (2026-09-13), a re-verification blockquote in a served doc
  carried a literal `covers:` and turned the required *Frontend checks* red
  queue-wide; the guard that failed then still reads served bodies, and one of
  the four docs served to agents carries one such paragraph today (1,573
  bytes). Nothing requires the shape: the audit issue asks only for a
  re-verify and a date bump; the release skill's items 2 and 3 are the only
  instructions that ask for a scoped *Re-verified* note. One PR: a guard
  beside the front-matter validator refusing the wide shape in a
  `status: current` body (with fixture controls; records left as written per
  #4459), the rule stated once, and the 73 current-doc notes moved verbatim to
  the #2775 archive or deleted — the owner's call; two PRs if the migration
  goes apart. *Corrected in review:* first written as "the first audit after",
  "each audit … every doc", "the 69 paragraphs" and "step 3". Off the
  money path, except that a guard placed inside the validator itself lands on
  a control glob (#2200).
- C2 — block 6's copy-lint perimeter command cannot see the SDK's top-level
  files. Its `git ls-files '…/src/**/*.ts'` globs need a separator after `**`,
  so `grep -cE '^packages/sdk/src/[^/]+\.ts$'` over the reference's list → 0
  against 46 non-test files at the SHA (and the frontend's `middleware.ts`).
  The figure nine prior entries quote (**66 unscanned / 4 with hits** today,
  72 / 5 at `893d74f6`, when that level held 26 files) becomes **111 / 14**
  over a `git ls-tree` list
  with the same exclusions; the 10 newly visible hit files carry 16 hits, 6 in
  agent-facing strings (two tool descriptions, three refusal texts, one
  next-step message) and 10 in JSDoc, the documented false-positive class. The
  lint's own `SCAN_FILES` names two files at that level, so the level is
  inside the lint's content class by its own allowlist. Same instrument class
  as the 2026-10-30 C1 (#4576). One PR to the dimensions reference: a pinned
  `ls-tree` listing, a re-baseline at 111 / 14 with the split, and a non-zero
  control line; whether the six strings join `SCAN_FILES` is the lint's
  decision under #2317, not part of this PR unless the owner says so. Routing
  `(none)`, off the money path.
- Notes, not proposed: block 8 prints three unmarked typed codes on agent
  payment routes (`rail_not_supported` 422, `budget_requires_recipient` 409,
  `balance_changed` 409) and 8 rows (5 codes) on the two x402 context reads —
  named so
  the next run can tell new from baseline, since the 2026-10-27 baseline
  counted its 13 payment-route codes without naming them; four dialogs
  outside the shared Modal still set `role="dialog"` after the epic's
  bespoke-dialog slice (no cost evidence; the epic's walkthrough rounds are
  deciding them); two backend files are environment-red in this container
  (the enforcer probe's RPC denied by the proxy, an IPv6 loopback listen).

**Dispositions observed (upkeep):** 2026-10-26 A C1 → #4456 closed
2026-10-26 via PR #4463 → `shipped`. 2026-10-26 B C1 → #4458 closed
2026-10-26 via PR #4465 → `shipped`; C2 → #4459 closed 2026-10-26 via PR #4464
(`807e6d5c1`) → `shipped`. 2026-10-30 C1 → #4576 closed 2026-10-30 after PR
#4584 (`a254800`, `Refs`; `landed-partial`, a label #4458 and #4459 carry
too) → `shipped`; C2 → #4577 via PR
#4583 (`69d5f98`) → `shipped`; C3 → #4578 via PR #4585 (`c787bd3`) →
`shipped`; C4 → #4579 via PR #4587 (`1406e9c`) → `shipped`; C5 → #4580 open,
built by PR #4582 (`f11274a`, `Refs`), its operator-verify burst outstanding.

**Probed clean** (block → examined / partial / not examined → command → number, all at `e0617aa9f`; parentheses are the 2026-10-30 entry at `99ef8d063`):
- sizing → examined → the 09-22 command pinned with `git ls-tree`/`git show`
  → backend 121,063 / 160,892 (120,895 / 160,644); frontend 78,593 / 86,898
  (77,394 / 84,225); sdk 19,642 / 22,647; core 25,754 / 985; qa-agent 15,133 /
  13,283; mcp-server 14,114 / 25,456; signer 5,564 / 9,363; connect 12,436 /
  15,676; cli 3,207 / 3,609; ops 3,143 / 2,222; ui 2,822 / 2,328; mcp 2,817 /
  5,038; demo-merchant-mcp 3,788 / 4,210. Fat controllers: census only → 50
  route files, 4 ≥ 1,000 lines, 212 registrations, largest 1,572 (unchanged).
- block 1 (guard falsifiability) → examined → the census script → **1**
  candidate file over 1 of the last 20 landings; runner: 1 census mutation +
  2 probes → **3 caught**, 0 survived, 0 shadowed, 0 mutation-red (an
  undeclared emitted receipt key, 2 red of 65; the deprecated parent alias
  emitting null, 1 of 7 on the real database — pinned only there; a
  count-preserving skeleton swap, 1 of 23 — the pin reads the column, so it
  is not count-only). The first cells file was refused whole (family `other`
  is not a census family); nothing was mutated by it.
- block 2 (`covers:` completeness) → examined → front-matter selector, both
  fixture controls pass → 7 contract docs; the loop under bash with `set -f`,
  each miss confirmed with the strict gate → **15 across 5 of 7**
  (unchanged); `npm run docs:covers-gaps` → 124 pairs / 33 docs (unchanged).
- block 3 (stale numbers) → partial → positive control 3 / 3; the 25 newest
  shards (`2026-10-26-4429` … `2026-11-02-4601`) → **13 figure lines, 2 with a
  command** (16 / 2); `any` 39 (39); db-mock gauge 54 / 270 / 57 (unchanged);
  zod 0; guard scripts 78 (75 on 10-26); non-spawning self-tests 25 of 78.
- block 4 (retired vocabulary) → examined → positive control 36 shards; 196
  files, 47 historical / 149 live (unchanged); ratchet green 32 / 30; code
  half unchanged.
- block 5 (merge-method drift) → examined → since 2026-08-10T00:00:00Z →
  **282 merge-commit / 1,420 squash / 1,705** (282 / 1,396 / 1,681); since
  2026-10-30T00:00:00Z → 0 / 29 / 29; the window 0 / 24. *First reading
  corrected:* the shallow clone read 0 / 50 / 50.
- block 6 (nets with holes) → examined, all four halves → copy lint **66 / 4**
  by the reference command (unchanged; corrected 111 / 14 is C2); money
  perimeter 32 / 20; visual gate 15 of 27; docs boundary 43; freshness-gate
  exit branches unchanged (all unchanged).
- block 8 (refusal census) → examined → 549 files, 547 green, 2 environment
  reds, 6,921 tests, 472 s; **2,203 rows; 1,614 error rows; 574 keys; 142
  typed rows reach the generic branch** (142 after #4468), 3 unmarked on agent
  payment routes (notes); 5xx transient 36; non-answers 2; SDK error sites 31
  (26 literal / 5 variable; 41 on 2026-10-27); positive control passed.
- block 9 (field round-trip) → examined → emitted-never-read **5** (the same
  five as after #4469); read-never-emitted **13** (12 + one status key emitted
  in an unreached state); positive control passed; the #4577 pair round-trips.
- incident clustering → examined → issues created since 2026-10-30T00:00:00Z
  → **29** (4 open / 25 closed): UX-consistency epic 18, the 2026-10-30
  scan's 5, release process 2, SDK/x402 3, docs audit 1; open PRs 1. No
  untracked recurring mechanism.
- workflow archaeology → examined → `ci.yml` newest 100 → **77 / 14 / 9**; 5
  with attempt > 1, all feature branches; `dev` 37 → 33 / 4 cancelled / 0
  failure; failed jobs: visual regression 7, frontend checks 1, browser smoke
  1 (3 of the 9 one branch in 20 minutes). qa-dev at the `money-flow` job
  level → 173 runs since 2026-10-30, money-flow ran in **33 (33 success on
  attempt 1/2, 17 of 17 legs)**, gate-skipped in 140.
- comment archaeology → examined → TODO / FIXME / HACK / XXX → 0 (control
  `import` → 2,223 files); most-repeated comment 25 copies of one
  request-validation boilerplate line.
- cross-package duplication → partial (one status-literal census with its
  command in the report, 40 files across 8 packages — first written as 20 /
  six without one — not read further); validation / contracts → partial
  (blocks 8, 9 and M1); data-layer coverage → partial (gauge, the recording's
  real-DB run, P1); live exercise → not examined.
- novelty → the full ledger, the bug reports' names, GitHub searches per
  candidate; bug-report bodies not otherwise re-read.

Instrument lessons: unshallow the cloud clone before block 5, every time; a
git pathspec `**/` never matches a file directly under the directory it
follows (C2); the census runner accepts `census` and the two probe kinds only;
the real-DB harness reads `DATABASE_URL` from the runner's environment; the
container's proxy denies the Base Sepolia RPC and its loopback has no IPv6.

**Review:** `haven-reviewer` at head `410384353`, bound through the
review-isolation guard, re-derived every quoted command; no blocking, five
should-fix (the first-audit label and the per-doc overstatement in C1, C2's
"eight scans / 45 files", a three-versus-two red count, the C1 guard's shape
versus its migration, a census figure with no command), four nits. All
applied in place; corrected figures are marked above and in the report's § 5.

**Disposition: pending owner decision** (C1, C2).

**Disposition (owner, 2026-11-02): file both.** The owner answered "Both" in
the captain's session, then the four follow-up questions the filing raised.
The scan PR is #4609 (reviewed at `410384353`, corrected at `b7eb36a4a`), merged
or merging before this disposition (stacked PR). Every issue went through
new-task with an independent spec review; no owner question is open and
`pending-review` is lifted on all of them.

- C1 → epic [#4610](https://github.com/d-hinders/Haven-AI/issues/4610)
  (`epic`, `area:docs`, `area:ci`, `money-path`), slices #4612 (gate), #4613
  (archive), #4614 (guard). **The scan's C1 figures understate the class by
  an order of magnitude, found by the spec reviews:** the report's headline
  figure was the bare-paragraph shape (69 paragraphs / 30 docs / 72,877 bytes
  by its own method; 68,773 in the current docs), and its wider regex (92
  openers / 42 docs) still missed the `> **Re-verified …` blockquote-bold
  shape — the #2938 incident's — which the first review found; the second
  found `Re-verification (#N …)`, `Recent re-verification`, `#N
  re-verification`, `Re-read, not rubber-stamped` and `Re-verified, …`; the
  review of this PR found paragraphs after a bare `>` line inside a blockquote
  run (149 more). By the paragraph-start census the epic now defines (a line
  after a blank line or a bare `>` line, a heading line, or the first line of
  a blockquote run, whose first 70 characters say re-verif / re-check /
  re-read / rubber-stamp, outside fences; the reference script is in #4613's
  Method block, and every census figure here is its output — the doc totals
  and byte totals come from the status read beside it), `status: current`
  docs carry **686 openers in 51 of 79 docs, 751,135 of 3,755,152 bytes
  (20.0 %)** at `e0617aa9f` — more than the 461 KB #2681 retired; 123 of the
  686 are coupling-gate `Re-verified unchanged` notes (a first reading of 688
  counted two wrapped `#NNNN …` body lines as headings; the delta review of
  this PR caught it); the agent-served
  security model is 158 openers, 182,157 of its 299,914 bytes. The largest
  source is not the
  weekly audit but code PRs satisfying the strict contract-doc coupling gate,
  which needs an edit to the doc, so the candidate became three PRs on the
  owner's word: the gate first (a version-literal-only diff never implicates;
  a `Re-verified-unchanged:` commit trailer records a re-read, never for a
  `satisfied-by:` doc — a PR-body marker and a `*-release.md` `satisfied-by`
  glob were both rejected by review as forgeable), then the archive (verbatim,
  hashed, records left as written), then the `docs:check` guard by the same
  census rule. Owner decisions the same day: archive verbatim; include the
  release bump's printed guidance and the scripts README among the
  instruction sites; the partition and the trailer; the slice-1 threat model
  confirmed. Two spec-review passes (4 blocking / 5 should-fix / 6 nits on the
  single-task form; 4 blocking / 13 should-fix on the epic); verdict on #4610,
  Corrections: 31, plus the census amendment above recorded there after this
  PR's review.
- C2 → [#4611](https://github.com/d-hinders/Haven-AI/issues/4611)
  (`area:docs`) → **`shipped`** the same day: closed 2026-11-02 via PR #4615
  (`3d348ef93`, into `dev`) by a partner pipeline, 80 minutes before this
  entry was first written — the next scan's block 6 reads the pinned
  `ls-tree` command only. Owner decision: reference only — the six SDK files stay out
  of the copy lint's `SCAN_FILES` (the lint's decision under #2317). Spec
  review re-ran 14 claims: 12 reproduced, 2 wrong and fixed (the glob line's
  exclusion filter changed in `fe491ac24`; the docs-boundary command is not
  pinned, only its prose says to pin); 11 corrections, among them: the
  acceptance grep re-anchored to the command line, the content read pinned
  with `git show <sha>:<file>`, the "nine entries" instrument replaced (the
  figures wrap, so a single-line grep finds 2), the control run after the
  filter with a frontend twin.

Block-3 note for the next run: the 2026-11-02 report's C1 figures are
superseded by #4610's census — cite the epic, not the report, for that
class — and block 6's copy-lint figure steps from 66 / 4 to the `ls-tree`
command's reading by #4615's selector change, not by new files.

Drive: `ship-next epic=#4610` (slice order #4612 → #4613 → #4614).

**Disposition upkeep (2026-11-03):** all three slices shipped the same night
by partner pipelines — #4612 via PR #4619 (`850e48023`), #4613 via PR #4620
(`383908c3a`), #4614 via PR #4621 (`bd05485ea`); the epic stays open for its
promotion checklist. The scan record (#4609, `c9a2eca51`) merged after #4621
without a re-run against the new base and turned the required docs job red
on `dev`: #4613's test pins the record-doc census at 25 and the record's own
bullet about #2938 carries "re-verification" on its opening line (26). The pin moves to 26 in
the PR carrying this entry (#4617), with the reason beside it.

## 2026-11-09 — architecture (scoped; owner request 2026-11-09, "architectural improvements")

Full report: `docs/bug-reports/quality-scan-2026-11-09-architecture.md` (it
carries the commands and file:line evidence). Measured at `49747fac3` (the
branch tip, an ancestor of `origin/dev`) by one agent, `npm ci
--ignore-scripts`, nothing built, no suite run, no database; the clone arrived
shallow and was deepened to 2026-08-01 before any history figure. A scoped
scan: `docs/quality/scan-baselines.json` is not updated. GitHub read-only; no
live Haven call.

**Excluded this run:** every prior finding and candidate. The hand-written SDK
types beside the generated wire types (epics #1442, #3028) and the hosted
tool-contract file (epic #2806) both rank in this run's churn table and are
not re-surfaced. S1 is adjacent to the 2026-10-03 S1 (epic #3615), which took
the budget-scope question out of the payment entrypoints; S1 here is the
lifecycle that stayed in the route closures, which no prior entry measured.

**Structural finding (pending owner decision):**
- S1 — the direct-payment lifecycle is orchestrated inside route closures in
  the backend's `routes/payments.ts`, and boundary rule 5 (routes import
  module entry points only) has never been enabled. `POST /payments` is one
  closure of 478 lines and `POST /payments/:id/sign` one of 530 — 1,008 of the
  file's 1,572 lines; the sign closure awaits 17 distinct functions. The x402
  route is 210 lines over a 17-file module and the MPP route 397 over 16,
  both split by epic #980 (#996, #997), which did not list this route. The
  file measured 898 lines before 2026-09-15 and 1,561 before 2026-10-15. Same
  shape in `routes/agent-delegations.ts` (1,389 lines, an 8-statement
  `pg-only-in-infra` waiver), `routes/agent-rekey.ts` (1,276) and
  `routes/agent-connection-setups.ts` (1,556). Across the 50 route files:
  90 repository imports, 71 module imports, 33 rail imports. Incident
  clustering, not causation: seven issues 2026-09-30 → 2026-10-29 on the
  direct entrypoint (#3494, #3500, #3503, #3564, #3609, #4354, #4533),
  classified by title and label only; #4354 runs the other way and #3609's
  fix spanned payments, x402 and MCP. The cost criterion is the weakest leg.
  Five slices proposed: create flow, sign state machine, grant lifecycle,
  rekey stages, a shrink-only ratchet. Slices 1–4 are money-path.
  *Corrected in review (`569cbd792`):* first recorded rules 2 and 5, closures
  of 481 / 542 / 1,023, "Cost", and slices 1 and 2 only.

**Improvement candidates (one PR each), pending owner decision:**
- C1 — `no-circular` runs on 2 of 13 packages (the dependency lint's
  `SCAN_ROOTS`); a one-rule probe over the other eleven finds 1 runtime cycle,
  the SDK's `merchant-answer.ts` ↔ `merchant-completion.ts`, and 0 in the
  other ten.
- C2 — the backend's `src/index.ts` hand-wires 10 `setInterval` jobs (9
  leader-gated; an eleventh registers itself in `startRetrySweep`) and their
  wiring is asserted by regex over the file's source
  (`catalog-ingest-monitor-wired.test.ts`, `anchor-seams-wired.test.ts`), the
  technique #4411 showed can go blind; the file took 51 of 1,229 first-parent
  landings since 2026-09-01.
- C3 — `machine_metadata` is re-parsed by 8 private helpers and
  `settlementSchemeOf` is defined in 4 backend files with 3 distinct bodies
  (`x402/intent-by-key.ts`, `x402/settlement-observed.ts`,
  `payments/agent-payment-status.ts`, `mpp/budget-precheck.ts`). No
  disagreement on a stored row was shown.

**Probed clean** (dimension → examined / partial / not examined → command → number, all at `49747fac3`):
- sizing → partial → largest non-test files by `wc -l` only; no per-package
  total is recorded (the run's ad-hoc count is not the manifest's sizing
  instrument). *Corrected in review:* totals first recorded here were removed.
- backend boundaries → examined → `npm run lint:deps` → 0 violations across
  522 files, 15 waived edges, inline-SQL gauge 35 at ceiling 35.
- cycles outside backend/core → examined → one-rule `depcruise` probe per
  package → 1 (`sdk`) / 0 in ten.
- cross-package duplication → partial → backend function-name duplicates only
  (46 names); local vs hosted MCP vs signer tool definitions not compared.
- frontend architecture → partial → largest files and cycle probe (0);
  data-access sites not examined. *Corrected in review:* a fetch-site census
  first recorded here did not reproduce and was removed.
- churn → examined → first-parent landings since 2026-09-01 per production
  file → 1,229 landings.
- incident clustering → partial → seven direct-payment issues, title and
  label only.
- workflow archaeology → not examined → out of scope.
- block 1 → not examined → scope is architecture.
- block 2 → not examined → scope is architecture.
- block 3 → not examined → scope is architecture.
- block 4 → not examined → scope is architecture.
- block 5 → not examined → scope is architecture.
- block 6 → not examined → scope is architecture.
- block 8 → not examined → needs the backend suite's database and builds;
  scope is architecture.
- block 9 → not examined → needs the backend suite's database and builds;
  scope is architecture.
- weekly re-measurement (#4635 at `f03f90102`) → read → no flagged, failed or
  refused row.

**Disposition: pending owner decision** (S1, C1, C2, C3).

**Disposition (owner, 2026-11-09): file all four.** The owner's words in the
captain's session were "file all four as you suggest", the suggestion being:
C1, C2 and C3 as standalone tasks, and S1 as an epic limited to the two
closures in the direct-payment route plus a ratchet, with the three other
large routes noted and unscheduled. Every issue went through new-task with an
independent spec review; the four reviews required 42 body corrections in
all, and none was ready as first filed.

- S1 → epic [#4759](https://github.com/d-hinders/Haven-AI/issues/4759)
  (`epic`, `area:backend`, `money-path`), slices #4760 (create flow), #4761
  (sign state machine), #4762 (route line ceiling). Verdict `ready` after
  repair, 16 corrections; `pending-review` lifted on all four. The review's
  blocking finding: both moves would have taken the code off the money-path
  perimeter.
- C1 → [#4763](https://github.com/d-hinders/Haven-AI/issues/4763). **The
  scan's C1 figure holds for runtime imports only**, found by the spec
  review: the repo's rule counts type-only imports, and under it the eleven
  unscanned packages hold 10 cycles in 5 packages, not 1. Verdict `blocked on
  owner decision`, 9 corrections; `pending-review` stays on for one owner
  question (runtime cycles only, or the full definition as an epic).
- C2 → [#4764](https://github.com/d-hinders/Haven-AI/issues/4764). Verdict
  `ready` after repair, 8 corrections; `pending-review` lifted. The review's
  blocking finding: every criterion could pass while the catalog-ingest
  monitor was rebuilt per tick.
- C3 → [#4765](https://github.com/d-hinders/Haven-AI/issues/4765). **The
  scan's C3 figures understate the class**, found by the spec review: 15
  parse sites and 8 scheme reads (5 scheme readers), not 8 parsers and 4
  definitions. Verdict `ready` after repair, 9 corrections; `pending-review`
  lifted.

## 2026-11-09 (run B) — the two MCPs (scoped; owner request 2026-11-09, "scan both MCPs")

Full report: `docs/bug-reports/quality-scan-2026-11-09-mcp.md` (it carries the
commands and file:line evidence). Scope: the published local MCP package, the
hosted MCP, and what they share or duplicate, the signer included. Measured
at `49747fac3` (equal to `origin/dev`) by one agent, `npm ci
--ignore-scripts`, with core, the SDK, the local MCP, the signer and the
hosted MCP built; no suite run, no database. A scoped scan: the baselines
manifest is not updated. GitHub read-only apart from the filing above; one
public npm registry read; no live Haven call.

**Excluded this run:** every prior finding and candidate. The hosted tool
files (epic #2806), the budget-scope keys on both surfaces (epic #3615) and
the doubled post-funding merchant decision in the SDK (2026-10-19 C3) are not
re-surfaced. S1 revisits a question the 2026-08-18 entry refused ("local/
hosted MCP tool mirroring (already parity-tested)") on evidence that
post-dates it, and sits beside the 2026-09-17 F1 (epic #3105), whose slice 5
pinned handoff parity — the arguments an agent copies from a response — and
not the two surfaces' input contracts tool by tool. **Withdrawn in review:**
a candidate on the local MCP package and the money-path perimeter. The
2026-09-17 C1 raised it and #3098 decided it (the package is pinned doc-only
by the perimeter's own test); the draft's "no recorded decision" was false.

**Structural finding (pending owner decision):**
- S1 — one agent surface is implemented twice with no shared contract, and
  the nets cover the hosted side. Local 20 tools, hosted 29, 19 shared names;
  8 of the 19 have different input key sets or required sets (types not
  compared) and 10 different descriptions; 46 of the 55 first-parent landings on the local package since
  2026-09-01 also touched the hosted one. The tools/list snapshot, contract
  fingerprint, next-arguments corpus and refusal census exist for the hosted
  package only, and the QA agent does not depend on the local package. Cost:
  #2348, with #2312 as the class it was found through, closed with per-key
  pins; the architecture doc records the `haven_send` idempotency-key case as
  "Total loss". *Corrected in review:* #2349, #2353 and #3411 were first
  cited too and are not divergence incidents. The decision under it is the local package's support level
  (first-class, deliberately smaller, or frozen). Three slices proposed: a
  parity manifest, one typed-refusal table, a local tools/list snapshot.

**Improvement candidates (one PR each), pending owner decision:**
- C1 — the local MCP's error mapper answers a typed backend refusal with a
  generic code and no reason field: by execution with a stubbed SDK client,
  ten backend error codes gave a typed code on the hosted mapper for 9 and
  the omitted-reason field for 10, and on the local `haven_send` handler the
  generic API error and no omitted-reason field for all 10. The step itself
  is passed through from the backend body when present. *Corrected in
  review:* a claimed step divergence on the two budget codes was an artifact
  of the stub body. Residue of epic #3105 slice 4 on the error path.
- C2 — delegate-key credential loading and consent are written twice (local
  MCP and signer): 128 matching lines (110 non-blank) of the signer's
  233-line credentials file, 92 (81 non-blank) of its 208-line consent file;
  no behavioural difference shown.

**Probed clean** (dimension → examined / partial / not examined → command → number, all at `49747fac3`):
- tool sets → examined → the local tool keys and the hosted snapshot's keys →
  20 / 29 / 19 shared.
- contract comparison → examined → built local zod shapes against the hosted
  snapshot → 11 equal / 8 different key-and-required sets; 9 equal
  descriptions.
  Output shapes not compared.
- error mapping → partial → ten codes by execution through one local handler;
  the full block 8 recording not run.
- co-change → examined → first-parent landings since 2026-09-01 → 55 local,
  46 of them also hosted; 150 hosted.
- duplication with the signer → partial → credentials, consent and the three
  error mappers.
- hosted tool-file internals → not examined → prior finding, excluded.
- block 1 → not examined → out of scope.
- block 2 → not examined → out of scope.
- block 3 → not examined → out of scope.
- block 4 → not examined → out of scope.
- block 5 → not examined → out of scope.
- block 6 → partial → one perimeter check, which found the #3098 decision;
  gate allowlists not walked.
- block 8 → partial → ten synthetic codes against both mappers; needs the
  backend suite's database for the recorded set.
- block 9 → not examined → needs the backend suite's database and builds.

**Disposition: pending owner decision** (S1, C1, C2).

**Disposition upkeep (2026-11-10), run A (architecture):** the one open owner
question on #4763 is answered — "runtime cycles only" — recorded on the issue
under `## Owner decisions`, and `pending-review` is lifted, so #4763 is
unblocked. Five of the run's issues had already shipped by then: #4760,
#4761, #4762, #4764 and #4765 were closed as completed between 01:07 and
04:11 UTC on 2026-11-10; the epic #4759 stays open as their tracking issue.
The scan PR is #4758, merged 2026-11-10 as `51e66d281`.

**Disposition (owner, 2026-11-10), run B (the two MCPs): file all three.** The
owner's words in the captain's session were "file all three MCP findings". Every issue went through
new-task with an independent spec review; the two reviews (the epic's with a
delta re-review) required 31 body corrections, and none was ready as first
filed.

- S1 → epic [#4788](https://github.com/d-hinders/Haven-AI/issues/4788)
  (`epic`, `area:mcp`, `area:docs`, `money-path`), slices #4789 (parity
  manifest), #4790 (typed refusals on the local MCP), #4791 (local tools/list
  snapshot). Verdict `ready` after repair, 19 corrections; `pending-review`
  lifted on all four. The scan's support-level question (first-class,
  deliberately smaller, or frozen) is recorded on the epic as unanswered and
  holds nothing.
- C1 → slice #4790 of that epic, not a standalone issue: it is one of the
  epic's three remedies. **Its remedy changed in spec review.** The scan
  proposed one refusal table in the SDK read by both mappers; the hosted
  mapper has no single table (20 typed codes, 10 through branches with
  logic a flat table cannot hold, the rest typed off the workspace-private
  core package). The filed slice leaves the hosted mapper untouched and
  teaches the local one the same answers — the smaller remedy the scan also
  offered — and the spec review added a parity test over the hosted suite's
  fixture bodies to pin the two together.
- C2 → [#4792](https://github.com/d-hinders/Haven-AI/issues/4792) (`area:mcp`,
  `area:sdk`, `money-path`). Verdict `ready` after repair, 12 corrections;
  `pending-review` lifted. The review confirmed the two permission checks
  behave the same (no defect) and narrowed what moves; it also found that
  chain-id parsing does differ between the two copies — lenient in the local
  MCP, throwing in the signer — and that stays per package.

**A scan figure corrected by the epic's spec review:** S1's count of shared
tools with different input key sets or required sets, recorded above as 8 of
the 19, is **7**, with no required-ness difference at all. The scan's comparison read required-ness
from the zod type name on the local side and from the JSON-Schema `required`
list on the hosted side, and so counted a tool whose one field is declared
identically on both. Re-measured with one instrument on both sides (the zod
`isOptional()` of each field of both registries) at `51e66d281` → 12 equal,
7 different. The report and the entry above stay as written; this line is
the correction. The tool counts were re-taken at `51e66d281` for the epic:
20 / 29 / 19, unchanged.

**A second instrument fault, found by this entry's review:** the co-change
figure's command used a bare date (`--since=2026-09-01`), which git reads as
that date at the current time of day, so the count moved with the hour it was
run: 46 of 55 when the scan ran it, 48 of 57 when the epic was filed, both
partly artifacts. Pinned to `--since=2026-09-01T00:00:00Z`: **47 of 57** at
`49747fac3` and **48 of 58** at `51e66d281` — one landing between the two,
and it touched both packages. The conclusion (about five in six local
landings also change the hosted package) is unchanged.

**Disposition upkeep (2026-11-11), both 2026-11-09 runs: every filed slice and
standalone issue is `shipped`; run A's epic stays open (below).** Each was
closed by a pull request merged to `dev`.

- Run A (architecture): S1's slices #4760 via PR #4777 (`9b809188`), #4761
  via PR #4780 (`36378243`) and #4762 via PR #4783 (`c9201556`); C1 → #4763 —
  runtime cycles only, per the owner — via PR #4802 (`d314d6d7`); C2 → #4764
  via PR #4778 (`4346e70f`); C3 → #4765 via PR #4782 (`0cbcdff6`) →
  `shipped`. S1's epic #4759 stays open: its promotion checklist names a qa-dev observation nobody has
  recorded on it yet.
- Run B (the two MCPs): S1 → epic #4788, closed 2026-11-11 with its promotion
  check linked on the issue; slices #4789 via PR #4795 (`149a3313`), #4790
  (which is also C1) via PR #4801 (`ba1bf134`), #4791 via PR #4794
  (`039556e3`) → `shipped`. C2 → #4792 via PR #4803 (`8486093d`) → `shipped`.
- A fourth slice was added to epic #4788 after the 2026-11-10 run-B
  disposition was written, found
  by slice 1's build rather than by the scan: #4796, four tool descriptions
  that named a tool their own surface does not register, via PR #4798
  (`0423db37`) → `shipped`. The same defect on three other surfaces (the
  SDK's direct tool definitions, the signer's descriptions, backend response
  prose) is recorded on the epic and is not filed.

## 2026-11-11 — the two flagged rows of the weekly re-measurement (scoped; #4635)

Scoped to the two rows the weekly job flagged at `039556e38` (#4625's table in
#4635): `sizing` ("flagged — shrank (expected to grow)") and `docs boundary`
("flagged — moved (exact)", 43 → 45). Measured at `origin/dev` @
`8486093dfc6039dda4a892290d87e34bb871facf` (the tip at pickup; the table's own
SHA is `039556e38`), in a linked worktree, no `npm ci` needed for either
instrument. A scoped scan: `docs/quality/scan-baselines.json` is not updated
(skill § Method), so the manifest keeps `43` @ `e0617aa9f`; the next whole-repo
entry records the new count. GitHub read-only; no live Haven, MCP, dev or
production call.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. Neither row re-surfaces one.

**Structural findings:** none. The scope is two instruments, not a sweep.

**Improvement candidate (one PR), filed:** the docs-boundary instrument counts
test fixtures as ungoverned Markdown — see the row below, filed as
[#4804](https://github.com/d-hinders/Haven-AI/issues/4804).

**Probed clean** (coverage record; scoped, so only the two rows are examined):

- sizing → examined → the row's command (`sizing-source-test-lines` in
  `docs/quality/scan-baselines.json`: pinned `git ls-tree`/`git show`, 13
  packages, `.test.`/`__tests__`/`.spec.` split) → at `8486093df`: backend
  124,177 / 167,496; frontend 83,583 / 93,776; sdk 20,628 / 23,627; core
  26,142 / 985; qa-agent 20,292 / 18,508; mcp-server 14,330 / 26,323; signer
  5,488 / 9,545; connect 12,436 / 15,676; cli 3,196 / 3,611; ops 3,199 / 2,266;
  ui 2,849 / 2,402; mcp 3,010 / 5,449; demo-merchant-mcp 4,105 / 4,591. Totals
  323,435 source / 374,255 test (323,104 / 373,222 at `039556e38`; 308,076 /
  352,607 at `e0617aa9f`). Against the recorded baseline: +3,114 / +6,604;
  +4,990 / +6,878; +986 / +980; +388 / 0; +5,159 / +5,225; +216 / +867;
  −76 / +182; 0 / 0; −11 / +2; +56 / +44; +27 / +74; +193 / +411;
  +317 / +381. Three figures shrank, each traced to the commit that did it:
  cli source −11 = `f6fdb2620` (#4662), `args.ts` −2 and `commands.ts` −9 net;
  signer test −1 = `ae192d597` (#4756), `x402-sign-header-transport.test.ts`
  +2/−3; signer source −76 = `8486093df` (#4792), `credentials.ts` −57 net and
  `file-mode.ts` −19 net, with the handling moved to a new SDK module (+187)
  and a +183 characterization test. Verdict: real deletions and a
  cross-package move, not instrument rot. No finding.
- block 6 → partial → the docs-boundary half only → the row's pinned listing
  (`block6-docs-boundary`: `git ls-tree -r --name-only $SHA | grep -E '\.md$' | grep -vE
  '^(docs/|packages/|README|CLAUDE|AGENTS|ABOUT_HAVEN)' | wc -l`) → **52** at
  `8486093df` (43 at `e0617aa9f`, 45 at `039556e38`). Composition at the tip:
  `.agents/skills` 24, `.claude/commands` 8, `.claude/agents` 7, `scripts` 8,
  `.github` 3, `.claude/hooks` 1, `.agents/README.md` 1. The 43 → 45 move is
  `586cd8e8c` (#4727, the review-issue skill: `SKILL.md` + 2 references +
  `.claude/commands/review-issue.md`, 4 files) less `e9275701d` (#4694, the two
  retired qa commands, 2 files) — the same class as the baseline's
  `.agents/skills` and `.claude` files, no new class. The 45 → 52 move is
  **7 test fixtures**: `scripts/docs/fixtures/issue-method/*.md`, added by
  `68efd71dd` (#4797) as inputs to the issue-method checker's test
  (`FIXTURES = join(HERE, 'fixtures', 'issue-method')`, line 38). They are not
  documentation, and the row's `tolerance` is 0, so every fixture addition
  flags the weekly row as `moved (exact)` — a false positive. **Finding filed:
  #4804** (`area:docs`, `area:ci`, `pending-review`): exclude Markdown under a
  `fixtures/` directory from the pinned listing, state the exclusion in
  `dimensions.md` § 6, and keep the row's `43` @ `e0617aa9f` — the exclusion is
  a no-op at that SHA (0 fixture files there), so the pin stays valid.
- blocks 1–5, 8, 9, comment archaeology, incident clustering, workflow
  archaeology, cross-package duplication, data-layer coverage, live exercise →
  not examined → out of this scope (the two flagged rows).

**Controls.** The sizing instrument reproduces both recorded readings exactly:
at `e0617aa9f` it prints the 26 recorded figures (26/26) and at `039556e38` the
26 figures of #4635's table (26/26), so the deltas above are the instrument's,
not a reconstruction. The docs-boundary listing's arithmetic holds: 962 `.md`
at the SHA − 906 under `docs/` or `packages/` − 4 root files = 52, and the
listing reaches a known top-level file (`.agents/skills/quality-scan/SKILL.md`
→ 1). The proposed exclusion's control: the same listing without it prints 52
at `8486093df`, with it 45, and the 7-file difference is exactly the fixture
directory.

**Doc figures.** All three `docFigures` rows measured again at `8486093df` and
unchanged: `ds-button-variant-distribution` 205 / 33 / 8 / 4,
`ds-icon-rung-12px` 16, `frontend-settings-tabs-dark-baseline` 1. No doc
sentence moves, so no row is refreshed (#4631).

**Disposition: finding filed** (#4804, `pending-review` until its independent
review-issue pass). The sizing row needs no decision.

## 2026-11-12 — whole repo, hunting defects across verticals (owner request 2026-11-12, "find bugs from several verticals")

Full report: `docs/bug-reports/quality-scan-2026-11-12-whole-repo.md` (it
carries the file:line evidence and each reproduction's decisive output).
Measured on `origin/dev` @ `9871885a9`. The window is `e0617aa9f..9871885a9` →
**111** first-parent landings / 909 files / +76,564 −18,080. Five workers: four
hunters, one per vertical (the backend payment path; the backend outside it;
the agent surface; the owner dashboard), each required to run a reproduction
with a positive control, and one measurement worker in its own clone for the
numbered blocks. The captain ran all 15 reproduction test files and 2 scripts a
second time at the SHA; each gave the pass / fail pattern its hunter reported.
The bundler, the accounting provider and the HTTP client were stand-ins in
every reproduction; no finding claims an on-chain outcome. Blocks 8 and 9
recorded the backend suite against a disposable local Postgres database. Live
calls were read-only, on dev only, as a dev agent. GitHub was read-only. One
security hypothesis is not written in the public record and went to the owner
directly.

**A departure from the skill, named:** the owner's scope was a defect hunt, so
the report carries a third list beside the two output levels — ten reproduced
one-PR defects beyond the cap of five. They are prior art for the next run's
exclusion like any candidate.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. S1 sits beside #3564, #3930 and #4470, each of which fixed one
call site of the same failure mode and is closed; S1 is the sites they did not
reach, none of which a prior entry measured.

**Structural finding (pending owner decision):**
- S1 — between sending an operation and booking its outcome, one failure mode
  is recognised as "outcome unknown". The backend's rail file has two
  send-and-wait functions; the unknown outcome is raised at one throw site, the
  receipt wait of the shared redemption submit, which three callers read (the
  sign module and the two budget routes). Five
  reproduced defects: (1) the agent sign route books `failed`, and the hosted
  mapper says "create a new payment", when the bundler's answer to the send is
  lost (a transport timeout of about 10 s); (2) the same when the op is mined
  and the confirm write throws; (3) a sign request that dies after the claim
  leaves the row `submitted` with no operation hash, and the submission
  reconciler, the erc7710 sweep and the orphan sweep each select 0 rows for it;
  (4) a payment the submission reconciler confirms has no fiat values, fires no
  accounting feed and is excluded by the Sync-now backfill's SQL; (5) the
  dashboard's Send dialog shows a lost submit as a failure with "Try again",
  and the retry signs and submits a second transfer with no idempotency key.
  All five owner-side callers of the treasury submit (owner transfer, signer
  change, two revocations, re-key revocation) answer any throw, post-send
  included, with 502 "… failed". On record: the same failure mode fixed three
  times, one site at a time (#3564 and #3930 from code review, #4470 from the
  2026-10-27 refusal-census trial); no production incident. Slices: the rail
  first; the sign route and reconciler intake; reconciler booking; the owner
  transfer route and dialog; the four other owner callers. Not observed: a real
  bundler including an op whose answer was lost.
- A second structural finding ("a non-answer is read as an answer", four
  defects in four packages) was drafted and withdrawn at review: no measured
  census, and each remedy is one PR. Its four defects are listed beyond the cap
  below.

**Improvement candidates (one PR each), pending owner decision:**
- C1 — the signed receipt bundle (`GET /payments/:id/receipt`,
  `haven_get_receipt`) of an EIP-3009 payment sets `recipient` and
  `parties.merchant` to the agent's delegate and carries no settlement hash,
  while the receipt list and the status read name the merchant. Seen live on
  dev and by a tree test; the party characterization fixtures do not cover the
  bundle.
- C2 — a verified self-submitted catalog row is listed to agents and hinted
  `haven_quote_catalog_purchase`, and the detail route answers 404 to an agent
  for the same id (`routes/catalog.ts`).
- C3 — an Accounted push ends `skipped` (`IDEMPOTENCY_KEY_REUSE`) when the
  first upload's answer is lost and the merchant receipt is captured before the
  retry: the underlag's bytes depend on the receipt, the idempotency key on the
  payment id alone. Provider side is the repository's simulator.
- C4 — the local MCP hands task-budget and sub-budget signing to
  `mcp__haven-signer__haven_sign`, a server the connector's `--local` mode
  removes; the local surface has no signing tool.
- C5 — x402 authorize with the same idempotency key after settle answers an
  untyped 409 "retry the original request" with no payment id for as long as
  the row is `submitted` (`modules/x402/replay.ts`).

**Reproduced, beyond the cap of five (pending owner decision):**
- the hosted `haven_quote_x402` handler skips the `expected_amount` comparison
  when its agent read fails, answers `safe_to_continue: true` and prefills the
  cap at the merchant's price — through the hosted server this needs the
  identity gate's read of the same endpoint to succeed and the handler's to
  fail (the reproduction bypassed the gate); the local quote, which has no
  gate, returns a plain quote with no comparison and no stop;
- the hosted error mapper answers a 429 (rate limit, hourly x402 cap, relayer
  budget) "refused as made … cannot succeed" and drops the wait;
- the signer's sign-context fetch reports an HTML 502 and a 429 as
  `SIGN_CONTEXT_REFUSED` without the relay fallback;
- the dashboard's session restore deletes a valid token on any failed
  `/auth/me`, and a token that expires mid-session is never noticed;
- Send's amount field: a decimal comma silently rejected; a sub-unit amount
  reaching Review as "Send 0 USDC";
- Send above the balance answering "Could not prepare the transfer" (backend
  half run; the dialog's retry button for this case inferred);
- a contact the Contacts page accepts that Send cannot review (checksum-strict
  check);
- contacts unique per raw string, so one address in two casings is stored
  twice;
- one Bazaar index entry with a field of the wrong type aborting the discovery
  run;
- a quote that reports the standard entry's price while it compares and pays
  the erc7710 entry's.

Leads, not proposed: block 1's two survivors (dead code in the hosted
`auth.ts`; the task-budget recipient caveat pinned by count only); typed codes
on task-budget, sub-budget and resume routes that reach the generic branch
outside block 8's payment-route rule.

**Escape analysis** (89 issues created since 2026-11-02; 2 carry a `Found by:`
line as the convention writes it; 28 judged defects not found by a scan, by the
captain's reading; the other 61 read by title only and not classified one by
one): dev tooling and CI 14 (block 6 should have seen 3 — scripts that exit 0
without running); agent guidance and onboarding wording 5 (no block); catalog
and header conformance from a live purchase 2 (block 10, added since); what a
money field claims 2 (no block); operator incident 2 (no block); dashboard 3
(no block). This run's own 20 defects by class: the seam after the send 5,
non-answer read as an answer 4, cross-surface disagreement on one fact 3,
dashboard input handling 3, and one each of contact casing, a handoff to
something the surface lacks, replay shape, a retry that is not byte-stable,
and one item aborting a batch. The first and third classes have no block;
block 8 states the second as its clean criterion, but its instrument did not
reach these four.

**Dispositions observed (upkeep):** 2026-11-11 scoped entry → #4804 open,
still `pending-review`. 2026-11-02 C1 → epic #4610 open for its promotion
checklist. The 2026-11-09 epics #4759 and #4788 are closed; #4580 is closed.

**Probed clean** (block → examined / partial / not examined → command → number, all at `9871885a9`; parentheses are the 2026-11-02 entry at `e0617aa9f`):
- sizing → examined → the manifest row → backend 124,298 / 167,714 (121,063 /
  160,892); frontend 83,583 / 93,776; sdk 20,679 / 23,628; core 26,194 / 985;
  qa-agent 20,292 / 18,508; mcp-server 14,330 / 26,472; signer 5,488 / 9,545;
  connect 12,436 / 15,676; cli 3,196 / 3,611; ops 3,199 / 2,266; ui 2,849 /
  2,402; mcp 3,010 / 5,449; demo-merchant-mcp 4,105 / 4,591 (signer and cli
  source shrank, as the 2026-11-11 entry traced). Fat controllers → 50 route
  files, 4 at or above 1,000 lines, 216 registrations, largest 1,556 (50 / 4 /
  212 / 1,572).
- block 1 (guard falsifiability) → examined → the census command → **253**
  candidate files (1 by the pre-#4806 sample); runner: 5 census mutations + 2
  probes → **5 caught, 2 survived**, 0 shadowed, 0 mutation-red (3 caught of
  3). Files 6–253 not sampled.
- block 2 (`covers:` completeness) → partial → the manifest rows only → 15 / 5
  / 7 (unchanged); covers-gaps 123 / 33 (124 / 33); control passed.
- block 3 (stale numbers) → partial → the manifest rows only → head sample 7 /
  1 (13 / 2); `any` 39; db-mock gauge 54 / 270 / 57; zod 0; controls passed.
- block 4 (retired vocabulary) → partial → the manifest row only → 199 / 48 /
  151 (196 / 47 / 149); control 36.
- block 5 (merge-method drift) → examined → 282 merge commits (282); squash /
  total 1,531 / 1,816 (1,420 / 1,705).
- block 6 (nets with holes) → partial → the manifest rows only → copy lint 121
  / 15 (111 / 14); money perimeter 32 / 20; visual gate 15 / 27; docs boundary
  52 (43; flagged, tracked by #4804).
- block 8 (refusal census) → examined → 573 files, 572 passed, 1 skipped,
  7,235 tests, 359 s; **2,232 rows; 1,626 error rows; 578 keys; 143 typed rows
  reach the generic branch** (2,203 / 1,614 / 574 / 142); 3 unmarked on agent
  payment routes, the same three; 5xx transient 37 (36); non-answers 2; SDK
  error sites 31 (26 / 5); positive control passed.
- block 9 (field round-trip) → examined → emitted-never-read **5**, the same
  five; read-never-emitted **13**; positive control passed.
- block 10 (catalog conformance) → fixtures examined; default tier examined →
  the dev listing at 2026-11-11T23:17:50Z → 26 entries, 24 active, 12 http / 12
  mcp, 0 bazaar; third-party tier not examined → not requested.
- incident clustering → partial → the escape analysis; no count over time.
- workflow archaeology → not examined.
- comment archaeology → examined → 0 markers (control `import` → 2,326 files).
- residual archaeology → examined → window 2026-11-02T00:00:00Z ..
  2026-11-12T00:00:00Z, taken 2026-11-11T23:10Z → 115 PRs; 61 with an inline
  residual line, 7 saying none; 13 with a residual heading; 45 bullets, 3
  citing an issue or PR.
- live exercise → examined → read-only, dev only, 13 calls through the dev
  hosted MCP before dev began deploying the next landing; runtime identities
  recorded in the report; result C1 and one lead.
- cross-package duplication → not examined; validation / contracts → partial
  (blocks 8, 9 and the hunters' route tests); data-layer coverage → partial
  (the gauge).
- novelty → the hunters' GitHub searches, the ledger and the bug reports'
  names; the captain read each cited issue's title and state, the reviewer its
  body.

Instrument lessons: a new file under one package's `src` makes another
package's fresh-dist guard refuse to start (a signer reproduction stopped the
hosted MCP's tests for minutes), so a reproduction for a package others build
against is better run as a script against `dist`, as the two local-MCP ones
were; `rg` does not resolve under `bash` on the scan machine and was passed to
the runner through `$RG`; a hunter's `git fetch` in a shared worktree moves
`origin/dev` for every reader, so commands name the SHA; a hunter's timing
figure is not the captain's — quote the run that was kept.

**Review:** `haven-reviewer` at head `42f2ccc39`, in its own clone, checked
(by its own count) 60 line references, every count with a command, the 21
manifest rows, the block figures against their raw outputs, 20 issue and PR
claims against their bodies and each quoted reproduction output against the
logs and test sources: changes requested — 7 blocking, 16 should-fix, 10 nits,
all applied.
Among them: the second structural finding withdrawn; the hosted quote defect
narrowed to the condition above; two wrong attributions (#4470's origin,
#3214's subject); a timing figure that was a hunter's, not the captain's; a
false "touches none of the files cited"; three money-path verdicts that had
been asserted and not run. A second pass at `94eb159bd` found all seven
blockers resolved and no blocking item, and asked for four should-fix and
three nit text corrections, which the captain applied directly without a third
pass. The report's § 5 lists both passes.

**Disposition: pending owner decision** (S1, C1–C5, and the ten defects beyond
the cap).

**Disposition (owner, 2026-11-12): file as proposed.** The owner's words in the
captain's session were "Fila enligt ditt förslag" ("file as you proposed"), the
proposal being: S1 as an epic with the rail slice first, C1–C5 as standalone
issues, and four of the ten defects beyond the cap (the dashboard session
read, the 429 mapping, the signer's gateway errors, the skipped price
comparison). The other six beyond-cap defects stay unfiled. The security
hypothesis kept out of this record is not part of this disposition. Every
issue went through new-task with one independent spec review; none was ready
as first filed, and the ten reviews required 136 body corrections in all.

- S1 → epic [#4816](https://github.com/d-hinders/Haven-AI/issues/4816)
  (`epic`, `area:backend`, `area:frontend`, `money-path`), slices #4817
  (rail), #4819 (reconciler booking), #4818 (sign route and reconciler
  intake), #4820 (owner Send), #4821 (other owner operations), in that build
  order. Verdict `blocked on owner decision`, 31 corrections; the review
  reordered the slices, excluded erc7710 rows from the new intake, and re-cut
  #4821. `pending-review` lifted on #4817, #4820, #4821.
- C1 → [#4822](https://github.com/d-hinders/Haven-AI/issues/4822), 13
  corrections, one owner question.
- C2 → [#4823](https://github.com/d-hinders/Haven-AI/issues/4823), 7
  corrections, one owner question (a third option added by the review).
- C3 → [#4824](https://github.com/d-hinders/Haven-AI/issues/4824), 10
  corrections, one owner question; the review found five sources of byte
  drift, not one.
- C4 → [#4825](https://github.com/d-hinders/Haven-AI/issues/4825), 12
  corrections, one owner question; now `money-path` by its cross-package pins.
- C5 → [#4826](https://github.com/d-hinders/Haven-AI/issues/4826), 14
  corrections, `ready`, `pending-review` lifted.
- Dashboard session → [#4827](https://github.com/d-hinders/Haven-AI/issues/4827),
  13 corrections, two owner questions.
- 429 mapping → [#4828](https://github.com/d-hinders/Haven-AI/issues/4828),
  12 corrections, `ready`, `pending-review` lifted; the sign route's 429 named
  in the report is unreachable in production.
- Signer gateway errors → [#4829](https://github.com/d-hinders/Haven-AI/issues/4829),
  11 corrections, one owner question; all four signing-context fetches share
  the defect.
- Skipped price comparison → [#4830](https://github.com/d-hinders/Haven-AI/issues/4830),
  13 corrections, `ready`, `pending-review` lifted; two further local skips
  found by the review.
- Unfiled, beyond the cap: Send's amount field, Send above the balance, the
  contact checksum mismatch, contact casing, the Bazaar poison entry, and the
  quote's two prices.
