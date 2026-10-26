---
owner: "@d-hinders"
status: current
covers:
  - scripts/docs/audit-staleness.mjs
  - scripts/docs/audit-staleness.test.mjs
  - scripts/docs/coupling-gate.mjs
  - scripts/ci/prove-red.mjs
  - scripts/ci/change-classifier.mjs
  - scripts/lint-budget-liveness.mjs
  - scripts/retired-rail-prose-ratchet.mjs
  - packages/backend/src/modules/x402/delegation-authorize.ts
  - packages/backend/src/modules/budget-scope/refusal-body.ts
  - packages/backend/src/modules/budget-scope/expired-budget.ts
  - packages/backend/src/modules/mpp/budget-precheck.ts
  - packages/backend/src/routes/__tests__/x402-delegation.test.ts
  - packages/backend/src/routes/__tests__/budget-precheck.test.ts
  - packages/backend/src/modules/payments/__tests__/refusal-census.test.ts
  - packages/mcp-server/src/tools/support/quote-response.ts
  - packages/backend/src/infra/http/ssrf-guard.ts
  - packages/backend/src/infra/explorer-api.ts
  - packages/backend/src/infra/prices.ts
  - packages/backend/src/infra/delegate-alert-webhook.ts
  - packages/backend/src/db/migrations/121_agents_avatar_tint.ts
  - packages/backend/src/db/migrations/__tests__/121_agents_avatar_tint.test.ts
  - packages/backend/src/infra/repositories/__tests__/agents-avatar-tint.db.test.ts
  - packages/backend/src/infra/repositories/agents.ts
  - packages/backend/src/infra/repositories/__tests__/agents.test.ts
  - packages/backend/src/routes/__tests__/agents.test.ts
  - packages/backend/src/infra/repositories/analytics.ts
  - packages/backend/src/routes/__tests__/analytics-overview-golden.db.test.ts
  - packages/backend/src/routes/analytics-overview.ts
  - packages/backend/src/routes/__tests__/analytics-overview.test.ts
  - packages/backend/src/infra/__tests__/helpers/db-harness.ts
  - packages/frontend/e2e/analytics-header-wrap.mobile.spec.ts
  - packages/frontend/src/lib/agent-skill-bundle.ts
  - packages/sdk/src/skill-content.ts
  - packages/ui/src/PageHeader.tsx
  - .github/workflows/docs.yml
  - .github/workflows/docs-audit.yml
last-verified: "2026-10-26"
---

# Quality scan 2026-10-26 (run B) — whole repo, weighted to the landings since 2026-10-21

Measured on `origin/dev` @ `b9f9f1e47` (2026-10-26). The window is
`8cc3717c8..b9f9f1e47` → 135 first-parent landings
(`git log --first-parent 8cc3717c8..origin/dev --format=%h | wc -l`); the
2026-10-21 scan had already covered `595b43c07..8cc3717c8`. Method: the
captain in the main checkout for the read-only counts (one of them re-taken
in a pinned worktree, §6); one `sonnet` read-only worker for the GitHub reads
(issues, `ci.yml`, qa-dev at the `money-flow` job level, agent evals; every
number beside its command); the block-1 census through the new mutation
runner in a detached, `npm ci`'d worktree at the scan SHA with core, the SDK
and the signer built, against a disposable database (`haven_scan1026`,
dropped at the end); one hand rig for the single cell the runner cannot drive
(M2, below), behind a `cp` backup restored and proven with `cmp` and
`git diff --quiet`. The worktree ended with `git status --porcelain` → 0 and
no runner journal. GitHub was read-only. No live Haven call was made.

**A concurrent run.** A second scan of the same day — run A, PR #4454,
branch `docs/quality-scan-2026-10-26`, pushed 2026-10-26T20:21Z while this
one was being written — measured the same SHA and window independently. Its
coverage record agrees with this one on every re-measured figure (sizing,
blocks 2–6, workflow archaeology) once one reading here was re-taken in a
clean worktree (§6). The two runs took the same five block-1 census files
with different mutations and reach the same conclusion about them (§5). Three
of this run's first-draft claims were corrected against run A's evidence and
re-verified here (the three 2026-10-21 issues are closed, §4; the smoke red
was fixed by a landing, not a flicker, §2 notes; a bare-fetch allowlist would
not have caught the window's egress incidents, §2 notes), and one candidate
this run had drafted is run A's C1 and is cited as tracked (§3). What this
run adds is two candidates run A does not carry (C1, C2).

**Excluded this run:** every prior finding and candidate, whatever its
disposition — including the 2026-10-21 entry's three candidates (#4215,
#4216, #4217, all `shipped`, §4) and its refusal of the "tests depend on the
machine" pattern, which this window's ten host- or load-dependent test issues
would otherwise re-raise. None is re-surfaced. Candidate C1 below sits beside
the 2026-10-03 S1 (epic #3615, `shipped`): that finding consolidated how each
payment entrypoint spells the typed budget refusal; C1 is a new refusal
reason, added after the epic closed, spelled through the shared builder at
one of its three sites. It is reported as a one-PR candidate, not as a
re-surface — the recorded figure for S1 (9 sites writing the typed code) now
reads 3
(`git grep -h "error_code: 'delegation_budget_exceeded'" origin/dev -- 'packages/backend/src/*' ':!*.test.ts' ':!*__tests__*' | wc -l`
→ 3), so the shipped epic held.

## 1. Structural findings

None in the examined sample. The window's issue record clusters into six
recurring mechanisms (§5, incident clustering); four are untracked by any one
issue, but each has a one-PR remedy or a decided refusal, and none carries a
census that would make it splittable work. The two largest verbatim copies
the duplication census found are both pinned byte-for-byte by a parity test
(§5, cross-package duplication) and are not proposed.

## 2. Improvement candidates (one PR each) — pending the owner's word

### C1 — the x402 legs answer an expired-only budget with a prose-only 403, while the direct route answers the typed body; the shared builder reaches one of three sites

**Opportunity and evidence.** #4352 (landed 2026-10-25, `e778da444`) added
the `delegation_expired` refusal: when the only budget for a token has ended,
the agent is told so with the end date instead of a no-delegation refusal.
The typed body lives in one builder,
`buildExpiredBudgetBody` in
`packages/backend/src/modules/budget-scope/refusal-body.ts:267-300`, which
emits `error_code: 'delegation_expired'`, the taxonomy `phase` and
`next_action`, and the additive wire field `budget_ended_at`. Callers:

- `packages/backend/src/modules/mpp/budget-precheck.ts:383` — the direct
  route. Its tests pin `error_code`, `budget_ended_at` and `next_action`
  (`packages/backend/src/routes/__tests__/budget-precheck.test.ts:422,441,1251`).
- the two x402 legs in
  `packages/backend/src/modules/x402/delegation-authorize.ts` (EIP-3009
  funding at `:475-500`, erc7710 at `:691-715`) call the shared
  `findExpiredBudgetForToken` read and then build the 403 inline as
  `body: { error: '… this budget ended on <date>; ask the owner to set a new one.' }`
  — no `error_code`, no `phase`, no `next_action`, no `budget_ended_at`. The
  ledger row they write does carry the typed detail
  (`expiredBudgetLedgerDetail`); only the wire body is prose. Their tests pin
  the prose and the ledger row, nothing on the body beyond `error`
  (`packages/backend/src/routes/__tests__/x402-delegation.test.ts:1169-1205`).

Counts at the scan SHA:

- `rg -c 'buildExpiredBudgetBody\(' packages/backend/src -g '!*.test.ts' -g '!__tests__'`
  minus the defining file → **1** caller
- `rg -c 'this budget ended on \$' packages/backend/src -g '!*.test.ts' -g '!__tests__'`
  outside `budget-scope/` → **2** inline bodies
- `rg -c "error_code:" … delegation-authorize.ts` → 5, against
  `rg -c "code: 403"` → 7: **5 of the 7** 403 sites in that module carry a
  typed code; the two without are the expired-budget bodies

**By execution (block-1 probes M6 and M7, same edit, two suites).** Changing
the builder's `error_code` to `delegation_budget_exceeded` turns the direct
route's suite red — **3 of 45** (`budget-precheck.test.ts`) — and leaves the
x402 suite green — **119 of 119** (`x402-delegation.test.ts`): the x402 legs
never consume the builder. Diagnosis for M7: *not load-bearing at the tested
condition* — the x402 bodies are built elsewhere.

**Cost.** The hosted MCP keys its budget branch on the backend's `error_code`
(`packages/mcp-server/src/tools/support/quote-response.ts:390-391` compares
to `delegation_budget_exceeded`; the local runtime reads `error_code` at its
error seam), and #3504 made that key the contract. An expired budget on the
x402 path therefore lands in the generic 403 branch with prose the agent has
to parse — the class the 2026-09-21 D2 (#3214) fixed for the generic
branches, re-created for one reason. The spec comment on the
`/x402/authorize` 403 ("Since #4352 there are two shapes") documents the
asymmetry rather than closing it. No incident is recorded; this is observed,
not hypothesised.

**Expected benefit.** One body per refusal reason, whichever entrypoint
answers it, and the agent-facing clients branch on the x402 expired refusal
the same way they branch on the direct one.

**Approximate scope.** One PR, money-path by file: an x402 flavor on
`buildExpiredBudgetBody` (the builder already takes `direct`, `x402`, `mpp`
and `sign-leg` inputs for the period-exceeded body), the two inline sites
routed through it, the x402 tests extended to pin `error_code`,
`next_action` and `budget_ended_at`, and the `/x402/authorize` 403 schema in
the spec gaining the field. The refusal census
(`packages/backend/src/modules/payments/__tests__/refusal-census.test.ts`)
keys on status, not on `error_code`, by its own header, so it is not the
instrument for this; the spec round trip is.

**Verified at scan** (at `b9f9f1e47`): the three greps above (1 / 2 / 5 of 7);
routing for `delegation-authorize.ts`, `refusal-body.ts`,
`x402-delegation.test.ts` and the OpenAPI module → `code backend`;
money-path verdict → `delegation-authorize.ts` money-path, `refusal-body.ts`
money-path, the test and the spec `off` (the positive control, the backend
sweep module, → money-path); mutation recipe → run (M6 caught 3 of 45, M7
survived 119 of 119, cells in the census file in this run's scratch, edits
quoted in §5).

**Verification still needed.** After the change: the same builder edit must
redden both suites; the hosted tool's quote and pay paths answer an expired
x402 budget with the same next step as the direct route (a hosted-suite case,
not only the backend's).

### C2 — the weekly staleness audit ranks dated records as stale docs; two thirds of its last landing appended re-check sections to bug reports

**Opportunity and evidence.** `scripts/docs/audit-staleness.mjs` ranks every
governed doc by commits to its `covers:` since `last-verified`, excluding
only `status: archived` and `status: research` (`:68-73`, `:91`) — the
`research` exclusion's own comment (`:69-72`, #2638) states the principle: a
record of what was true when it ran should not be ranked as stale. Bug
reports are such records, and every one of them declares `covers:` under
`status: current`:

- `for f in docs/bug-reports/*.md; do <front-matter has covers:> && echo x; done | wc -l`
  → **18 of 18**; `status` values → `18 current`
- the audit issue of 2026-10-26 (#4438) lists 15 docs; **10 of the 15** are
  under `docs/bug-reports/` (seven prior quality-scan reports, two
  onboarding-exploration reports, one cold test), ranked first because a
  scan report's `covers:` is the widest in the tree (the 2026-09-25 report
  declares 25 paths; the 2026-10-19 report 27; this one 36 —
  `awk '/^---$/{c++; next} c==1' <doc> | grep -c '^  - '`)
- the landing that closed it, `ba99cdc5d`: `git show --format= --numstat`
  → 14 files, +536/−16; **10 files and +425 of the +536 lines** are bug
  reports, each gaining a "Dispositions re-checked 2026-10-26" section
  appended to a dated report whose body the ledger convention says stays as
  written
- the previous weekly audit's landing, `61c61f3ed` (#3645): 9 files,
  +170/−74; 3 bug reports, +48
- the audit has run 13 times since 2026-07-20
  (`gh issue list --search "Docs staleness audit in:title" --state all`
  → 13 closed issues), and its top-15 refills from the same reports as each
  scan lands a new one — two more today

**Cost.** Observed contributor burden: a weekly batch whose largest share is
re-verifying day-stamped records against code that has legitimately moved on,
and reports that grow a dated appendix per audit. No defect in a live doc is
claimed; the live docs in the same batch (4 of 14 files, +111 lines) are the
audit working as designed.

**Expected benefit.** The audit's top-15 spends itself on live docs; dated
records stop being edited after the day they record.

**Approximate scope.** One PR, outside the money path: the audit (and the
`docs:covers-gaps` governed set, if the owner wants the same boundary)
excludes dated records. Owner decision on the mechanism: a folder rule
(`docs/bug-reports/**`), or a `status: record` value joining `archived` and
`research` in the two exclusion sites — the status route is one line at each
site plus the front-matter of 18 files and the validator's enum. Either way
the bug reports keep their `covers:` for the coupling gate's reverse walk, or
drop it; that is a second decision.

**Verified at scan** (at `b9f9f1e47`): the four counts above (18 of 18; 10 of
15; +425 of +536; 3 of 9); routing for `audit-staleness.mjs` and its test →
`(none)` from `classifyChangedFiles` — the classifier routes the script to
no surface, and it is the `docs.yml` path filter (`scripts/docs/**`,
`.github/workflows/docs.yml:64`) and the weekly `docs-audit.yml` that run it,
so a change is still exercised; money-path verdict → `off` (the positive
control → money-path); mutation recipe → *unrun*: the exclusion the remedy
adds does not exist yet, and the script's self-test is the place for its red.

**Verification still needed.** After the change: the audit's own test gains
the excluded status (or folder) as a fixture case; the next weekly issue's
top-15 names no bug report.

### Verified, held back (notes, not proposed)

- **Egress perimeter — examined, not proposed.** Five issues in four days
  (#4244, #4257, #4281, #4300, #4309) routed one outbound call at a time
  through the SSRF seam
  (`packages/backend/src/infra/http/ssrf-guard.ts`), the SDK's redirect
  follower twice, and no ratchet names the perimeter
  (`gh issue list --search "ssrf ratchet OR \"bare fetch\" OR \"outbound fetch\" in:title"`
  → only #4281). Left outside the seam in backend non-test source:
  `rg -n '(^|[^a-zA-Z_.])fetch\(' packages/backend/src -g '!*.test.ts' -g '!__tests__' --type ts`
  (comment lines dropped) → **5 sites in 3 files** —
  `packages/backend/src/infra/explorer-api.ts` (3),
  `packages/backend/src/infra/prices.ts` (1),
  `packages/backend/src/infra/delegate-alert-webhook.ts` (1) — every one an
  operator-configured host; the SDK's 4 bare-`fetch(` files all import the
  egress policy; 0 tests enumerate fetch sites. This run's first draft
  proposed a shrink-only allowlist ratchet. Run A's wider census (13 files by
  a regex that also sees `fetch` aliases, with positive controls at the two
  remedied sites' parents) reached the same "all operator hosts" reading and
  declined to propose the net, because both of the window's backend
  incidents were URL-source changes at sites that already existed (#4281
  became a hole when #4245 changed where the URLs came from; #4309's site
  predates any net) — a by-file allowlist would have passed both. That
  reasoning holds against this run's counts too; withdrawn. The design
  question run A names (a process-wide default versus the guard's own pinned
  transport) is the owner's, not a bounded candidate.
- **Three block-1 survivors in one landing, all on a display-only column.**
  #4429 (`4a3f56847`) stores `avatar_tint` on agents and threads it through
  three reads. Dropping it from the single-agent read's select list
  (`packages/backend/src/infra/repositories/agents.ts:397`) survives the
  mocked route suite **29 of 29** (M3) *and* the real-DB repository suite
  **39 of 39** (`packages/backend/src/infra/repositories/__tests__/agents.test.ts`,
  hand-run with the same edit): *weak test* at both layers — the route test
  supplies the row, the repository test does not read the column. Dropping it
  from the per-agent spend select
  (`packages/backend/src/infra/repositories/analytics.ts:478`) survives the
  real-DB golden **8 of 8** (M4): *not load-bearing at the tested condition*
  — the golden strips the field by design (`:300-306`), and the "spec round
  trip" its comment says still requires it lives in the mocked route test,
  which never sees the SQL. Answering a constant tint
  (`packages/backend/src/routes/analytics-overview.ts:275` → `1`) survives
  that route test **38 of 38** (M5): *weak test* — fixtures carry tints 1 and
  2, no assertion reads them. Run A mutated the same three files the other
  way — a value outside 1..6 — and each was caught by the spec round trip
  (3 of 29, 1 of 8, 1 of 38). Read together: the wire field is pinned by the
  spec's range alone; its presence and its value are pinned by nothing. Not
  proposed: the column moves no money, and the 2026-09-15 mock-families
  finding (`accepted-as-debt`) already names the shape.
- **One mobile e2e spec is 5 of the window's 7 browser-smoke failures, both
  `dev` reds among them, and two PRs merged over it.**
  `packages/frontend/e2e/analytics-header-wrap.mobile.spec.ts:126` ("at sm
  (640) a very long agent name truncates and does not push the header")
  failed on `dev` from #4403's merge (2026-10-24T14:39Z, run 40103495834)
  through the 10-25T00:03Z run (40145212714), on PR #4403 itself (which added
  it) and PR #4406 at their merge (`gh pr view … statusCheckRollup` →
  `Frontend browser smoke: FAILURE`), and on one docs branch. It went green
  at the first `dev` run after #4409 (2026-10-25T02:07Z, `9c93a8807`, which
  changed `packages/ui/src/PageHeader.tsx` — the spec file itself has one
  commit): a real red, fixed by a landing, not a flicker — this run's first
  draft read it as load-dependent and was wrong. Browser smoke is advisory on
  `dev` by the recorded ruleset decision (required on `main` only; the `dev`
  ruleset's 16 required contexts do not include it), so this is the decided
  cost, not a gate hole; run A counts 9 of the window's 134 readable
  landings merged with the smoke or visual job red at their head (7 visual on
  2026-10-22, plus these two). Recorded as the cost of that decision in this
  window; not proposed.
- **Source-reading guards and comments — probed, clean in the sample.** Eight
  of the window's issues were a guard or classifier misreading source
  (#4284, #4294, #4344, #4379, #4411, #4421, #4315, #4193). A census of the
  guard scripts that read `.ts` source found 29 with no parser import and 3
  importing the shared comment stripper (#4413), but the heuristic cannot see
  a hand-written skipper: `scripts/lint-budget-liveness.mjs` strips comments
  itself (`:234-258`), and a probe that appended a predicate inside a `//`
  comment to a backend file left its gauge unchanged (4 → 4
  `ts-payment-window`). The census is not an instrument. The one executed
  instance of the class this run (the runner's own classifier, M1) is run
  A's C1 (§3).
- **The 21-copy comment.** The most-repeated non-lint comment in non-test
  source is the #1464 pair ("a malformed uuid in the path is a 400 (central
  22P02 mapping …), not a 500"), 21 copies
  (`xargs grep -h '^\s*//' | sort | uniq -c | sort -rn` over non-test `.ts`).
  It restates a central rule at call sites rather than working around one;
  reading cost only, bar 3 — not proposed.
- **Agent evals: 12 of 18 runs failed 2026-10-19 → 10-23**
  (`gh run list --workflow agent-evals.yml --limit 30` → 2 success / 12
  failure / 4 cancelled; 14 `workflow_dispatch`, 3 `pull_request`, 1
  `schedule`). Epic #3957 is closed and nine "Agent evals N" issues in the
  window are its fix wave (tracked); the 2026-10-19 run refused this as an
  open epic, and nothing new is claimed here beyond the count.

## 3. Context for tracked work (not new items)

- **The mutation runner filed a caught cell as mutation-red — run A's C1.**
  Block-1 cell M1 widened migration 121's `CHECK (avatar_tint BETWEEN 1 AND 6)`
  to `… AND 7`; the guard's own test asserts the insert rejects
  (`packages/backend/src/db/migrations/__tests__/121_agents_avatar_tint.test.ts:172-177`),
  the mutant let it through, and the runner classified the cell
  "mutation-red: … Error: promise resolved "Result{ command: 'INSERT', …(9) }"
  instead of rejecting" — vitest's own text for a failed `.rejects`
  expectation, absent from the recorded assertion stems in
  `scripts/ci/prove-red.mjs` (`VITEST_ASSERTION_SHAPE`, #4284). Run A found
  the same shape in its own M1 plus a second (a plain `Error` from the spec
  round-trip helper) and carries both as its C1, pending the owner; this run
  reproduces the first independently and adds nothing. Third unrecorded stem
  in nine days after #4284 and #4294.
- **Host- and load-dependent test reds, 10 issues** (#4126, #4134, #4084,
  #4191, #4192, #4272, #4293, #4297, #4301, #4398): the pattern the
  2026-10-21 run weighed and refused on the repo's recorded decision to keep
  vitest's default timeout (#2319, #2329, #2354). The refusal stands; the
  count is recorded.
- **qa-dev's one scheduled failure in the window** (2026-10-21, both attempts
  on the two EIP-3009 legs, "Haven did not record the merchant settlement …
  within 45s") is the 2026-10-21 C1 (#4215, `shipped` 2026-10-25). The seven
  other scheduled runs 10-19 → 10-26 passed on attempt 1 with 17 legs PASS.
- **Catalog ingestion, 7 issues** (#4245, #4281, #4300, #4341, #4389,
  #4394, #4407): a feature in flight with heterogeneous defects (the egress
  class in the notes, provenance, payability from `accepts[0]`, a per-host
  cooldown rebuilt every tick, write degradation). No epic names it; not a
  scan item.
- **Agent-facing text asserting a false state, 6 issues** (#4061, #4062,
  #4079, #4123, #4345, #4355): the 2026-09-17 next-step class (#3105,
  `shipped`); #4123 is open and standalone; the rest closed at their sites.
- **Docs drift and its leftovers, 12 issues**: #4303, #4372 (parts A–K), the
  "left unfiled" chain (#4371, #4387, #4408, #4415) and the two weekly audits
  (#3645, #4438). C2 is the one mechanism in it this run could measure.
- **Run A's two live signer observations** are #4449 (open); this run made
  no live call and adds nothing to them.

## 4. Dispositions observed (prior items, for the record)

- 2026-10-21 C1 → #4215 closed 2026-10-25T09:07Z → `shipped`; its build
  PR #4222 (`01ffaa494`) merged 2026-10-21T14:11Z with `Refs`, the issue
  closed after its operator check. (This run's first draft wrote "open";
  corrected against `gh issue view`.)
- 2026-10-21 C2 → #4216 closed 2026-10-21T14:18Z via PR #4223 (`715b294bd`)
  → `shipped`.
- 2026-10-21 C3 → #4217 closed 2026-10-21T20:37Z via PR #4230 (`22790a587`)
  → `shipped`.
- 2026-10-19 C1–C4 and the two spec-review siblings: as the 2026-10-21 entry
  records (#4118, #4119, #4120, #4121 shipped; #4122 closed by hand; #4123
  open).

## 5. Coverage record (block → examined / partial / not examined → command → result)

All at `b9f9f1e47` unless stated. Figures in parentheses are the 2026-10-21
entry's, at `8cc3717c8`.

- **sizing** → examined → `git ls-tree -r --name-only origin/dev packages/<p>/src`
  filtered to `.ts|.tsx|.mjs`, split on `.test.|__tests__|.spec.`, each blob
  `git show | wc -l`, summed. The control at `8cc3717c8` reproduces the 10-21
  backend figure 113,538 / 147,443 and frontend 71,713 / 73,900. Now: backend
  119,096 / 158,650 (+4.9 % / +7.6 %); frontend 75,800 / 81,996 (+5.7 % /
  +11.0 %); sdk 19,149 / 21,941; core 25,740 / 945; qa-agent 15,073 / 13,145;
  mcp-server 13,332 / 24,389; signer 5,422 / 8,788; connect 12,436 / 15,676;
  cli 3,207 / 3,609; ops 3,143 / 2,222; ui 2,574 / 2,023; mcp 2,817 / 5,038;
  demo-merchant-mcp 3,788 / 4,210. Largest non-generated source files: the
  OpenAPI module 14,699, the design-system page 4,493, the SDK types 3,183;
  largest route file 1,561 (payments). Fat controllers: examined as this
  census only, no finding.
- **block 1 (guard falsifiability)** → examined. The reference's census
  script → **23 candidate test files over 3 of the last 20 landings**
  (#4429 avatar tint 17, #4435 2, #4378 4); the runner took the first five,
  all from #4429. 5 census cells + 2 probes through
  `node scripts/ci/prove-red.mjs census --issue scan-2026-10-26` in the
  detached worktree, `DATABASE_URL` on the disposable database:

  | # | Guard file | Mutation | Baseline → mutant | Class |
  |---|---|---|---|---|
  | M1 | `121_agents_avatar_tint.test.ts` | `CHECK (avatar_tint BETWEEN 1 AND 6)` → `… AND 7` in the migration | 6 → the CHECK test fails: "promise resolved … instead of rejecting" | runner: **mutation-red**; by the message: the guard's own `.rejects` assertion failed → caught (§3, run A's C1) |
  | M2 | `agents-avatar-tint.db.test.ts` | the held predicate `p_archived_at IS NULL AND p_superseded_by_agent_id IS NULL` → `p_superseded_by_agent_id IS NULL` | 14 → **2 failed** (archived-agent tint free; held-before-released backfill) | **caught** — hand rig on a fresh database (below) |
  | M3 | `routes/__tests__/agents.test.ts` | drop `a.avatar_tint,` from the single-agent read | 29 → **29 passed** | survivor: *weak test* (also 39 / 39 on the real-DB repository sibling) |
  | M4 | `analytics-overview-golden.db.test.ts` | drop `a.avatar_tint,` from the per-agent spend select | 8 → **8 passed** | survivor: *not load-bearing at the tested condition* (stripped by design) |
  | M5 | `analytics-overview.test.ts` | `avatar_tint: a.avatar_tint` → `avatar_tint: 1` | 38 → **38 passed** | survivor: *weak test* |
  | M6 (probe, second copy) | `budget-precheck.test.ts` | builder `error_code: 'delegation_expired'` → `'delegation_budget_exceeded'` | 45 → **3 failed** | **caught** |
  | M7 (probe, second copy) | `x402-delegation.test.ts` | the same builder edit | 119 → **119 passed** | survivor: *not load-bearing* — the x402 legs do not call the builder (C1) |

  Runner summary line: "23 candidate guard files; 5 census mutations + 2
  probes. 1 caught, 4 survived, 0 shadowed, 1 mutation-red, 0 refused, 1 not
  run." Read with the two corrections above: **3 caught (M1 by message, M2
  by hand rig, M6), 4 survived with diagnoses**. M2 could not run under the
  runner: the real-DB harness memoises applied migrations in the worker
  schema (`packages/backend/src/infra/__tests__/helpers/db-harness.ts:25-31`),
  so the runner's green baseline installs the unmutated function and the
  mutant file is never applied; the hand rig ran the baseline on the
  disposable database (14 passed), created a second fresh database, applied
  the one-line edit (occurrence count checked → 1), ran the file cold
  (2 failed / 12 passed), restored by `cp`, proved with `cmp` and
  `git diff --quiet`, and dropped the second database. Run A hit the same
  harness behaviour from the other side (its migration mutant leaked into
  the memoised worker schema after the file restore) and records the same
  remedy — drop the worker schemas, or use a fresh database, around a
  migration mutation. Census files exercised: 5 of 23, plus 2 probe files and
  1 sibling; 18 of 23 not exercised (budget).
- **block 2 (`covers:` completeness)** → examined. The reference loop under
  `bash` with `set -f` (`grep -rl`, `rg` is absent there), each raw miss
  confirmed with `node scripts/docs/coupling-gate.mjs --strict --changed=<path>`
  → **17 across 6 of 8** contract docs (18 across 6 of 8): the x402 sequence
  doc 3, the docs-quality system 2 (its two other raw misses are glob
  strings), the dev-environment runbook 4, the package-dev-channel doc 2,
  the CASP guardrails 5, the security model 1; the runtime-compatibility
  contract 0 (declares 82, cites 88). `npm run docs:covers-gaps` → **124
  baselined pairs across 33 docs** (129 / 35), with the standing warning
  that 2 docs sit outside the governed set. Run A: the same 17 / 6 of 8 and
  124 / 33.
- **block 3 (stale numbers)** → partial. Positive control 3 / 3 specimens.
  The 25 newest shards by dated name (`2026-10-23-4327` … `2026-10-26-4443`)
  → **7 figure-bearing lines, 0 with a command** (9 / 0); 3 of the 7 are
  measured figures ("25 files", "48 of 52", "0 of 12 files"), 4 are not
  (a 1/2/3-link list, a 2/4 slice number, a migration list, a row-limit
  constant). Ledger re-derivations: `any` **39** (38); db-mock gauge
  **54 / 270 / 57** (unchanged); guard scripts **75** (71; the runner, its
  reporter and two others); non-spawning self-tests **25 of 75** (25 of 74);
  zod in the backend 0. One stale comment found by execution (M4's "spec round
  trip", above). Instrument lesson: the shard sample must be expanded with
  `${=S}` in zsh — unquoted `$S` passed the 25 names as one argument and
  read **0** with an "IO error" on stderr; the figure above is the corrected
  run. Run A: the same 7 / 0.
- **block 4 (retired vocabulary)** → examined. Positive control 36 shards.
  **196 files, 47 historical / 149 live** (196 / 46 / 150); the top live
  carriers are the drop-migration test (24), the machine-payments and x402
  route tests (22, 20), the OpenAPI module (16) and the retired-rail routing
  guard (15), all enforcement or history. `npm run lint:retired-rail-prose`
  → green, **32 hits / 30 files** at the scan SHA in a pinned worktree, and
  32 / 30 with this report present (10-21: 30 / 28 — a rise of 2 within the
  ceiling, not re-measured per file). The first reading, taken in the shared
  main checkout, was 34 / 31: the ratchet walks `packages/**`, and the main
  checkout holds a gitignored, build-generated copy of the security-model doc
  under the frontend's public folder that the clean tree does not — its 2
  hits are the whole difference (`scanAll()` from the ratchet, run in both
  roots and diffed by file, §6). Code half: the three x402 repository exports still have
  no non-test importer beyond a comment in the QA runner. Run A: the same
  196 / 47 / 149 and 32 / 30.
- **block 5 (merge-method drift)** → examined. Since 2026-10-19T00:00:00Z →
  **0 merge-commit / 213 squash** (clean); the window `8cc3717c8..` → 135
  squash. Since 2026-08-10T00:00:00Z → 282 / 1,345 of 1,630. Run A: the same.
- **block 6 (nets with holes)** → examined, all four halves → copy lint **64
  unscanned / 4 with hits** (60 / 4; the four are identifier-shaped, in the
  frontend's auth context, chain facts, passkey signer and signer modules);
  money perimeter **32 verb files / 20 outside** (unchanged list); visual
  gate **15 of 27** app routes shot (16 of 28; the 12 unshot: `/`,
  `/account`, the account and agent detail routes, the agent sweep route,
  `/analytics`, `/device`, `/login`, the marketplace detail route,
  `/onboarding`, `/reporting`, `/signup`); docs boundary, pinned with
  `git ls-tree` → **43** (41; +2: the prove-red skill and its command file);
  freshness-gate exit branches unchanged (`Gap 1` :30/:540, `#2164`
  :128/:1090, `qa-override` :41/:150/:423/:493/:536/:1080, `KNOWN LIMIT`
  :131). Probes beyond the reference: the advisory-check merge census (2 of
  the merged PRs in the two date slices that answered carried a red smoke job
  at merge; the 10-25..26 slice answered HTTP 504 twice and was read per PR;
  run A's full read: 9 of 134), and the classifier routing the staleness
  audit to no surface (C2). Run A: the same four halves.
- **incident clustering** → examined (worker). Issues created since
  2026-10-19T00:00:00Z → **172 (161 closed / 11 open)** (run A counted from
  10-21: 119, 10 open); 13 epics, 61 numbered slices; `code-quality` on 2.
  By mechanism, read from titles and bodies: outbound fetch outside the SSRF
  seam 5 (notes); agent-facing text asserting a false state 6; host- or
  load-dependent test reds 10; source parsing guards misreading input 8;
  catalog ingestion 7; docs drift and leftovers 12; EIP-3009 settlement 10
  (epic #4318 scoped to four of them); agent evals 9 (epic #3957). Open PRs
  → 0 at the worker's read (run A's PR #4454 opened after it); open issues →
  18.
- **workflow archaeology** → examined (worker). `ci.yml` newest 100
  (2026-10-24T07:47Z → 10-26T19:46Z) → **72 success / 14 failure / 13
  cancelled**, 1 in progress (run A, minutes later: 73 / 14 / 13); 7 with
  attempt > 1, all feature branches; on `dev` 34 → 28 / 2 / 4, both failures
  the browser-smoke spec in the notes. Failing jobs over the 14 failures:
  browser smoke 7, visual regression 7, lint-type-build 2, SDK checks 1,
  CI-config checks 1. qa-dev at the `money-flow` job level: newest 30 runs
  (all `deployment_status`, 10-26) → ran in **6 (6 success, each on attempt
  1/2 with 17 legs PASS)**, skipped in 24; scheduled runs 10-19 → 10-26 → 7
  success / 1 failure (10-21, §3). Run A read 615 runs since 10-21 at the
  job level: 77 success / 3 failure / 535 skipped, the 3 the tail of the
  #4215 red. `agent-evals.yml` → 18 runs, 2 / 12 / 4 (notes).
- **comment archaeology** → examined → `git grep -c -w -E 'TODO|FIXME|HACK|XXX' origin/dev -- 'packages/*/src/*'`
  → **0** (control `import` → 2,175 files); the repeated-comment census is in
  the notes.
- **cross-package duplication** → examined as a census: 10-line normalised
  windows over 1,216 non-test source files → **52 file pairs** share at
  least one window, **11 cross-package**. The largest, 431 windows between
  `packages/frontend/src/lib/agent-skill-bundle.ts` and
  `packages/sdk/src/skill-content.ts`, is a deliberate copy pinned
  byte-for-byte by a parity test (both headers say so; 31 of the 74 commits
  touching either touched both); the second (48, the backend's payment
  taxonomy mirror of the SDK) is parity-tested the same way. Next: the
  agent-/owner-facing task-budget routes (24), sub-budget routes (12), the
  two MCP HTTP servers (11), the two credential modules (10). None proposed:
  no incident, and the two large ones are guarded.
- **validation and contract enforcement** → partial: the request-validation
  enforce list read (born-enforced modules only); no census of the shadow
  residue this run.
- **data-layer coverage** → not examined beyond the db-mock gauge.
- **live exercise** → not taken (a tree scan by brief).
- **novelty** → the tracker was searched per candidate (queries in each
  section); the ledger and bug reports were grepped for each candidate's
  terms (`audit-staleness`, `delegation_expired`, `ssrf`, `bare fetch`);
  run A's report and ledger entry were read in full for overlap;
  bug-report bodies were not otherwise re-read.

## 6. Instrument lessons from this run

- A gauge that walks the filesystem must run in a pinned worktree, not the
  shared main checkout: the retired-rail prose ratchet read 34 / 31 there
  and 32 / 30 at the same SHA in a clean worktree, and `git status` showed
  nothing — the extra file is a gitignored, build-generated copy of a doc
  under the frontend's public folder (`git status --ignored` shows it;
  `scanAll()` diffed between the two roots names it). The
  reviewer-own-root rule applies to the scan's own counts.
- The runner cannot drive a migration-body mutation whose test goes through
  the memoising harness: its green baseline applies the unmutated migration
  and the mutant never reaches the database. Give such a cell a test that
  re-applies the migration itself (the 121 test's own down/up is why M1
  worked), or hand-rig it on a fresh database and say so.
- A failed `.rejects` expectation reads as mutation-red (run A's C1). Read
  the message before trusting the class.
- In zsh, `rg … $S` with a newline-separated list in `$S` passes one
  argument; use `${=S}`. The first block-3 reading was 0 for that reason.
- `gh pr list --json statusCheckRollup` over ~200 merged PRs answers HTTP 504
  from GraphQL; slice the search by `merged:` date ranges.
- `gh api …/jobs/<id>/logs` prints nothing without `--allow-escape-sequences`.
- The dimensions reference changed under the scan (the fast-forward brought
  the prove-red rewrite of block 1); re-read it after moving the checkout.
- The classifier's `(none)` for a `scripts/docs/**` file is not "unexercised":
  `docs.yml` has its own path filter.
- Two scans of one day collide on the report path and the ledger's one
  append point; read the other before presenting, name it, and reconcile
  item by item rather than presenting a duplicate as new.

## 7. Decisions requested

1. C1 — file (one PR, money-path): the x402 legs' expired-budget 403 through
   the shared builder, typed fields pinned in the x402 suite, spec updated.
2. C2 — file (one PR): dated records leave the staleness audit; the owner
   picks the mechanism (folder rule, or a `record` status) and whether bug
   reports keep `covers:`.
3. The notes (the egress perimeter, the three display-column survivors, the
   smoke spec): not proposed. The runner's `.rejects` stem is run A's C1 and
   is decided there.
