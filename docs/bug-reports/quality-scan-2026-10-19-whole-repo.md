---
owner: "@d-hinders"
status: record
covers:
  - scripts/ci/rpc-conformance.mjs
  - scripts/ci/rpc-conformance.test.mjs
  - packages/qa-agent/src/lib/chain.ts
  - packages/backend/src/infra/chain/log-range-limit.ts
  - packages/backend/src/modules/x402/eip3009-settlement-sweeper.ts
  - packages/backend/src/modules/x402/settlement-sweeper.ts
  - packages/qa-agent/src/scenarios/x402-hosted-mcp-signer.ts
  - packages/qa-agent/src/scenarios/x402-delegation-3009.ts
  - packages/qa-agent/src/lib/hosted-mcp.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/merchant-completion.ts
  - packages/sdk/src/mcp-x402-native-profile.test.ts
  - packages/mcp-server/src/tools/paid-mcp-completion.ts
  - packages/mcp-server/src/tools/paid-mcp-completion.test.ts
  - packages/mcp-server/src/tools-list.snapshot.json
  - packages/qa-agent/src/evals/tools.ts
  - packages/qa-agent/src/evals/tools.test.ts
  - packages/qa-agent/src/evals/graders.ts
  - packages/signer/src/consent.ts
  - packages/backend/src/infra/repositories/owner-transfers.ts
  - packages/backend/src/modules/x402/eip3009-settlement-evidence.ts
  - packages/backend/src/infra/chain/settlement-transfer-verifier.ts
  - packages/backend/src/infra/repositories/dashboard.ts
  - packages/backend/src/db.ts
  - packages/mcp/src/tools.ts
  - scripts/docs/coupling-gate.mjs
  - .agents/skills/quality-scan/references/dimensions.md
last-verified: "2026-10-26"
---

# Quality scan 2026-10-19 — whole repo, weighted to the landings since 2026-10-13

Scope (owner request 2026-10-19, no scope named): the whole repository,
weighted toward the 101 first-parent landings on `dev` since the 2026-10-13
scan's revision (`git rev-list --first-parent --count 641f527d..595b43c07` →
101). They include the multi-account wave (#4044, #4045, #4048, #4080), the
budget-liveness epic #3919 (the 10-13 S1), the EIP-3009 settlement proof and
its follow-ons (#3961, #3948, #4013, #4074, #4075), the agent-eval suite
(#3965, #3985, #3995, then #4068, #4072, #4077, #4081, #4082, #4083, #4085,
#4086, #4087, #4092), the budget replace rule (#3970), the inline first-agent
setup (#4090), owner-send records (#4100), and many dashboard, marketplace and
navigation landings. #3888 landed through PR #3893 (`1018deb3f`) before
`641f527d` (`git merge-base --is-ancestor 1018deb3f 641f527d` → true), so it
is not in this window.

Measured on `origin/dev` @ `595b43c07` (2026-10-19) in the worktree of branch
`docs/quality-scan-2026-10-19`, by one agent, one heavy job at a time. The
checkout was `npm ci`'d, and core, the SDK and the signer were built. Seven
mutations were made, each behind a `cp` backup in the session scratchpad,
restored with `cp` and checked with `git diff --quiet`. Real-database runs
used a disposable `haven_qscan` database, dropped at the end. GitHub was
read-only. No live MCP or dev call was made. At the end,
`git status --porcelain` → 0 lines before the report was written.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. None is re-surfaced. C1 below sits beside the 2026-09-25 S1
(epic #3335, `shipped`) and is not that finding: it is one capability its
shipped probe does not check, with two incidents since. The re-measurable
deltas are in §5. None worsened materially.

## 1. Structural findings

None in the examined sample. The candidates below share a family resemblance:
an instrument that checks a copy, or a near neighbour, of what it claims to
check. But they work by four different mechanisms with four different
remedies, and none is a pattern with its own census. Naming them as one
structural finding would be manufacturing one. The eval-suite fix wave (§3)
was weighed and refused: it is an open epic's first live week, and each
defect is tracked.

## 2. Improvement candidates (one PR each) — pending the owner's word

### C1 — the RPC conformance probe does not check `eth_getLogs` range, and a probe-gated provider swap broke two log readers

- **Observed.** `scripts/ci/rpc-conformance.mjs:16-33` checks five
  capabilities: chain id, a batch of N, the `pending` tag, the raw-send
  method and a burst. The dev and promotion runbooks make it a required step
  before any RPC variable changes (`docs/operations/dev-environment.md` around
  line 603; `docs/operations/promoting-dev-to-main.md` around line 281).
  - #3489's body records that Alchemy passed all five checks on
    2026-09-29 (not quoted output). Its 2026-10-01 comment carries the
    post-swap probe output, ending `✓ all 5 checks passed`.
  - Alchemy's free tier caps `eth_getLogs` at a 10-block range.
- **Incident 1, #4012** (filed and closed 2026-10-16). Both x402 settlement
  sweepers asked for 500-block batches and were refused on every tick:
  - 76–80 `chainsUnavailable` per tick;
  - 16.4M of the 30M-CU monthly pool gone by mid-month, 99 % of it from the
    dev app (the issue body's figures).
  - Fixed in the backend by a learned range limit,
    `packages/backend/src/infra/chain/log-range-limit.ts`.
- **Incident 2, #4086** (2026-10-19). The eval pilot (run 39240551636)
  graded three real on-chain payments as missing. The QA harness has its own
  window constant, `GET_LOGS_MAX_RANGE = 10` at
  `packages/qa-agent/src/lib/chain.ts:174`, added by that fix. The commit
  says the money-flow scenarios had passed "only because their windows
  happened to be short".
- **Evidence it is untracked.** `rg -n "getLogs|eth_getLogs" scripts/ci/rpc-conformance.mjs`
  → 0. `gh issue list --state all --search "getLogs in:title,body"` → 7
  issues: #4012 and six others, none about the probe or a range check. No
  open issue asks for the check.
- **Expected benefit.** The next provider or plan change would be refused at
  the step built for it, instead of surfacing as quota burn in the backend
  and false "missing" verdicts in the harness. Prod shares the provider
  account (#4012), and the promotion runbook runs the same probe against
  chain 8453.
- **Scope.** One PR: a sixth check (an `eth_getLogs` over a span at least as
  wide as the widest caller's default, today the sweepers' 500 blocks). It
  should also report the cap the provider names, parsed the way
  `parseLogRangeLimit` already does. Plus the runbook line. Optionally, a
  second PR could fold the QA harness's constant into the same learned-limit
  idea.
- **Verification still needed.** The probe's self-test pattern
  (`scripts/ci/rpc-conformance.test.mjs`, "every check is proven able to
  fail") for the new check: a stub that refuses a wide range must fail it.
  Then one read-only run against the current dev endpoint, which should fail
  today unless `ETH_GETLOGS_MAX_BLOCK_RANGE` is honoured.

### C2 — qa-dev's EIP-3009 legs prove both on-chain legs but never that Haven recorded the merchant settlement, and the hosted leg passed on every scheduled run's first attempt while the hosted settle path's record was refused

- **Observed.** The `x402-hosted-mcp-signer` scenario
  (`packages/qa-agent/src/scenarios/x402-hosted-mcp-signer.ts:128`) drives
  `haven_settle_mcp_tool`, which calls the SDK's `completeX402MerchantCall`
  (`packages/mcp-server/src/tools/paid-mcp-completion.ts:581`). It asserts:
  - the funding and merchant receipts, both `status === 1`;
  - zero delegate residual.

  Its docblock (`:58-62`) still says "Haven never observes the merchant's
  settlement itself", which has been untrue since the 2026-09-29 → 10-14
  evidence wave (#3479, #3765, #3888, #3961). Searching the scenario
  directory for any evidence field
  (`rg -n "merchant_settlement|settlement_evidence|settlementEvidence|merchantSettlement" packages/qa-agent/src/scenarios -g '!*test*'`)
  → 0 lines. No qa-dev scenario calls the hosted report tools
  (`rg -l "haven_report_x402_outcome|haven_report_settlement_evidence" packages/qa-agent/src`
  → only `evals/tools.ts`, a name list).
- **What happened (from the tree and the PR record).** #3925 (PR #3961,
  `bd808304c`, 2026-10-14) made the backend refuse an agent-reported EIP-3009
  merchant settlement that carries no payment header. At `a6f90d5fd^`, the
  SDK's `reportSettlementEvidenceOnce` posted no header
  (`git show a6f90d5fd^:packages/sdk/src/merchant-completion.ts`, lines
  822-831), and `completeX402MerchantCall` called it (`client.ts:2052` at
  that revision). #4075's SDK commit says both paid-retry paths had their
  settlement refused, and it flipped the #3764 characterization tests to
  expect the header. Its first commit characterizes the same refusal for the
  hosted report tools. The gap was found by a hand-run testnet purchase on
  2026-10-19 (#4061), not by qa-dev.
- **qa-dev during the gap.** Five scheduled runs at SHAs after `bd808304c`
  and before `a6f90d5fd`, read from each run's `money-flow` job log
  (`gh -R d-hinders/Haven-AI run view <run> --job <job> --log`):
  - 38704137304 (10-15, `c939b7880`), 39014696813 (10-17), 39109631766
    (10-18) and 39225180146 (10-19 08:46Z): job `success`, with
    `• x402-hosted-mcp-signer … PASS` on attempt 1. The 10-15 run passed
    overall on attempt 2/2; the other three passed on attempt 1/2.
  - 38871441969 (10-16, job 116876251507): job `failure`.
    - On attempt 1 the leg PASSED; only `x402-catalog-guided-purchase`
      failed (`CALL_EXCEPTION`, missing revert data).
    - On attempt 2 the leg FAILED: `hosted haven_settle_mcp_tool refused:
      MERCHANT_REJECTED_AFTER_FUNDING` (HTTP 402). `x402-erc7710-hosted`
      (treasury −0.002, merchant +0.001), `x402-catalog-guided-purchase`
      again, and `merchant-locked-budget` (activate 502, could not deploy)
      failed with it.

  So the leg passed on the first attempt of all five runs while the path it
  drives had its merchant settlement record refused. Its one failure, on
  10-16 attempt 2, was a merchant refusal, not an evidence check. Whether
  the passive sweep later recorded those settlements is not determinable
  from the logs: the leg prints nothing about evidence, and dev was not
  queried.
- **Expected benefit.** The settlement record the accounting feed books
  under (#3767) and that receipts headline (#3763) becomes a gated
  qa-dev property, so a backend tightening that refuses a real client is red
  on the next deploy.
- **Scope.** One PR in `packages/qa-agent`: after the settle, read the
  payment status (or receipt) until it carries the merchant settlement hash
  that the leg just proved on-chain, or fail with the refusal reason. Apply
  the same to `x402-delegation-3009.ts` where the merchant settles. Correct
  the docblock.
- **Verification still needed.** The leg's unit test red against a stubbed
  status that omits the hash. One qa-dev run green on `dev`.

### C3 — the SDK makes the post-funding merchant-answer decision twice, and its own suite pins only one copy

- **Observed.** There are two implementations of "retry the merchant with the
  payment header, decide accepted or rejected, report evidence":
  - the hosted path: `HavenClient.completeX402MerchantCall`,
    `packages/sdk/src/client.ts:1809-2075`, 267 lines, inside the class #1620
    reduced to "a compatibility facade";
  - the local path: `MerchantCompletion.retryRequest`,
    `packages/sdk/src/merchant-completion.ts:162-348`, 187 lines.

  Each derives `inBandChallenge`, `metaSettlement` and the #4062
  `plainToolErrorAfterFunding` on its own (`client.ts:1935-1941`,
  `merchant-completion.ts:248-251`).
- **Co-change.** Since the facade refactor (`399b1c00f`, 2026-08-20), 17
  commits touched `merchant-completion.ts`
  (`git log --format=%h 399b1c00f..595b43c07 -- packages/sdk/src/merchant-completion.ts | wc -l`
  → 17). 15 of them also touched `client.ts` (a `comm -12` of the two logs →
  15), including both money-path fixes of 2026-10-19:
  - #4074 (#4062): `client.ts` +15/−1, `merchant-completion.ts` +30/−5
    (`git show --numstat --format= d633cd1d4 -- packages/sdk/src/client.ts packages/sdk/src/merchant-completion.ts`);
  - #4075 (#4061): "both paid-retry paths".
- **By execution (M4, M5 in §5).**
  - Disabling the guard in `merchant-completion.ts` turns the SDK's #4062
    test red (1 of 46).
  - Disabling the same guard in `client.ts` leaves every SDK suite that
    drives `completeX402MerchantCall` green: native profile 46, client
    boundaries 9, handshake 19, erc7710 evidence 16, so 90 / 90.
  - Only the hosted MCP's `paid-mcp-completion.test.ts` catches it (1 of 58),
    and only against a rebuilt SDK `dist`.
- **Expected benefit.**
  - The next post-funding rule is written once.
  - A contributor working in the SDK sees the hosted copy's regression in
    the SDK's own suite.
  - The burden is observed (two copies edited per fix, twice on one day). No
    incident is attributed to a divergence.
- **Scope.** One PR, possibly two: extract the shared decision (the
  accepted/rejected predicate and the settlement read) into one function that
  both paths call, characterised first, with an in-package test per path.
  Merging the two flows outright is not proposed.
- **Verification still needed.** M5 re-run red in the SDK suite after the
  change. The hosted and local characterization suites unchanged.

### C4 — the eval graders' tool lists are hand copies, and the test that claims to catch drift compares each copy to its own length

- **Observed.** `packages/qa-agent/src/evals/tools.ts:22-62` copies the 29
  hosted tools "verbatim from `tools-list.snapshot.json`" and the 5 signer
  tools from `packages/signer/src/consent.ts`. `tools.test.ts:1-7` says a
  tool "added upstream without landing in `tools.ts` fails HERE". The test
  asserts `HOSTED_TOOLS` has length 29 and `SIGNER_TOOLS` length 5. It reads
  neither upstream list: `rg -n "tools-list.snapshot|registeredSignerToolNames" packages/qa-agent/src`
  → comment and test-title lines only, no import.
- **By execution (M7).** A 30th hosted tool added to
  `packages/mcp-server/src/tools-list.snapshot.json` (a copy of `haven_pay`
  under a new name) left `tools.test.ts`, `tasks.test.ts` and
  `graders.test.ts` green, 79 / 79. Diagnosis: *weak test*.
- **Cost mechanism.** `no_payment_retry_after_refusal` decides "retried a
  payment" with `isPaymentTool`. A new hosted payment tool missing from the
  copy is a retry the grader cannot see, so the trial is a false pass. The
  repo has a recorded incident of this class: the connect runtime manifest's
  hand mirror drifted and broke the consent screen (the 2026-08-14 ledger
  entry). The tool name appears outside tests in 5 files
  (`git grep -l -e "'haven_submit_catalog_entry'" -e '"haven_submit_catalog_entry"' 595b43c07 -- ':!*test*'`
  → 5; the single-quote pattern alone → 4, since the snapshot is JSON): the
  snapshot, two hosted modules, `packages/mcp/src/tools.ts` and
  `evals/tools.ts`. The local MCP's list, the only other copy, is
  parity-tested. No eval incident yet.
- **Scope.** One PR: derive `HOSTED_TOOLS` from the snapshot JSON (or assert
  set equality with it) and `SIGNER_TOOLS` from `registeredSignerToolNames()`.
  Keep `PAYMENT_TOOLS` explicit, but require it to be a subset of the derived
  list.
- **Verification still needed.** M7 red after the change.

### Verified, held back (notes, not proposed)

- `sumMonthlyPaymentSpend` (`packages/backend/src/infra/repositories/dashboard.ts:309`)
  has no non-test caller
  (`rg -n "sumMonthlyPaymentSpend" packages/backend/src packages/frontend/src packages/sdk/src -g '!*test*'`
  → its definition only). Its SQL is a calendar month in the session time
  zone (`DATE_TRUNC('month', NOW())`, `:305`). Dead code, and a deletion
  rather than a fix.
- The Postgres session `TimeZone` is never pinned
  (`rg -n -i "timezone|options" packages/backend/src/db.ts` → 0). #4084
  (open) tracks the one live site and reserves migration 115. This scan's own
  census of session-zone-dependent SQL in backend source found 2 sites, one
  of them in a dead function:
  - `CURRENT_DATE`: 0 live hits (2 comments);
  - `INTERVAL '7 days'`: 1, in migration 106, the #4084 site;
  - `date_trunc` without `AT TIME ZONE`: 1, `dashboard.ts:305`, inside the
    caller-less `sumMonthlyPaymentSpend` above.

  Context for #4084, not new.
- An instrument hazard for block 1, recorded in §6. Deleting the only clause
  that references a bind parameter makes Postgres refuse the statement, so
  the red is a SQL error, not the guard.

## 3. Context for tracked work (not new items)

- **The agent-eval suite's first live week.** Epic #3957 is open. Two feature
  landings on 10-14 and 10-15 (#3965, #3985) and #3995 (for #3992, whose
  title says "fixes false passes/failures") were followed by ten fix
  landings on 2026-10-19 alone:
  `git log --first-parent --since=2026-10-19T00:00:00Z --format=%s 641f527d..595b43c07 | grep -cE '^fix\((evals|qa-agent|ci)\)'`
  → 10 (#4068, #4072, #4077, #4081, #4082, #4083, #4085, #4086, #4087,
  #4092). The `agent-evals`
  workflow ran 14 times that day: 1 success, 9 failure, 3 cancelled, 1 in
  progress. Grader-correctness defects in the window:
  - #4070, a typed refusal's code read wrong;
  - #4071, then #4091, the consistency guard deducting an amount nobody
    spent, fixed twice the same day;
  - #4087, a grader requiring an impossible call;
  - #4086, the transfer probe reading past the provider cap (C1).

  Each is tracked and fixed. C4 is the one grader guard found falsifiable by
  execution here.
- **#4061 is the 10-13 scan's C1 remedy regressing a sibling.** #3925's
  backend requirement shipped without its hosted consumer able to meet it.
  C2 is the gate that would have caught it.
- **qa-dev at the job level is healthy.** The 60 newest runs are all
  `deployment_status`: 59 success and 1 failure at run level. Of the newest
  30, `money-flow` ran in 6: 5 success, all `passed on attempt 1/2` in the
  log, and 1 failure (39270528404, 10-19 14:36Z: `merchant-locked-budget`
  activate 502 "Could not deploy the account" on both attempts). It was
  gate-skipped in 24. #2769, the standing tracker, was closed by #4073's
  close-on-green.
- **The dev CI red of 10-17** (`224336c04`): a #3933 budget-card
  test, fixed by #4060 the same day.

## 4. Dispositions observed (prior items, for the record)

- 2026-10-13 **S1** → epic #3919 closed 2026-10-19, all five slices merged
  (#3939, #3952, #3962, #3968, #3966) → **`shipped`**. The ledger did not
  carry this line.
- 2026-10-13 **C1** → #3925 closed 2026-10-14 via PR #3961 (`bd808304c`) →
  **`shipped`**. The ledger did not carry this line either. Its follow-on
  #4061 is open (the fix #4075 has landed).
- 2026-10-13 C2 and C3 → `shipped`, already recorded.

## 5. Coverage record (block → examined / partial / not examined → command → result)

- **sizing** → examined → the 09-22 command pinned with `git ls-tree`/`git show`
  at `595b43c07`; control at `641f527d` reproduces backend 109,321 / 140,397
  and qa-agent 9,693 / 7,784 →
  - backend 112,970 / 146,150 (+3.3 % / +4.1 %);
  - frontend 67,922 / 69,530;
  - sdk 18,567 / 20,176;
  - core 25,125 / 607;
  - **qa-agent 12,691 / 10,530 (+31 % / +35 %, the eval suite)**;
  - mcp-server 13,311 / 24,264;
  - signer 5,273 / 8,404;
  - connect 12,436 / 15,676;
  - cli 3,200 / 3,570;
  - ops 3,143 / 2,210;
  - ui 2,372 / 1,841;
  - mcp 2,792 / 4,974;
  - demo-merchant-mcp 3,788 / 4,210.
- **block 1 (guard falsifiability)** → examined. The reference's census
  script → 31 candidate test files across 5 of the last 20 landings. The
  owner's brief chose a sample of the window's landings instead of the
  newest-first census order. Five targets are census files; M6 and M7 are
  eval-suite files outside the money-path census. Seven mutations, one
  targeted file per run, except M5 (four SDK files run one after another,
  then the hosted suite after an SDK rebuild):
  - M1 `owner-transfers.ts` insert ownership join → `(sa.user_id = $1 OR TRUE)`:
    **caught**, 1 red of 12 across `cross-tenant-writes` and
    `owner-transfers` (real DB). A first form that deleted the clause outright
    reddened 6 on a SQL error (an unreferenced `$1`), not the guard. It was
    discarded and re-run.
  - M2 `eip3009-settlement-evidence.ts:326` sibling-header refusal →
    `false &&`: **caught**, 1 red of 44 (real DB).
  - M3 `settlement-transfer-verifier.ts:453` paired-Transfer candidates →
    every log: **caught**, 1 red of 7.
  - M4 `sdk/merchant-completion.ts:249` `plainToolErrorAfterFunding` →
    `false &&`: **caught**, 1 red of 46.
  - M5 `sdk/client.ts:1936`, the same guard's hosted copy: **green in the
    SDK** (90 / 90 across the four suites that drive it) and **caught** only
    by `mcp-server` `paid-mcp-completion.test.ts` against a rebuilt `dist`,
    1 red of 58. Diagnosis: caught across a package boundary only (C3).
  - M6 `evals/graders.ts:222` `payment_status_settled` unsettled filter →
    `false`: **caught**, 1 red of 25.
  - M7 a 30th hosted tool in `tools-list.snapshot.json`: **survived**, 79 / 79
    across three eval suites. Diagnosis: *weak test* (C4).
  - Every restore was checked with `git diff --quiet`. The SDK `dist` was
    rebuilt from the restored source, and the hosted suite re-ran green
    (58 / 58). Seven mutations were run against a budget of 4–6; M5 and M7
    were a diagnosis and a probe.
  - Census files exercised: the suites run cover 8 of the 31 census test
    files (cross-tenant-writes, owner-transfers,
    settlement-transfer-verifier, eip3009-settlement-evidence,
    client-boundaries, x402-erc7710-evidence, mcp-x402-native-profile,
    paid-mcp-completion). Derived by intersecting the census script's output
    with the run list. So **23 of 31 were not exercised**. The handshake and
    the three eval suites run are outside the census.
- **block 2 (`covers:` completeness)** → examined. The reference loop under
  `bash` with `set -f` → 20 raw misses over 8 contract docs, 2 of them glob
  strings. Each of the other 18 was confirmed with
  `node scripts/docs/coupling-gate.mjs --strict --changed=<path>` (none names
  the loop's doc) → **18 across 6 of 8**: x402 sequence 3, docs-quality
  system 2, dev-environment 4, package-dev-channel 2, CASP guardrails 6,
  security model 1. This is unchanged from 10-13, 10-03 and 09-25.
  `npm run docs:covers-gaps` → 129 pairs / 35 docs (10-13: 130 / 35). The
  same 2 docs are outside the governed set.
- **block 3 (stale numbers)** → partial.
  - Positive control: 3 / 3.
  - The 25 newest shards (`2026-10-14-0.10.0-alpha.0-release` …
    `2026-10-19-approve-wording-site-cli`) → **11** figure-bearing lines,
    **1** with a command (10-13: 20 / 6).
  - Two shard figures re-derived and matching: #4061's "44/44" evidence
    suite → 44 (M2's run), and its verifier suite "7" → 7 (M3's run).
  - One stale prose claim found: C2's docblock.
  - `any` 37 → 38. Lines not led by a comment marker: 16 → 17. No code-line
    delta is claimed.
  - db-mock gauge 54 / 270 / 57 (unchanged). Guard scripts 69 → 71.
    Non-spawning self-tests 23 of 71 → 25 of 74. Zod in backend 0.
  - Shard bodies not re-derived beyond the two figures above.
- **block 4 (retired vocabulary)** → examined. Positive control 36 shards.
  195 files, 46 historical / 149 live (unchanged).
  `npm run lint:retired-rail-prose` → 32 hits / 30 files, green below
  baseline (10-13: 33 / 31). Code half unchanged: `failPendingX402Intent`
  has only its defining file; the other two have one QA-agent comment line.
- **block 5 (merge-method drift)** → examined at `595b43c07`. Since
  2026-10-13T00:00:00Z → 0 merge-commit / 109 squash (clean).
  `641f527d..595b43c07` → 0 / 101. Since 2026-08-10T00:00:00Z → 282 / 1,155
  of 1,440 (282 unchanged).
- **block 6 (nets with holes)** → examined, four halves.
  - Copy lint: 56 unscanned / 4 with hits (10-13: 52 / 4).
  - Money perimeter: 32 verb files / 20 outside (unchanged).
  - Visual gate: 15 of 28 app routes shot (unchanged). `/accounts/[accountId]`
    is among the 13 unshot, and the account-page epic #4093 rebuilds it.
  - Docs boundary, pinned: 39 (unchanged).
  - Freshness-gate exit-branch grep: 14 lines (unchanged).
  - Probes beyond the reference: C2 (an EIP-3009 qa-dev leg blind to the
    record) and C1 (a conformance check missing).
- **incident clustering** → examined. Issues created since
  2026-10-13T00:00:00Z → **87** (11 open / 76 closed). By hand:
  - marketplace and merchant buying 14;
  - dashboard and agents UI 12;
  - navigation and top bar 9;
  - agent evals 8;
  - account-page epic 7;
  - budget-liveness epic 6;
  - multiple accounts 6;
  - release, docs, CI and ops 5;
  - time windows 4 (#3944, #3975, #3977, #4084);
  - 10-13 candidates 3;
  - budget replace and grant flow 3;
  - RPC and `chainRpcs` 3;
  - agent-facing tool copy 3;
  - EIP-3009 follow-ons 2;
  - accounting feed 2.

  The untracked recurring mechanisms are C1 (two provider-cap incidents) and
  C2. The UX classes are runtime-UX, out of scope by the skill's rule.
- **workflow archaeology** → examined.
  - `ci.yml`, newest 100 (10-16T17:22Z → 10-19T21:29Z) → 64 success / 13
    failure / 23 cancelled. 7 had attempt > 1, all feature branches.
  - `dev`: 32 runs → 26 / 2 / 4.
  - Of the 8 failures with a failed job: visual regression 6, frontend checks
    and lint 2, browser smoke 1 (in a visual failure). 5 failures had no
    failed job.
  - qa-dev at the job level is in §3. Scheduled runs 10-15 → 10-19: 4
    `money-flow` success (10-15 on attempt 2/2) and 1 failure (10-16, job
    116876251507). In that failure, attempt 1 failed only
    `x402-catalog-guided-purchase` (`CALL_EXCEPTION`). Attempt 2 failed four
    legs, including `x402-hosted-mcp-signer` on
    MERCHANT_REJECTED_AFTER_FUNDING (C2).
  - `agent-evals`: 14 runs on 10-19 (§3).
- **comment archaeology** →
  `git grep -c -w -E 'TODO|FIXME|HACK|XXX' 595b43c07 -- 'packages/*/src/*'`
  → 0 (control `import` → 2,057 files). One stale docblock found by reading
  (C2).
- **live exercise** → not taken (tree scan by brief). No runtime identity
  was needed.
- **SKILL step 3's unnumbered probes** →
  - fat controllers: not examined. No route-size census this run.
  - data-layer coverage: not examined as a census. Only the db-mock gauge was
    re-read (block 3), and three real-DB suites were run for block 1.
  - validation / contract enforcement: partial. Read only where C2's
    #3925 → #4061 chain crosses it (a backend requirement its hosted consumer
    could not meet). No request-validation census.
  - cross-package duplication: partial. Two probes, C3 (the SDK's two
    completion copies) and C4 (hosted tool-list copies, 5 files). No
    repo-wide duplication census.
- **novelty** → tracker read for each candidate: C1 (`getLogs`,
  `rpc-conformance` searches), C2 (#4061's record; no issue names the qa-dev
  gap), C3 (`completeX402MerchantCall` and `merchant-completion` searches),
  C4 (none found). The ledger and bug reports were grepped for C3's surface
  (0 hits outside an issue-classification CSV). Bug-report bodies were not
  otherwise re-read.

## 6. Instrument lessons from this run

- A mutation that deletes the only clause referencing a bind parameter
  (`AND sa.user_id = $1`) makes Postgres refuse the statement ("could not
  determine data type of parameter"). Every test that writes through it
  reddens, so the red count is not the guard's. Keep the parameter
  referenced: `(sa.user_id = $1 OR TRUE)`.
- `packages/mcp-server` tests import the SDK as a built package. A mutation
  in `packages/sdk/src` is invisible to them until the SDK is rebuilt, and
  the rebuilt `dist` must be rebuilt again after the restore.
- `git grep -E` with `\b` again read wrong (an `any` count of 6 against
  `rg`'s 38). Use `rg` or `git grep -P`.
- A fresh worktree needs core built before any backend suite that imports
  `@haven_ai/core` (the suite fails at import, "no tests").

## 7. Decisions requested

1. **C1–C4** — file each as a standalone task, accept it as debt, or reject
   it, each on its own.
2. The notes in §2 are not proposed. Say if any should be.

Nothing was filed. On approval the ledger decision goes in a **separate**
pull request and the handoff is `new-task`, per the skill.

## 8. Dispositions re-checked 2026-10-26 (weekly docs audit #4438, at dev `ebf567f1c`)

The report body and §7 above are left as written. All four candidates have
since been remediated, re-read at this head:

- **C1 (the RPC conformance probe did not check `eth_getLogs` range)** —
  closed (#4118). `scripts/ci/rpc-conformance.mjs` now runs a sixth check,
  `logs <R>`: `eth_getLogs` over the last R blocks must answer, with
  `--logs-range` defaulting to the sweepers' widest batch and pinned to their
  constants by the self-test (`:62`), and the runbook line added. The check
  reports the provider's refusal text when it fails (`:165-169`).
- **C2 (qa-dev's EIP-3009 legs never proved Haven recorded the merchant
  settlement)** — closed. The scenarios now read the record back: the guided
  catalog-purchase leg reads `merchant_settlement_recorded` from the payment
  status and calls `haven_report_settlement_evidence` when it is absent,
  failing with the refusal reason; the 3009 grace-resume leg carries the same
  fixture. The docblock's "Haven never observes the merchant's settlement
  itself" claim is gone.
- **C3 (the SDK made the post-funding merchant-answer decision twice)** —
  closed (#4120). `decidePostFundingMerchantAnswer` is now ONE shared decision
  in the SDK (with `plainToolErrorAfterFunding` at `:132`), imported by both
  `client.ts:151` and `merchant-completion.ts:23`; `client-boundaries.test.ts:170`
  pins the shared module as a boundary.
- **C4 (the eval graders' tool lists were hand copies, and the drift test
  compared each copy to its own length)** — closed (#4121).
  `packages/qa-agent/src/evals/tools.ts:1-20` states the rule and
  `tools.test.ts` now compares the lists with their upstream sources by set
  equality — it reads `tools-list.snapshot.json` and imports `toolSchemas` from
  the built `@haven_ai/signer`.

All 27 covered paths in `covers:` still exist. The 37 covered commits since
2026-10-19 — the #4372 doc sweeps, the 0.11.0-alpha.0 release and the
settlement-evidence landings — changed the covered files but supersede nothing
measured here.
