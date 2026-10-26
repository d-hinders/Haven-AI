---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/__tests__/no-raw-error-details.test.ts
  - packages/backend/src/modules/mpp/budget-precheck.ts
  - packages/backend/src/modules/mpp/sweep.ts
  - packages/backend/src/modules/ops/__tests__/onchain.test.ts
  - packages/backend/src/modules/x402/delegation-authorize.ts
  - packages/backend/src/routes/accounting.ts
  - packages/backend/src/routes/payments.ts
  - packages/mcp-server/src/tools/plain-http-x402.ts
  - packages/mcp/src/tools.ts
  - scripts/docs/coupling-gate.mjs
last-verified: "2026-10-26"
---
> **Recovered 2026-10-14 (#3926).** This report was written on 2026-10-03 by the scan session and was never committed; the ledger's 2026-10-03 entry named this path. It is restored verbatim from that session's record of the write, with two changes only: the local checkout path is removed, and the two figures the #3621 review corrected carry a one-line note beside them (the numbers themselves are as measured at `b00d75bd7`). Every figure below describes `b00d75bd7`, not today; `last-verified` was the scan date until the weekly docs audit re-read the report on 2026-10-26 (§ *Dispositions re-checked*), which is what the date now records.

# Quality scan 2026-10-03: whole repository

**Revision:** `origin/dev` @ `b00d75bd7` (`b00d75bd78d3169070be1711d7d9145cce739aa5`, the #3609 squash #3613).
**Checkout:** a throwaway detached worktree. I ran `npm ci` and built core and sdk (`npm run build -w packages/core`, then `-w packages/sdk`, exit 0).
**Scope:** bare invocation, so the whole repository. The sample was weighted to what landed since the last scan (`2cc23374`, 2026-09-25): 152 first-parent landings, nearly all from the budget wave of epic #3328 and the ops console (#3507).
**Method:** `.agents/skills/quality-scan/SKILL.md` with `references/dimensions.md` and `references/discovery-method.md`. I read the ledger first and excluded every prior item.
**Real database:** a disposable database `haven_qs20261003` on the local Postgres. It was created for the run and dropped afterwards.
**GitHub:** read-only (`gh issue/pr/run list|view`, `gh search`). Nothing was filed, commented, pushed or opened.
**Final state:** after every mutation and probe, `git status --porcelain` → 0 lines.

Instrument notes for this machine:
- `rg` exists only as a zsh function. `bash -c 'command -v rg'` prints nothing, so block 2 ran under bash with `grep -rl`.
- `git grep -E` with `\b` reads 0. Every `\b` count below uses `git grep -P` or `rg`. The positive control was `git grep -cP "details:\s*err instanceof Error"` on the #3609 guard file → 1. The same pattern under `-E` returned 0.
- zsh does not word-split `$T`. The first run of the sub-budget probe passed all 27 file paths as one argument and printed "No test files found, exiting with code 1". I re-ran it with `${=T}`.

---

## Structural findings

### S1: a budget decision is re-implemented at each payment entrypoint. Each new budget scope is threaded through by hand, and the wave since 2026-09-25 filed one issue a day where one entrypoint missed one scope.

**The pattern.** Haven now has four spend scopes:
- the period budget delegation
- a task budget (#3329)
- a sub-budget (#3330)
- a merchant pin (#3331)

Three backend entrypoints each decide on their own which delegation(s) to read for the remaining-budget pre-check, whether the task cap applies, which replay is exempt, and how to spell the typed 403:
- `POST /payments` (`packages/backend/src/routes/payments.ts`)
- `POST /x402` with its two legs (`packages/backend/src/modules/x402/delegation-authorize.ts`)
- the MPP budget pre-check that the hosted catalog preflight calls (`packages/backend/src/modules/mpp/budget-precheck.ts`)

The hosted and local MCP tool schemas then thread `task_budget_id` and `sub_budget_id` tool by tool. Parity between these sites is kept by comments, not by an instrument.

**Measured evidence** (all at `b00d75bd7`):

- Typed refusal body built by hand:
  - `git grep -n "error_code: 'delegation_budget_exceeded'" b00d75bd7 -- packages/backend/src ':!*.test.ts' ':!*__tests__*' ':!packages/backend/src/openapi/*'` → **9 sites in 3 files** (budget-precheck 2, delegation-authorize 4, payments 3).
    > Corrected in the #3621 review: by kind, the 9 are 5 response bodies and 4 refusal-ledger `detail` objects (the ledger's 2026-10-03 entry carries the split).
  - `payments.ts:787` says in a comment: "The same body the x402 legs answer (delegation-authorize.ts), with this route's rail and recipient in place of the x402 fields". The parity is by comment only.
- Remaining-budget reads: `git grep -n "readRemainingBudget(" b00d75bd7 -- packages/backend/src ':!*.test.ts' ':!*__tests__*'` → **16 lines in 12 files**. This includes the definition and the display reads (ops, analytics, merchants, allowances). The spend-decision reads are 2 in payments, 2 in delegation-authorize, 1 in budget-precheck and 1 in balance-coverage.
- Task-cap check: `git grep -n "checkTaskBudgetCap(" …` → 4 lines (1 definition + 3 call sites in 2 files).
- **Three rules for which delegation the period pre-check reads when a sub-budget pays** (source reading, cited by line):
  - `POST /payments` reads all three links of B's chain and takes the minimum (`payments.ts:732-778`). Its own comment says "B's own slice is usually the tighter".
  - The `/x402` erc7710 leg reassigns `budget` to A's parent grant only (`delegation-authorize.ts:857`) and pre-checks that one link (`:898`).
  - The `/x402` EIP-3009 funding leg pre-checks `selectDelegation(agent.id, token, payTo)` (`:419`). That is B's own (token, delegate-EOA) selection, which is not on the sub-budget chain at all. The comment at `:426` calls this "a convenience only".
  - #3503's acceptance criterion states the rule the direct route now keeps: "the pre-check reads the delegation actually redeemed".
- **Two replay rules.** `budget-precheck.ts:140` documents that its settled-replay exemption "is STRICTER than `delegationReplay`'s own confirmed+tx_hash branch". It also excludes task- and sub-budget rows because "the catalog-purchase preflight this endpoint serves never authorizes against either" (`:159-160`).
- **Test matrix: entrypoint × scope.** Route test files referencing each scope:

  | | `task_budget` | `sub_budget` |
  |---|---|---|
  | `payments*` | 6 | 2 |
  | `x402*` | 3 | **0** |

  Command: `git grep -l "<scope>" -- "routes/__tests__/<ep>*.test.ts" | wc -l`, run from `packages/backend/src`.
- **The empty cell, by execution (block-6 probe P3).** I disabled sub-budget resolution on both `/x402` legs: `perl -pi -e 's/^(\s*)if \(subBudgetId\) \{/$1if (false && subBudgetId) {/'` on `delegation-authorize.ts` (2 lines changed).
  - All 27 `*x402*` and `delegation-authorize*` backend test files → **27 passed / 403 passed**.
  - The four other files that mention `subBudgetId` (sub-budget-delegation, request-validation, budget-precheck, payments-sub-budget) → **4 passed / 113 passed**.
  - With the scope dropped, a sub-budget x402 payment falls back to B's (token, to) selection. That is the silent-scope-drop shape of #3378, and nothing reddens.
  - The matching mutation on the direct route (M3 below, min-of-links → last link) turns `payments-sub-budget.test.ts` **3 failed / 16**.
- **The hosted/local tool matrix disagrees on one tool name, by execution (probe P4).**
  - `npx tsx` calling `parseStrict('haven_pay_x402_quote', {…, sub_budget_id: 'sb-1'})` → **REFUSED**: "haven_pay_x402_quote does not accept "sub_budget_id"". The same call with `task_budget_id` parses.
  - The hosted handler nevertheless forwards `args.sub_budget_id` on both branches (`packages/mcp-server/src/tools/plain-http-x402.ts:410` and `:487`). Those lines are unreachable through the strict schema.
  - The local MCP declares `sub_budget_id` on its `haven_pay_x402_quote` (`packages/mcp/src/tools.ts:133`).
  - The hosted catalog tools (`haven_prepare_catalog_purchase`, `haven_pay_mcp_tool`) declare neither scope, and `BudgetPrecheckBody` (`modules/mpp/types.ts:89`) has no scope field. Whether that is intended product scope is not stated in #3329, #3330 or #3328 (`gh issue view` of each, grepped for catalog/tool scope). It is recorded as an open question, not a defect.

**Demonstrated cost.** The issue record is the cost. These issues were created 2026-09-26 → 2026-10-02 (`gh issue view <n> --json createdAt,state`), each one entrypoint giving a different budget answer from its siblings. The classification is mine, from title and body:

| Issue | Created | What differed |
|---|---|---|
| #3378 | 09-26 | `task_budget_id` accepted and silently dropped on 4 tools; payments ran against the whole budget |
| #3392 | 09-26 | replay ignored `task_budget_id` |
| #3464 | 09-29 | remaining budget spelled four ways in one hosted server |
| #3476 | 09-29 | x402 quote had no allowance block, though the catalog path has one |
| #3492 | 09-30 | catalog prepare refused a settled replay as over-budget |
| #3500 | 09-30 | task cap had no pre-check: untyped 502 "retry once" |
| #3503 | 09-30 | `/payments` had no period pre-check that the x402 legs had had since #2082/#2706 |
| #3504 | 09-30 | hosted MCP dropped the typed 403 |
| #3518 | 09-30 | reports picked the first budget per token, not the one that pays |
| #3527 | 10-01 | #3492 again, for EIP-3009 |
| #3609 | 10-02 | prepare 502 residual for caveat reverts |

That is **11 issues in 7 days**. 8 are closed. #3500, #3503 and #3609 are still open, with fixes merged on `dev`.

Five related issues sit in the same wave but outside the strict class: #3419, #3501, #3505, #3506, #3553.

Comment archaeology shows the tax:
- `git grep -h -o -P '#3(378|392|492|500|503|504|527|609)\b' -- 'packages/*/src/*' ':!*.test.ts' ':!*__tests__*' | wc -l` → **206 occurrences**.
- `git grep -l` with the same pattern → **40 non-test source files**: backend 24, mcp-server 7, qa-agent 5, sdk 3, core 1.
  > Corrected in the #3621 review: this regex lists 8 of the 11 cluster issues. With all 11 (`#3(378|392|464|476|492|500|503|504|518|527|609)`) the count is **316** occurrences in **53** non-test source files, the figure the ledger's 2026-10-03 entry records.
- The same `-l` at `2cc23374` → 0.

The x402 pre-check's own comment (`delegation-authorize.ts:866-878`) records the user-facing cost when an entrypoint lacks the rule: an over-budget erc7710 request came back 201 with `sign_data`, and the refusal arrived "four round trips later, after the agent had signed, settled, and retried the merchant (#1993)".

**How contributors would work differently.** Adding a budget scope today means editing three backend entrypoints, the hosted and local tool schemas, the SDK, and the replay predicates, and keeping parity by comment. After the change, a scope is added once in a shared resolver. A table-driven entrypoint × scope × replay test then fails for any entrypoint that does not route the new scope.

**Slices** (S-A blocks the others; S-B, S-C and S-D touch disjoint files):

1. **S-A: a shared budget-scope resolver** in `packages/backend/src/modules/` (new module).
   - Input: (agent, token, recipient, `{taskBudgetId | subBudgetId}`).
   - Output: the redemption links, the links the period pre-check must read (today's `/payments` semantics: every link, minimum wins, fail open per link), the task-cap input, and one builder for the `delegation_budget_exceeded` body.
   - Characterization tests are lifted from `payments-period-budget` / `payments-task-budget` / `payments-sub-budget`.
2. **S-B: `/x402` adopts it on both legs** (`delegation-authorize.ts` only), plus the first x402 × sub-budget route tests. This settles the three-rule divergence above. Owner decision needed: does the funding leg pre-check the chain it redeems?
3. **S-C: `POST /payments` adopts it** (`payments.ts` only). Behaviour is unchanged, pinned by the existing suites.
4. **S-D: one replay predicate.** `modules/mpp/budget-precheck.ts` + `modules/x402/replay.ts`: either share the settled-replay predicate, or pin the documented "stricter" difference with a test. Optionally `BudgetPrecheckBody` gains the scope.
5. **S-E: the matrix ratchet.** A table-driven test over (entrypoint × scope × fresh/replay) and over hosted-vs-local tool schemas for the payment tools. It fails when a cell is missing. It would have caught P3 and P4.

**Tracking and novelty.**
- `gh issue list --state all --search "sub-budget x402"`, `… "pre-check in:title"` and `gh search issues` ("budget pre-check entrypoint", "precheck parity", "budget chain links") show no issue for a shared resolver, the x402 sub-budget pre-check, or the hosted `sub_budget_id` gap.
- #3328 (open epic) carries the features, not this pattern.
- #3500, #3503 and #3609 are open per-site fixes and are context.
- Not covered by any ledger item. The nearest are 2026-09-16 F1 (refusal *recording* choke point, epic #3056, shipped: it is about the ledger write, not the budget decision) and 2026-09-13 F3 (idempotency as prose: its key half shipped, its success half `rejected`). The replay rule in S-D touches F3's area but is a different defect (two predicates), so it is not a re-surface.

**Verification still needed.**
- An executed x402 route test showing what a sub-budget over B's slice actually answers today. The P3 probe proves nothing pins it. The consequence "late refusal at redemption" is inferred from the source and the #1993 comment, not run.
- An owner decision on hosted `haven_pay_x402_quote` and the catalog tools carrying sub- and task-budget scopes.

---

## Improvement candidates

### C1: the #3609 source-scan guard is key-shaped; two raw-error shapes pass it green

- **Opportunity and evidence.** `packages/backend/src/__tests__/no-raw-error-details.test.ts` (shipped in `b00d75bd7`) matches only a `details:` key with four value shapes.
  - Block-1 mutation M1 (the shape it names) is caught.
  - Two block-6 probes on the same site (`packages/backend/src/modules/mpp/sweep.ts`, the sweep relay 502), each restored by `git checkout --` and `cmp` against a `cp` backup:
    - P1 `details: (err as Error).message` → **4 passed (4)**. `\w+\.message` needs a word character before `.message`, and a cast puts `)` there.
    - P2 the raw text under `error:` (`error: errorMsg`) → **4 passed (4)**.
  - A live instance of P2's shape exists: `packages/backend/src/routes/accounting.ts:157` answers `error: err instanceof FortnoxError ? err.message : String(err)` inside a response's `failures[]`. I did not test what a non-Fortnox error carries there. The leak is unproven; only the shape is observed.
  - Census: `git grep -nP "\b(error|message|reason|detail)\s*:\s*(\w+\.message\b|String\(\s*(err|e|error)\s*\)|\(?\s*\w+\s+instanceof\s+Error\s*\?)" -- 'packages/backend/src/**/*.ts' ':!**/*.test.ts' ':!**/__tests__/**'` → 72 lines. Most are typed-error messages or log and storage text; accounting.ts:157 is the one raw `String(err)` I confirmed in a response body.
- **Expected benefit.** The guard's purpose ("A new one reddens here whether or not anything exercises it") holds for the two most common alternative spellings, not only for `details:`.
- **Approximate scope.** One PR: widen the patterns (cast form, response keys `error`/`message` inside `send(`/`body:`), add positive controls for P1 and P2, and resolve accounting.ts:157. Tracking: #3609 is still open (its fix is merged), so this fits as a comment there or a follow-up `new-task`.
- **Verification still needed.** Re-run P1 and P2: both must redden. Check the false-positive rate of the widened pattern on the 72-line census (typed messages must stay allowed).

### C2: the ops on-chain view's single-flight test is timing-flaky and turned `dev` CI red twice

- **Opportunity and evidence.** Of the last 200 `ci.yml` runs (`gh run list --workflow ci.yml --limit 200`, oldest 2026-09-29T13:29Z), **4 failed on `dev`**.
  - **2 of the 4** are the same test: `packages/backend/src/modules/ops/__tests__/onchain.test.ts` "a second call within the TTL makes no reader calls (single-flight cache)". Runs 37023532565 (`e2f14b2cd`) and 36969879117 (`804efc51e`).
  - Both logs show the only difference is `generated_at`: `…05:43:21.603Z` vs `…05:43:21.604Z`. The view stamps `new Date((opts.now ?? Date.now)())` per call (`modules/ops/onchain.ts:330`). The test injects no `now` and asserts `expect(second).toEqual(first)`.
  - The test is unchanged since #3568 (`git log -- <test> <module>` → 1 commit), so it is still in the tree.
  - The other two dev failures: 36884159267 is the budget-refusal-suite race that `b00d75bd7` fixed (its third commit; `payments-task-budget.test.ts` was touched). 36840464006 is a design-visual failure I did not diagnose.
  - Tracking: `gh issue list --state all --search "single-flight"` → only #3513 (the feature, closed).
- **Expected benefit.** Removes a recurring false red on `dev` pushes. It is about 1 in 100 ci.yml runs in this window, and it lands on the branch everyone reads.
- **Approximate scope.** One PR, test-only: inject `now`, or compare everything except `generated_at`. Optionally decide whether a cached read-set should carry its fetch time rather than "now".
- **Verification still needed.** Run the test with a `now` stub that advances 1 ms between the two calls: red before the fix, green after.

### C3: hosted `haven_pay_x402_quote` refuses `sub_budget_id`, which its handler forwards and the local tool declares

This is the concrete defect inside S1. It is listed separately because it is one PR whatever the owner decides about S1.

- **Opportunity and evidence.** Probe P4 (`npx tsx` → `parseStrict`) → `sub_budget_id` **refused**, `task_budget_id` parsed. The forwarding at `plain-http-x402.ts:410` and `:487` is unreachable through the strict schema. Local `packages/mcp/src/tools.ts:133` declares the key. No hosted test exercises it: `git grep -n "sub_budget_id" -- 'mcp-server/src/tools/plain-http-x402.test.ts'` → 0. The result is that sub-agent B can pay a plain-HTTP x402 merchant under its sub-budget locally but not through the hosted MCP.
- **Expected benefit.** The same tool name accepts the same scopes on both runtimes. The dead forwarding either becomes live and tested, or is deleted.
- **Approximate scope.** One PR, after an owner decision:
  - declare `sub_budget_id` on hosted `haven_pay_x402_quote`, plus tests asserting it reaches `createX402Intent` and `prepareX402Erc7710`, the #3378 criteria shape;
  - or delete the forwarding and state the scope in the tool description.
- **Verification still needed.** The decision itself. If the key is declared, it needs a backend x402 sub-budget route test first, because P3 shows nothing pins that path.

No further candidates qualified. I refused the following under the bar, with reasons:
- the block-3 regex's blind spot for `label: N;` lists (an instrument note, below);
- `any` 24 → 30: the 6 new lines are prose, and code lines went 6 → 10, all `typed_data/user_operation: any` in the two new budget services, no cost shown;
- the comment at `budget-precheck.ts:150` naming `confirmX402Intent` (0 non-test callers) as the writer of confirmed EIP-3009 rows: a comment-accuracy note, not traced further.

---

## Context the owner should know (operational, tracked, not a candidate)

**qa-dev has produced no money-flow evidence since 2026-10-02T12:48Z.**
- `gh run list --workflow qa-dev.yml --limit 100`, then per run the `money-flow` job conclusion → **15 failure / 85 skipped / 0 success** (oldest 2026-10-02T12:47:47Z).
- All 15 failures are class `preflight`: "a resource this run consumes is below its floor". The QA wallet's Base Sepolia USDC is under the ~0.034 USDC a full run spends.
- The failures span the 15 newest deploys through `b00d75bd7` (the #3609 merge), so #3609 has not been QA-exercised on dev.
- #2769 (open) received 17 bot comments and 0 human comments in that window (`gh issue view 2769 --json comments`).
- The in-step retry re-runs a deterministic preflight failure (attempt 2/2 also `preflight`). That costs runner minutes only.
- Remedy: the top-up in `docs/operations/agent-qa.md` § Top-up. It is an operator action.

---

## Tracking and novelty checks

- Open issues: `gh issue list --state open --limit 300` → 25. Open PRs → 2: #3614 (#3610, x402 status description) and #3605 (#3597, CLI feedback). Neither overlaps S1, C1, C2 or C3.
- Issues created since 2026-09-25: `gh issue list --state all --search "created:>=2026-09-25" --limit 500` → **147** (131 closed / 16 open). Classified by title. The one recurring untracked class is S1's. The site redesign (#3572–#3579) and the ops console (#3507–#3517, #3581–#3611) are feature epics, not incident classes.
- Ledger exclusions applied:
  - 2026-07, 08-14, 08-18, 08-19, 09-08, 09-10, 09-13, 09-15, 09-16, 09-17, 09-18, 09-21, 09-22, 09-25: every finding and candidate, whatever its disposition.
  - The 09-15 mock-families item is `accepted-as-debt`.
  - None is re-surfaced. The only re-measurable deltas (db-mock gauge, `any`, block 2, block 4, perimeter) are recorded below, and none worsened materially.
- Bug-report prior art: `docs/bug-reports/` (10 files, latest `qa-explore-agent-onboarding-2026-09-28.md`) was listed but read only by filename. Novelty against those report bodies is **unverified** beyond the issue tracker. The 09-28 prod-purchase run's findings were filed as #3416–#3423 and checked through the tracker.

---

## Coverage record (`Probed clean:` format)

Every row is at `b00d75bd7` unless it says otherwise.

| Dimension | Status | Command → result | Sample boundary | Missing verification and reason |
|---|---|---|---|---|
| Sizing | examined | 09-22 command made pinned (`git ls-tree -r --name-only <rev> packages/<p>/src`, filter `.ts\|.tsx\|.mjs`, split on `.test.\|__tests__\|.spec.`, `git show \| wc -l`). Control at `2cc23374` reproduces backend 80,798 / 101,079 exactly. Now: backend **101,373 / 127,733** (+25 % / +26 % in 8 days), frontend 60,143 / 54,473, sdk 16,876 / 18,196, core 23,676 / 500, qa-agent 8,567 / 6,513, mcp-server 10,123 / 19,659, signer 4,664 / 7,767, connect 11,620 / 14,592, cli 2,643 / 2,651. Largest backend source growth (`git diff --numstat 2cc23374 b00d75bd7`): `openapi/spec.ts` +4,366/−1,391, `routes/payments.ts` +765/−50. | 9 packages | `ops`, `ui`, `mcp`, `demo-merchant-mcp` not sized (time) |
| Block 1: guard falsifiability | examined | Census script → **15** candidate files (newest landings `b00d75bd7`, `e1b79f6ab`). 5 mutations, one per file, newest first; each baseline run first, each restored with `git checkout --` + `cmp`. Results in the table below: **4 caught**, **1 survivor in its named file**, caught by its sibling suite. | Newest landing first; money-path files only | The other 10 census files were not mutated (budget is 5) |
| Block 2: `covers:` completeness | examined | The reference loop under `bash` with `set -f` (`grep -rl`) → 8 contract docs, **20** raw misses. Two are glob strings (`packages/**/*.md`, `docs-drift/*.test.ts`), not paths. Each of the other 18 was confirmed with `node scripts/docs/coupling-gate.mjs --strict --changed=<path>`; none names the citing doc. **18 true across 6 of 8 docs** (09-25: 18 across 6, unchanged): x402 sequence 3, CASP guardrails 6, dev-environment 4, docs-quality 2, package-dev-channel 2, security model 1. `npm run docs:covers-gaps` → **134 pairs / 36 docs** (09-25: 138 / 36); 2 docs outside the governed set. | All 8 docs | None |
| Block 3: stale numbers | partial | Positive control: all 3 founding specimens match. 25 newest shards (`2026-10-01-3456` … `2026-10-02-skill-client-update`) → **1** figure-bearing line, and it is a false match (`AA20/21/…` in `2026-10-01-3494.md:29`); **0** with a command. Instrument blind spot: the `2026-10-02-3609.md` shard carries about 26 measured mutation counts in a `label: N;` list (lines 72-95), and the regex matches none. One re-derived: "the sweep relay fed from its raw-text variable again: 1" = this run's M1 → **1 failed** (matches). Ledger re-derivations: `any` **24 → 30** (code lines 6 → 10); db-mock gauge (`npm run lint:db-mocks`) **54 / 273 / 57 → 54 / 270 / 57**. | 25 shards; 1 shard figure re-derived | The other shard figures were not re-derived (time) |
| Block 4: retired vocabulary | examined | Reference term list (rg, excluding `dimensions.md`) → positive control **36** shards; **194 files, 46 historical / 148 live** (09-25: 192 / 46 / 146). Pinned `git grep -l -i -E` diff `2cc23374`→`b00d75bd7`: +`frontend/src/app/demo/page.tsx`, +`mcp-server/src/next-step-refusal.test.ts`, `Button.tsx` moved from frontend to `packages/ui` (192 → 194 reproduced pinned). `npm run lint:retired-rail-prose` → green, below baseline. Code half: `recordX402Signature`, `confirmX402Intent`, `failPendingX402Intent` → 0 non-test importers. `confirmX402Intent` gained a comment citation in `modules/mpp/budget-precheck.ts:150` that names it as a live writer. | Full tracked set | None |
| Block 5: merge-method drift | examined | First-parent since 2026-09-25T00:00:00Z → **0 merge-commit / 169 squash** (clean). Since 2026-08-10T00:00:00Z → 282 / 895 of 1,180 (merge count unchanged). | Window as stated | None |
| Block 6: nets with holes | examined | Copy lint (reference command) → **98** unscanned / **6** with hits (09-25: 87 / 6). Money perimeter → **32** verb files / **20** outside (09-25: 31 / 19); the new one, `modules/ops/onchain-readers.ts`, is a comment hit ("No … `sendTransaction`"). Visual gate → **15 of 31** frontend routes shot (09-25: 9 of 26). Docs boundary pinned → **39** (unchanged; `2cc23374` also 39). `qa-freshness.mjs` exit branches unchanged (Gap 1 :540, #2164 :1090, `qa-override` :41/:128/:150, KNOWN LIMIT :131). New probes: **P1/P2** (C1) both green; **P3** (S1) x402 sub-budget disabled → 31 files / 516 tests green; **P4** (C3) hosted parse refuses `sub_budget_id`. Classifier routes the new packages (`packages/ui/*`, `packages/ops/*`; `change-classifier.mjs:280,287`). | Four reference halves plus 4 probes | `packages/ops/src/app` routes are outside the visual measure (it has the #3583 render smoke instead; not examined) |
| Incident clustering | examined | Issues created since 2026-09-25 → **147** (131 / 16). S1 class **11** in 7 days, plus 5 adjacent. Ops-console and site-redesign issues are feature slices. | Classified by title, plus bodies for the 16 S1 and adjacent issues | Not every body was read |
| Workflow archaeology | examined | `ci.yml` last 200 (oldest 2026-09-29T13:29Z) → **8** attempt > 1 (all feature branches), **18** failures, **4 on `dev`** (2 = C2, 1 = fixed race, 1 visual not diagnosed), 38 cancelled. `qa-dev` `money-flow` job level, last 100 → **15 failure / 85 skipped / 0 success** (see Context). `git log origin/dev --since=2026-09-25T00:00:00Z --format=%B \| grep -ciE "flak\|re-?run"` → 30 lines. | ci.yml and qa-dev only | Other workflows not read |
| Comment archaeology | examined | `git grep -c -w -E 'TODO\|FIXME\|HACK\|XXX' -- 'packages/*/src/*'` → **0** files (control `git grep -l -w import` → 1,844). S1 issue references → 206 occurrences / 40 files. | `packages/*/src` | None |
| Live exercise | not examined | — | — | Not requested; GitHub was read-only |

Block 1 mutations:

| # | Guard file | Mutation | Baseline → mutant |
|---|---|---|---|
| M1 | `no-raw-error-details.test.ts` | `sweep.ts` `details: boundedErrorDetails(err)` → `details: errorMsg` | 4 / 4 → **1 failed** |
| M2 | `prepare-failure.test.ts` | `boundedErrorDetails` drops `redactVendorSecrets` | 17 → **2 failed** |
| M3 | `payments-period-budget.test.ts` | sub-budget min-of-links → last link | 11 → **11 passed: survivor**, *not load-bearing at the tested condition* (single-link file); sibling `payments-sub-budget.test.ts` **3 failed / 16** |
| M4 | `x402-task-budget.test.ts` | erc7710 `if (capRefusal) return capRefusal` → `void capRefusal` | 11 → **1 failed** |
| M5 | `mcp-server/src/next-step-refusal.test.ts` | `PREPARE_REVERTED_ERROR_CODE` renamed | 20 → **1 failed** |

## Dispositions re-checked 2026-10-26 (weekly docs audit #4438, at dev `ebf567f1c`)

The report body, its figures and the mutation table above are left as written —
they describe `b00d75bd7`. What was re-read at this head is whether each
finding and candidate still stands:

- **S1 (a budget decision re-implemented at each payment entrypoint)** — closed
  by epic #3615. `packages/backend/src/modules/budget-scope/` is the shared
  resolver the scan asked for: `resolver.ts` (the redemption links and the
  links the period pre-check reads), `precheck.ts`, `refusal-body.ts` (one
  builder for the `delegation_budget_exceeded` body) and `expired-budget.ts`
  (the #4352 expired-only read). The three entrypoints the scan named now
  consume it, and the hosted/local tool matrix no longer disagrees on
  `sub_budget_id`: #3617 settled it by removing the dead forwarding and stating
  the scope in the description (`plain-http-x402.ts:1303,1382`).
- **C1 (the #3609 source-scan guard was key-shaped)** — closed. The guard's
  pattern now covers the cast form, `String(...)`, `instanceof Error` and
  `.message` (`no-raw-error-details.test.ts:26`), and a second check binds a
  named raw-error variable to a `details:` that carries it verbatim
  (`:55-88`). The `accounting.ts:157` shape the scan observed is unchanged and
  still unproven as a leak: it is a `failures[]` entry under `error:`, not a
  `details:` key, so the widened guard does not reach it.
- **C2 (the ops on-chain view's single-flight test was timing-flaky)** —
  closed (#3624). `modules/ops/__tests__/onchain.test.ts:239-247` pins the
  clock, with the reason recorded in the comment.
- **C3 (hosted `haven_pay_x402_quote` refused `sub_budget_id`)** — closed
  (#3617), by the second of the two options the scan offered: the forwarding is
  deleted and the scope is stated in the tool description, rather than the key
  being declared.

All 10 covered paths in `covers:` still exist. The 28 covered commits since
2026-10-03 — the #4372 doc sweeps, the 0.11.0-alpha.0 release and the
budget-scope consolidation — changed the covered files but supersede nothing
measured here.
