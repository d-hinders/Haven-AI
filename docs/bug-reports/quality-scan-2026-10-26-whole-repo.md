---
owner: "@d-hinders"
status: current
covers:
  - scripts/ci/prove-red.mjs
  - scripts/ci/prove-red.test.mjs
  - .agents/skills/prove-red/SKILL.md
  - packages/backend/src/openapi/response-shape.ts
  - packages/backend/src/infra/__tests__/helpers/db-harness.ts
  - packages/backend/src/db/migrations/121_agents_avatar_tint.ts
  - packages/backend/src/db/migrations/120_payment_intents_failed_at.ts
  - packages/backend/src/db/migrations/__tests__/121_agents_avatar_tint.test.ts
  - packages/backend/src/db/migrations/__tests__/120_payment_intents_failed_at.test.ts
  - packages/backend/src/infra/repositories/__tests__/agents-avatar-tint.db.test.ts
  - packages/backend/src/infra/repositories/analytics.ts
  - packages/backend/src/routes/__tests__/agents.test.ts
  - packages/backend/src/routes/__tests__/analytics-overview-golden.db.test.ts
  - packages/backend/src/routes/__tests__/analytics-overview.test.ts
  - packages/backend/src/routes/__tests__/dashboard.test.ts
  - packages/backend/src/routes/analytics-overview.ts
  - packages/backend/src/routes/dashboard.ts
  - packages/backend/src/openapi/spec.ts
  - packages/backend/src/infra/http/ssrf-guard.ts
  - packages/backend/src/modules/catalog/probe.ts
  - packages/backend/src/modules/catalog/catalog-discovery.ts
  - packages/backend/src/modules/catalog/merchant-catalog.ts
  - packages/backend/src/modules/accounting/receipt-underlag.ts
  - packages/signer/src/tools.ts
  - packages/signer/src/next-step-characterization.test.ts
  - packages/signer/src/x402-binding-rail.test.ts
  - packages/signer/src/server.test.ts
  - packages/signer/src/direct-sign-fallback.test.ts
  - packages/mcp-server/src/tools/catalog-purchase.ts
  - packages/mcp-server/src/tools/state-direct-recovery.ts
  - scripts/ci/qa-freshness.mjs
  - scripts/docs/coupling-gate.mjs
  - .github/workflows/ci.yml
  - .agents/skills/quality-scan/references/dimensions.md
  - packages/backend/src/rails/sweep.ts
last-verified: "2026-10-26"
---

# Quality scan 2026-10-26 — whole repo, weighted to the landings since 2026-10-21

Scope (owner request 2026-10-26, no scope named): the whole repository,
weighted toward the 135 first-parent landings on `dev` since the 2026-10-21
scan's revision (`git rev-list --first-parent --count 8cc3717c8..b9f9f1e47` →
135). They include the remedies of the 2026-10-21 candidates (#4222, #4223,
#4230); the new mutation runner `prove-red` (#4240) and its three classifier
and host fixes (#4286, #4295, #4299); the egress fixes #4255, #4269, #4287,
#4314 and #4317; the signer's settlement-child binding (#4247, #4256); the
agent-page, transactions, analytics, settings, budget-end-date and agent-colour
epics; and 17 documentation re-verification landings (`grep -c "re-verify"`
over the window's subjects → 17).

Measured on `origin/dev` @ `b9f9f1e47` (2026-10-26) in the worktree of branch
`docs/quality-scan-2026-10-26`, by one agent, one heavy job at a time. The
checkout was `npm ci`'d, and core, the SDK, the signer and the local MCP were
built. The block-1 census and one follow-up probe ran through
`node scripts/ci/prove-red.mjs` (its own backup, restore and sha256 check). One
further mutation and three temporary probe lines were made by hand, each behind
a `cp` backup in the session scratchpad, restored with `cp` and checked with
`cmp` and `git diff --quiet`. Real-database runs used a disposable
`haven_qs1026` database, dropped at the end. GitHub was read through `gh` only
(issues, PRs, runs, job logs, the `dev` ruleset). No MCP, dev or prod call was
made. `git status --porcelain` → 0 lines before the report was written.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. None is re-surfaced. The re-measurable deltas are in §5; none
worsened materially. The two live signer observations in the brief are
tracked as #4449 (§3) and are not presented here.

## 1. Structural findings

None in the examined sample. Two clusters were weighed: 15 of the 119 issues
filed in the window are test tooling (§5, incident clustering), and 5 are
egress (§2 notes). Both were refused at this level. The tooling issues have
several mechanisms, each already fixed per site; under a hostile host
environment the `scripts/ci` self-tests ran 1778 / 1778 green (§5, block 6).
The egress class has one mechanism, but no executed census shows a live
instance at the SHA (§2 notes).

## 2. Improvement candidates (one PR each) — pending the owner's word

### C1 — `prove-red` reads the backend's two commonest failing-assertion shapes as "mutation-red", so 4 of this run's 7 cells were reported "not counted; fix the mutation" when the guard's own assertion had failed

- **Observed by execution.** This run's block-1 census
  (`node scripts/ci/prove-red.mjs census --issue qs1026 --candidates <census file>`,
  five backend census cells and two probes, §5 block 1) printed **5
  mutation-red, 1 caught, 1 shadowed**. Four of the five mutation-red cells
  were reds on the guard's own check, read from each mutant's vitest JSON
  report:
  - M1 (migration 121's CHECK widened to 1..7). The named test
    `the CHECK refuses a tint outside 1..6` failed with
    `Error: promise resolved "Result{ command: 'INSERT', …(9) }" instead of rejecting`.
    That is vitest's own `.rejects` failing. The sibling schema pin failed
    with an `AssertionError` (`… to contain '6'`) in a test the cell did not
    name.
  - M3 (the Agent schema's `avatar_tint` range moved to 7..7). Three tests
    failed, all with
    `Error: Response from GET|PUT|POST /agents… does not match the '200'|'201' schema in openapi/spec.ts`.
    That is the backend's `expectMatchesSpec` (#1444), which throws a plain
    `Error`.
  - M5 (`avatar_tint` dropped from the analytics agent item): the named
    full-payload spec test failed with the same `expectMatchesSpec` message.
  - P1 (the dashboard emits `avatarTint: 0`): a sibling spec-shape test
    failed with the same message.
  - The fifth, P2, is a real mutation-red (below, notes).
- **Why.** The runner counts a vitest failure as an assertion only when its
  first line matches `VITEST_ASSERTION_SHAPE`, an allowlist of message stems
  (`scripts/ci/prove-red.mjs:254-255`): `AssertionError`, `Error: expect(`, and
  the Testing Library stems #4284 added. Any other `Error:` reads as code
  throwing. That is fail-closed by design: "an unrecorded query shape reads as
  an error, so a new one is added with a recorded fixture case"
  (`.agents/skills/prove-red/SKILL.md`, § *Classes*). The matcher, executed on
  the observed first lines
  (`node -e 'import("./scripts/ci/prove-red.mjs").then(m => … m.VITEST_ASSERTION_SHAPE.test(s))'`):
  - `Error: promise resolved "…" instead of rejecting` → `false`;
  - `Error: Response from GET /agents/{id} does not match the '200' schema …` → `false`;
  - control `AssertionError: expected 1 to be 2` → `true`;
  - control `Error: expect(element).toHaveClass("x")` → `true`.
  `git grep -n -E "promise resolved|instead of rejecting|does not match the"`
  over the runner and its self-test → 4 lines, none about either shape (three
  restore messages and one self-test assertion on a restore message).
- **Reach.** `expectMatchesSpec(` → **53 test files / 199 call lines, all
  `packages/backend`**. Command:
  `git grep -l -P '(?<![\w-])expectMatchesSpec\(' b9f9f1e47 -- 'packages/*.test.ts'`;
  control `expectMatchesSpecX(` → 0. `.rejects.` → 156 test files / 598
  lines across packages, 85 files in the backend
  (`git grep -l -F '.rejects.' b9f9f1e47 -- 'packages/*.test.ts' 'packages/*.test.tsx'`).
  Only the resolved-promise arm of `.rejects` produces the unrecorded stem: a
  wrong rejection fails as an `AssertionError`. How many of the 598 lines
  guard an expected rejection, as M1's does, was not counted.
- **The cost.** `prove-red` is the runner ship-next's *Implement* step 5 and
  `haven-reviewer`'s `verify` use for every new assertion. A cell that its
  guard catches through either shape exits 1 with "not counted; fix the
  mutation and re-run", and the author is pointed at the mutation, not at the
  classifier. This is the third unrecorded idiom in five days. The other
  two were found and fixed one at a time: #4284, the frontend's jest-dom and
  Testing Library stems (PR #4286, 2026-10-22), and #4294, Playwright's
  custom-message `expect` (PR #4295, 2026-10-22). How many shipped PRs in the
  window met this shape was not measured.
- **Tracking.** `gh issue list --state all --search 'prove-red in:title'` → 5
  issues (#4234, #4284, #4294, #4297, #2004), none about either shape. Ledger
  and `docs/bug-reports/` → 0 hits for `expectMatchesSpec` with `prove-red`.
- **Expected benefit.** A backend guard caught through `expectMatchesSpec` or
  a resolved-promise `.rejects` reads as caught. The author and the reviewer
  stop rewriting a mutation that worked, and the census table stops
  under-reporting caught guards. This run's table read 1 caught; by hand the
  catches are 5 (M1, M3, M4, M5, P1).
- **Scope.** One PR. Either record the two stems in `VITEST_ASSERTION_SHAPE`
  with a fixture case each, as the skill prescribes, or have
  `expectMatchesSpec` throw an `AssertionError`
  (`packages/backend/src/openapi/response-shape.ts:148`). That second option
  covers its 199 call lines without a stem, but it is a backend test-helper
  change. The `.rejects` stem needs the runner in either case.
- **Verified at scan.**
  - The criterion greps above → 53 files / 199 lines, and 156 / 598.
  - The matcher on the four first lines → `false`, `false`, `true`, `true`.
  - Routing (`classifyChangedFiles`): `scripts/ci/prove-red.mjs`,
    `scripts/ci/prove-red.test.mjs` and `.agents/skills/prove-red/SKILL.md` →
    `(none)`. They are tested by the always-run *Repo CI config checks* job
    (`node --test scripts/ci/*.test.mjs`, `.github/workflows/ci.yml:91`).
    `packages/backend/src/openapi/response-shape.ts` → `code backend`.
  - Money-path matcher → all four `off`; control `sweep.ts` `money-path`.
  - Mutation recipe built once and run: this census (M1, M3, M5, P1 are the
    specimens).
- **Verification still needed.** Re-run the four cells (the cells file is in
  the session scratchpad and can be handed on): each must read `caught`. A
  self-test fixture per stem, red when the stem is removed. A plain code
  throw inside a spec-shape test, say a `TypeError` before the helper runs,
  must still read as an error.

### Verified, held back (notes, not proposed)

- **Migration-file mutations and the real-DB harness.** P2 (migration 120's
  `failed_at` restored as `TIMESTAMP`, and first as `TEXT`) could not run to
  a class. The worker schema `test_w1` is reused across runs. The harness
  refused it as "ALREADY off migration head … inherited drift" (#2622), and
  `prove-red` printed "the run exited 1 without a failing test". Reproduced
  once by hand, then restored. The census also showed the other side. After
  M2's verified file restore, `test_w1`'s `agent_holds_avatar_tint` body was
  still the mutant's `SELECT p_archived_at IS NULL`
  (`psql -tAc "select prosrc from pg_proc where proname='agent_holds_avatar_tint' and pronamespace='test_w1'::regnamespace"`).
  A run of both tint test files over it raised no drift and passed 20 / 20.
  The body read correct again only after that run, because its backfill
  tests re-apply migration 121. The fingerprint is table columns and indexes
  (`db-harness.ts:603`). Routines are in 1 of 121 migrations
  (`git grep -l -i -P 'CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER)'` → 1)
  and CHECK constraints are in 37. The leak is narrow and was observed once,
  so it is not proposed. A builder who mutates a migration should drop the
  `test_w*` schemas after the run.
- **Egress: one invariant, written per site.** "A URL a third party chose is
  fetched only through the SSRF guard" is stated in two issue bodies
  (#4281, #4309, both filed by hand from reading, 2026-10-22 and 10-23). It is
  also written as a warning in three places: the `probe.ts` header,
  `ownership.ts:511`, and `probe.test.ts:217`'s "uses the SSRF guard, never a
  bare fetch". #4281 notes "the repo has no `setGlobalDispatcher` or any other
  process-wide guard" (`git grep -n setGlobalDispatcher b9f9f1e47 -- packages`
  → 0). The census of global-`fetch` reach in backend source finds 13 files
  (`git grep -n -P '(?<![\w.])fetch\(|(=|\?\?)\s*fetch\b(?!\w)' <sha> -- 'packages/backend/src/*' ':!*.test.ts' ':!*__tests__*'`,
  distinct files). Positive control: 15 at `c966ff81c^` and 14 at
  `dd33c4ef7^`, so it finds both remedied sites at their parents. By
  reading, every one of the 13 reaches a fixed or operator-configured host:
  the accounting providers, the explorer, the price API, the alert webhook,
  ops and the Bazaar index. That was not executed. Not proposed, because the
  cheap net would have caught neither incident. Both sites already existed:
  #4281 became a hole when #4245 changed where the URLs came from, and
  #4309's site predates any net. A process-wide default would have caught
  both, but the guard uses its own pinned transport, not undici
  (`ssrf-guard.ts:279`), so that is a design question for the owner, not a
  bounded candidate.
- **A guard whose title its test cannot fail.** M2 (supersession dropped from
  the one held predicate) came back *shadowed*. `a superseded agent's tint is
  free for the next new agent …` stayed green, and only a backfill test went
  red. Diagnosis: *not load-bearing at the tested condition*. After the
  supersede, the replacement holds the predecessor's tint 1, so whether the
  predecessor still holds 1 changes nothing the test reads: tint 2 is free
  either way. #4448 (open, `pending-review`) reopens this same held rule, so
  this is context for it (§3).

## 3. Context for tracked work (not new items)

- **#4449** (open, `pending-review`) holds both live signer observations from
  the brief. The tree instruments agree with it:
  - `next-step-characterization.test.ts`, `x402-binding-rail.test.ts` and
    `server.test.ts` → 3 files / 68 tests green. The characterization file
    pins the *refusal* wire only (#3103). Its five sites are `sign-context.ts`
    refusals.
  - Three temporary probe lines printed the keys of successful results:
    `haven_sign` on a direct `payment_id` → `signature`; `haven_sign` on an
    erc7710 settlement child → `signature,x402_binding`; `haven_sign_x402` on
    a funding leg → `accepted,payment_header,retry_headers,signature,x402_binding`.
    So in the tree too, a successful x402 sign names no next step.
  - `tools.ts:386-389` carries the #4242 clause ("on the EIP-3009 bridge
    only … haven_submit with settlement_scheme 'erc7710' returns the
    header"). The hosted catalog prepare's erc7710 guidance names
    `haven_settle_mcp_tool` and says "Do NOT pass payment_header"
    (`catalog-purchase.ts:979-991`). `haven_submit`'s erc7710 branch is
    documented as the plain-HTTP flow's, "the MCP flow's equivalent lives in
    haven_settle_mcp_tool" (`state-direct-recovery.ts:933-936`).
  - `server.test.ts:218` pins only `'Next: call mcp__haven__haven_submit'`.
    The `NO_FUNDING_LEG` reasons in `x402-binding-rail.test.ts:310-326` pin
    `haven_submit` as literals.
  - Runtime identity: `~/.haven/agents/<id>/signer-runtime.json` →
    `0.8.1-alpha.0` for the prod agent, `0.10.0-alpha.0` for the qa-dev and
    test-dev pairs. `npm view @haven_ai/signer dist-tags` → `alpha` and
    `latest` `0.11.0-alpha.0` (published 2026-10-23, `gitHead` `9a586ba0c`,
    which contains #4247), `dev` `0.0.0-dev.202610260823.6a4f13e`. Neither
    installed runtime carries the #4242 clause
    (`grep -rl 'has no header step'` over each runtime's `dist` → 0). The
    lag is the stale-runtime class (#3119), recorded as context only.
- **#4448** — the shadowed M2 guard above sits on the rule this issue
  reopens.
- **The 2026-10-24 `dev` red was on an advisory check.** #4403 merged at
  14:39:43Z. Its own *Frontend browser smoke* run (40103118915, head
  `079842488`) completed red at 14:43:33Z: the new
  `analytics-header-wrap.mobile.spec.ts:126` test "the title keeps its width".
  `dev` stayed red on that test until #4409 (2026-10-25 02:07Z). Over all
  134 readable landings of the window, 9 merged with *Design visual
  regression* or *Frontend browser smoke* red at their head (7 visual on
  2026-10-22, during the #4275 baseline drift; #4403 and #4406). Neither check
  is required on `dev`
  (`gh api repos/d-hinders/Haven-AI/rules/branches/dev` → 16 required
  contexts, neither among them). That is the recorded design, advisory on
  `dev` and required on `main` (epic #2632; `ship-playbooks/frontend.md`
  § *Required checks*), so it is not proposed.

## 4. Dispositions observed (prior items, for the record)

- 2026-10-21 **C1** → #4215 closed 2026-10-25 → **`shipped`**. Its build
  landed as PR #4222 (`01ffaa494`, 2026-10-21, `Refs`). The issue was closed
  after its operator check, a qa-dev run with `money-flow` green on both SDK
  legs (run 40176226910, quoted in the issue). Re-measured here: §5,
  workflow archaeology.
- 2026-10-21 **C2** → #4216 closed 2026-10-21 by PR #4223 (`715b294bd`) →
  **`shipped`**.
- 2026-10-21 **C3** → #4217 closed 2026-10-21 by PR #4230 (`22790a587`) →
  **`shipped`**.

## 5. Coverage record (block → examined / partial / not examined → command → result)

- **sizing** → examined. The 09-22 command pinned with `git ls-tree`/`git show`
  at `b9f9f1e47`. Control at `8cc3717c8`: backend 113,538 / 147,443 and
  qa-agent 14,550 / 12,678, both reproduced. Lines, source / test:
  - backend 119,096 / 158,650 (+4.9 % / +7.6 %);
  - frontend 75,800 / 81,996 (+5.7 % / +11.0 %);
  - sdk 19,149 / 21,941; core 25,740 / 945 (tests +41 %, from 669);
  - qa-agent 15,073 / 13,145; mcp-server 13,332 / 24,389;
  - signer 5,422 / 8,788; connect 12,436 / 15,676 (unchanged); cli 3,207 /
    3,609; ops 3,143 / 2,222; ui 2,574 / 2,023; mcp 2,817 / 5,038;
    demo-merchant-mcp 3,788 / 4,210 (unchanged).
- **block 1 (guard falsifiability)** → examined. The reference's census
  script at `b9f9f1e47` → **23 candidate test files over 3 of the last 20
  landings** (#4433, #4441, #4404, each touching a money-path file). The
  first five, newest landing first, are all #4433's. Five census cells and
  two probes, run by
  `node scripts/ci/prove-red.mjs census --issue qs1026` with
  `DATABASE_URL` set to the disposable database. The runner's class comes
  first, then the reading from the mutant's JSON report:
  - M1 — migration 121's CHECK `BETWEEN 1 AND 6` → `1 AND 7`. Runner:
    mutation-red. By hand: **caught**, 2 red of 6 (the named `.rejects` test
    and the at-head schema pin's `AssertionError`). C1.
  - M2 — the held predicate loses `AND p_superseded_by_agent_id IS NULL`.
    **Shadowed**, 1 red of 14. Diagnosis *not load-bearing at the tested
    condition* (§2 notes).
  - M3 — the Agent schema's `avatar_tint` → `minimum: 7, maximum: 7`.
    Runner: mutation-red. By hand: **caught**, 3 red of 29, all
    `expectMatchesSpec`. C1.
  - M4 — analytics per-agent `COUNT(pi.id)` + 1. **Caught**, 1 red of 8
    (the golden).
  - M5 — `avatar_tint` removed from the analytics agent item. Runner:
    mutation-red. By hand: **caught**, 1 red of 38 (`expectMatchesSpec`). C1.
  - P1 (second copy of M3's guard) — the dashboard emits `avatarTint: 0`.
    Runner: mutation-red. By hand: **caught, held elsewhere**, 1 red of 15.
    A sibling spec-shape test failed, not the one named.
  - P2 (count-only pin) — migration 120's `down()/up()` restore test asserts
    only `toHaveLength(1)`. The mutation `failed_at TIMESTAMPTZ` → `TEXT`,
    then → `TIMESTAMP` (`prove-red mutate --issue qs1026p2`), was refused
    both times by the harness's drift guard. **Not run to a class** (§2
    notes).
  - Every restore was verified by the runner (sha256 and an empty
    `git status --porcelain`) → 0 lines at the end.
  - Census files exercised: 5 of 23, plus the two probe files. Not
    exercised: the other 16, all frontend or backend fixture-only changes
    from #4433, #4441 and #4404 (budget).
- **block 2 (`covers:` completeness)** → examined. The reference loop under
  `bash` with `set -f` → 19 raw misses over 8 contract docs, 2 of them glob
  strings (dropped). Each of the other 17 was confirmed with
  `node scripts/docs/coupling-gate.mjs --strict --changed=<path>`. None names
  the loop's doc (control `--changed=packages/backend/src/rails/sweep.ts` → 9
  docs named) → **17 across 6 of 8**: x402 sequence 3, docs-quality system
  2, dev-environment 4, package-dev-channel 2, CASP guardrails 5 (10-21: 6),
  security model 1. `npm run docs:covers-gaps` → 124 baselined pairs / 33
  docs (10-21: 129 / 35). The same 2 docs are outside the governed set.
- **block 3 (stale numbers)** → partial.
  - Positive control: 3 / 3.
  - The 25 newest shards (`2026-10-23-4327` … `2026-10-26-4443`) → **7**
    figure-bearing lines, **0** with a command (10-21: 9 / 0).
  - One shard figure re-derived and matching: #4394's "classified 0 of 12
    files at its head `ea8b8210`". `gh pr view 4393 --json files` → 12, head
    `ea8b8210`. The globs at `9ae7777b0^` (before #4434) → 0 of 12
    money-path, control `sweep.ts` `true`.
  - `any` 38 → 39. The regex counts prose; the window adds one code line,
    `} as any)`, in a test helper outside the `test` glob
    (`telemetry/__tests__/helpers/kit-analytics-probe.ts`).
  - db-mock gauge 54 / 270 / 57 (unchanged).
  - Guard scripts 71 → 75
    (`ls scripts/*.mjs scripts/{ci,docs}/*.mjs | grep -v '\.test\.' | wc -l`);
    self-tests 74 → 75. Non-spawning self-tests not re-derived.
  - Zod in backend source 0.
- **block 4 (retired vocabulary)** → examined.
  - Positive control: 36 shards.
  - 196 files, 47 historical / 149 live (10-21: 196 / 46 / 150). The file-set
    diff against `8cc3717c8`: +1 historical (the 10-21 report) and −1 live
    (`settings/SettingsClient.tsx`, gone with the Settings rework).
  - `npm run lint:retired-rail-prose` → 32 hits / 30 files (10-21: 30 / 28).
    Green, below baseline.
  - Code half unchanged: `failPendingX402Intent` only its defining file; the
    other two have one QA-agent comment line each.
- **block 5 (merge-method drift)** → examined at `b9f9f1e47`.
  - Since 2026-10-21T00:00:00Z → 0 merge-commit / 139 squash (clean).
  - `8cc3717c8..b9f9f1e47` → 0 / 135; every subject ends in `(#N)`.
  - Since 2026-08-10T00:00:00Z → 282 / 1,345 of 1,630 (282 unchanged).
- **block 6 (nets with holes)** → examined, four halves.
  - Copy lint: 64 unscanned / 4 with hits (10-21: 60 / 4).
  - Money perimeter: 32 verb files / 20 outside (unchanged).
  - Visual gate: 15 of 27 app routes shot (10-21: 16 of 28; `/profile`
    merged into Settings).
  - Docs boundary, pinned: 43 (10-21: 41; the two new prove-red files,
    `.agents/skills/prove-red/SKILL.md` and `.claude/commands/prove-red.md`).
  - Freshness-gate exit-branch grep: 14 lines (unchanged).
  - Probes beyond the reference:
    - the host-environment class: `node --test scripts/ci/*.test.mjs` →
      1778 / 1778 in this shell, and 1778 / 1778 again under `umask 0002`,
      `TZ=Pacific/Kiritimati`, `LC_ALL=C`;
    - the egress census (§2 notes);
    - the advisory-check merge census (§3).
- **incident clustering** → examined. Issues created since
  2026-10-21T00:00:00Z → **119** (109 closed / 10 open). Classed by a title
  regex, then by hand:
  - product UI epics and slices 62;
  - test tooling 14 (preflight 4, prove-red 4, host-environment 4, the
    comment-stripper pair #4411 / #4421, …);
  - documentation drift 13 (the #4303 / #4372 re-verification waves and
    their stale-wording follow-ups, plus the weekly audit);
  - egress 5 (#4244, #4257, #4281, #4300, #4309);
  - catalog 5; signer / x402 4; the 10-21 candidates 3; agent evals 2;
  - other 11.

  Recurring within the window: the egress mechanism, twice in two days and
  fixed per site (§2 notes), and the prove-red classifier, twice plus this
  run's C1. One deploy incident: #4413's typescript-importing comment
  stripper in the core barrel crashed hosted-MCP dev deploys, fixed by #4420
  and guarded by #4421.
- **workflow archaeology** → examined.
  - `ci.yml`, newest 100 (2026-10-24T07:47Z → 10-26T19:46Z) → 73 success /
    14 failure / 13 cancelled. 7 had attempt > 1, on 7 feature branches.
  - `dev`: 35 runs → 29 / 2 / 4. Both failures were the #4403 smoke test
    (§3).
  - The 14 failures by failed job: browser smoke 7, design visual regression
    7, Lint/Type-check/Build 2, Repo CI config 1, SDK checks 1.
  - qa-dev at the `money-flow` job level. All qa-dev runs
    `--created '2026-10-21T00:00:00Z..2026-10-26T23:59:59Z' --limit 1000` →
    615 (606 `deployment_status`, 6 `schedule`, 3 `workflow_dispatch`);
    `money-flow` 535 skipped, **77 success, 3 failure**.
  - The 3 failures are the last three of the 10-21 C1 red (10-21 06:44Z →
    08:29Z, before #4222). The first green is job 119722742452 (10-22
    08:32Z). The newest read is 10-26 19:50Z, 4 minutes after the scan SHA's
    commit.
  - All 77 green jobs' logs read: **77 passed on attempt 1/2, 0 on 2/2, 0
    `• … FAIL` lines**. Positive control: failed job 119120448025 → 4 FAIL
    lines and an attempt-2 group.
- **comment archaeology** →
  `git grep -l -w -E 'TODO|FIXME|HACK|XXX' b9f9f1e47 -- 'packages/*/src/*'`
  → 0 files (control `import` → 2,175 files). The egress rule is written as a
  warning in three places (§2 notes).
- **live exercise** → not taken by this agent (no MCP, dev or prod call).
  Runtime identity for the captain's own live calls is recorded in §3; the
  observations are #4449's.
- **SKILL step 3's unnumbered probes** →
  - fat controllers: not examined.
  - data-layer coverage: not examined as a census; the db-mock gauge was
    re-read.
  - validation / contract enforcement: partial (the spec-shape guards of
    M3, M5 and P1 were exercised).
  - cross-package duplication: not examined.
- **novelty** → tracker searched per item:
  - C1: `prove-red in:title`;
  - the migration note: `"worker schema" function`, `prove-red migration`,
    `schema drift routines`, `inherited drift`;
  - the egress note: `setGlobalDispatcher`, `"bare fetch"`, `ssrf in:title`,
    `egress allowlist`.

  The ledger and `docs/bug-reports/` were grepped for each item's terms.
  Bug-report bodies were not otherwise re-read.

## 6. Instrument lessons from this run

- `prove-red`'s census table is the runner's class. Read each mutant's
  `.report` JSON before quoting caught counts: this run's table said 1
  caught where the guards had caught 5 (C1).
- A migration-file mutation is unsafe under the real-DB harness. The worker
  schema persists across runs, so a column-type mutant is refused as
  inherited drift, and a routine mutant outlives the file restore unseen
  (§2 notes). Drop `test_w*` before and after such a cell.
- `git grep -E` with `\b` silently matched nothing (`CHECK` → 0 files where
  `-P` gives 39). Use `-P` for word boundaries, with a control.
- `rg` resolves only in the harness's zsh, not in `bash -c`. Run block 3
  under zsh with an array, or the second count prints nothing.
- The census sample is all one landing when the newest money-path landing
  has more than five test files. Here all five census cells were #4433's.

## 7. Decisions requested

1. **C1**: file as a standalone task, accept it as debt, or reject it. If
   filed, choose the remedy: stems in the runner, or an `AssertionError`
   from `expectMatchesSpec`.
2. The notes in §2 are not proposed. Say if any should be, in particular
   the egress question: a process-wide default, or per-site guards as today.

Nothing was filed. On approval the ledger decision goes in a **separate**
pull request and the handoff is `new-task`, per the skill.
