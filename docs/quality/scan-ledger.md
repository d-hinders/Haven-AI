---
owner: "@d-hinders"
status: current
covers:
  - .agents/skills/quality-scan/SKILL.md
  - .agents/skills/quality-scan/references/dimensions.md
  - scripts/test-support/guard-cli.mjs
last-verified: "2026-09-15"
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
- **Wave-dimension coverage (#2501, binding for entries from 2026-09-03
  on):** `Probed clean:` names each current numbered block in the skill's
  `references/dimensions.md` by number — `block N → command → number` —
  including a block whose number became a finding. A block missing from the
  section in an older entry means the run did not take it; new entries name
  even unexamined blocks explicitly. Never infer “clean” from missing evidence.
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

Disposition: approved and filed as standalone #3117; implementation underway.
The other approved candidates remain separately tracked: capability selection
[#3116](https://github.com/d-hinders/Haven-AI/issues/3116) and native MCP transport
[#3118](https://github.com/d-hinders/Haven-AI/issues/3118). No new scan conducted
in the implementation pass; no new structural finding.
