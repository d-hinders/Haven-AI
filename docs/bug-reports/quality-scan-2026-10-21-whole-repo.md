---
owner: "@d-hinders"
status: current
covers:
  - packages/sdk/src/merchant-completion.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/x402.test.ts
  - packages/qa-agent/src/lib/settlement-record.ts
  - packages/qa-agent/src/scenarios/x402-delegation-3009.ts
  - packages/qa-agent/src/scenarios/x402-hosted-mcp-signer.ts
  - packages/backend/src/rails/delegation-policy.ts
  - packages/backend/src/rails/delegation-rail.ts
  - packages/backend/src/rails/hybrid-provisioning.ts
  - packages/backend/src/modules/x402/x402-delegation.ts
  - packages/backend/src/modules/task-budgets/task-budget-delegation.ts
  - packages/backend/src/modules/sub-budgets/sub-budget-delegation.ts
  - packages/backend/src/infra/chain/delegation-budget-reader.ts
  - packages/frontend/src/lib/delegationPasskeySigner.ts
  - packages/frontend/next.config.ts
  - packages/backend/vitest.setup.ts
  - packages/backend/src/index.ts
  - packages/backend/src/rails/sweep.ts
  - packages/backend/vitest.config.ts
  - packages/backend/src/infra/prices.ts
  - packages/backend/src/modules/mpp/__tests__/delivery-reference.test.ts
  - packages/backend/src/modules/payments/__tests__/x402-agent-reported-outcome.test.ts
  - packages/backend/src/routes/__tests__/payments-sub-budget.test.ts
  - packages/backend/src/routes/__tests__/non-custody-onchain-enforcer.contract.test.ts
  - packages/backend/src/infra/http/__tests__/ssrf-guard.real-transport.test.ts
  - packages/backend/src/infra/__tests__/ops-readonly-role.test.ts
  - packages/backend/src/routes/__tests__/payments-session-rail.test.ts
  - packages/frontend/src/__tests__/suite-timing-posture.test.ts
  - packages/mcp-server/src/tools/registry.ts
  - packages/mcp-server/src/tools/parsing.ts
  - packages/mcp-server/src/tools/contracts.ts
  - packages/mcp-server/src/tools-list.snapshot.json
  - packages/mcp-server/src/strict-tool-input.test.ts
  - packages/mcp-server/src/tools-registry.test.ts
  - packages/mcp-server/src/tools-contracts.test.ts
  - packages/mcp-server/src/description-size.test.ts
  - packages/qa-agent/src/evals/tools.test.ts
  - scripts/ci/release-on-merge.mjs
  - scripts/ci/release-on-merge.test.mjs
  - scripts/ci/qa-freshness.mjs
  - scripts/docs/coupling-gate.mjs
  - .agents/skills/quality-scan/references/dimensions.md
last-verified: "2026-10-21"
---

# Quality scan 2026-10-21 — whole repo, weighted to the landings since 2026-10-19

Scope (owner request 2026-10-21, no scope named): the whole repository,
weighted toward the 55 first-parent landings on `dev` since the 2026-10-19
scan's revision (`git rev-list --first-parent --count 595b43c07..8cc3717c8` →
55). They include the process-hardening epic #4171 (#4179, #4181, #4182,
#4184, #4186, #4187) and its follow-ups #4194, #4198 and #4199; the remedies
of the 2026-10-19 candidates (#4124, #4144, #4153, #4140) and their siblings
(#4131, #4133); the account-page and list-controls waves (#4142, #4158, #4162,
#4170, #4183, #4190 and others); #4189 (the qa-agent hung-receipt test); and
#4148, reverted by #4195.

Measured on `origin/dev` @ `8cc3717c8` (2026-10-21) in the worktree of branch
`docs/quality-scan-2026-10-21`, by one agent, one heavy job at a time. The
checkout was `npm ci`'d, and core, the SDK, the signer and the local MCP were
built. Seven mutations were made, each behind a `cp` backup in the session
scratchpad, restored with `cp`, checked with `cmp` and `git diff --quiet`.
One measurement preload (below, §2 C2) ran outside the tree; one temporary
probe test was written, run and deleted. Real-database runs used a
disposable `haven_qs1021` database, dropped at the end. GitHub was read
through `gh` only (issues, runs, job logs). No MCP or dev call was made. At
the end, `git status --porcelain` → 0 lines before the report was written.

**Excluded this run:** every prior finding and candidate, whatever its
disposition. None is re-surfaced. C1 below sits beside the 2026-10-19 C2
(#4119, `shipped` via #4144) and is not that candidate: C2 was the qa-dev
legs not checking the record; C1 is what the check found once it ran — the
SDK's own report does not land, on 21 of 21 runs. The re-measurable deltas
are in §5. None worsened materially.

## 1. Structural findings

None in the examined sample. C2 and C3 share an instrument (a preload that
refuses non-loopback connections) but have two mechanisms, two owners and
two remedies. A "tests depend on the machine" pattern (cold imports, real
network, wall clock) was weighed and refused: the repo recorded the decision
to keep vitest's 5000 ms default as its hung-test detector and to accept
load-proportional costs (#2319, #2329, #2354; pinned by
`packages/frontend/src/__tests__/suite-timing-posture.test.ts`), and of its
three mechanisms only the network one has a census that executed (§2 C3,
§2 notes).

## 2. Improvement candidates (one PR each) — pending the owner's word

### C1 — the SDK's one-shot EIP-3009 settlement report recorded in 5 of 42 qa-dev attempts, and qa-dev has been red on every money-flow run since #4144 asserted it

- **Observed (qa-dev, job level).** `#4144` (`aa818795d`, 2026-10-20
  12:18Z) made the EIP-3009 legs require Haven's own record of the merchant
  settlement within 45 s. It touched only `packages/qa-agent` and two docs
  (`git show --stat aa818795d` → 14 files).
  - Before it: 2026-10-19T12:00Z → 2026-10-20T12:07Z, `money-flow` ran 11
    times → 11 `success` (`gh run list --workflow qa-dev.yml --created
    '2026-10-19T12:00:00Z..2026-10-20T12:18:00Z'`, then each run's
    `money-flow` job conclusion).
  - From its own deploy (run on `aa818795d`, 12:21Z) to the scheduled run at
    the scan SHA (job 119120448025, 2026-10-21 08:29Z): **21 failure, 1
    cancelled, 0 success**. The newest `money-flow` success is 12:07Z on
    `84f347f0a`; `qa-freshness.mjs`'s `selectGreenRun` admits only a
    `money-flow` job success (`moneyFlowJobConclusion`, `:746`, `:771`).
  - The tracker #2769 has 21 bot comments since 2026-10-20T12:00Z and 0 from
    a person. Every one names `x402-delegation-3009` and/or
    `x402-delegation-3009-grace-resume`, class `unclassified`. No claim on
    #3193 names the red; #4119's only comment since its merge is the release
    line.
  - In the 7 jobs read below (14 attempts), the two SDK legs recorded
    within the window **4 times in 28**: `x402-delegation-3009` 1 of 14,
    `-grace-resume` 3 of 14. 23 failures read "Haven did not record the
    merchant settlement of payment … within 45s … the SDK's settlement report
    was refused, or the backend answered it retryable (the merchant tx was
    not yet visible to its node) and the SDK, which posts once, did not
    retry"; 1 was a grace-resume `post-funding recovery failed`
    (`gh api …/actions/jobs/<job>/logs | grep '• x402-delegation-3009'`).
- **Observed (the hosted leg, same runs).** The hosted leg passes, and its
  PASS line says how the record landed
  (`packages/qa-agent/src/lib/settlement-record.ts:268`, `:331`, `:396`). In 7
  jobs (118623690650, 118912293104, 118918109755, 118919373960,
  119079897538, 119089544171, 119120448025; both attempts each), **13 of 14
  hosted PASS lines** read "via a follow-up `haven_report_settlement_evidence`
  carrying payment_header", and 1 reads "via the settle's own settlement
  report" (`gh api …/actions/jobs/<job>/logs | grep '• x402-hosted-mcp-signer … PASS'`).
  The follow-up arm is taken only when the settle's first report did not
  record (`settlement-record.ts:341`: "retryable, or the missing-proof-header
  refusal"). The hosted settle's first report is the same SDK call the local
  path makes (`client.ts:2034`).
- **The tree.** `MerchantCompletion.retryRequest` posts the settlement report
  once and discards the outcome by design (#3764 D1/D2,
  `packages/sdk/src/merchant-completion.ts:315-329`, `:814-842`); the hosted
  path hands the outcome to the agent. The criterion's call sites:
  `git grep -n "reportSettlementEvidenceOnce(" 8cc3717c8 -- 'packages/sdk/src/*' ':!*.test.ts'`
  → 3 lines (the definition, `client.ts:2034`, `merchant-completion.ts:329`).
  The local path's #3764 block covers two posts, a same-hash skip, a
  malformed hash and no settlement (`x402.test.ts:2554-2608`). Of the SDK
  test files that drive the local path
  (`git grep -l -E "retryRequest|client\.fetch\(" 8cc3717c8 -- 'packages/sdk/src/*.test.ts'`
  → 4), none answers an evidence post `retryable`: the one `status: 503`
  among them is a merchant's answer (`x402.test.ts:849`).
- **#4144 named this.** Its PR body's *Residuals*: the SDK posts once and
  swallows a `retryable` answer, so a backend node lagging the merchant's can
  red an SDK leg; "if it recurs, the fix belongs in the SDK"; and "the next
  qa-dev run after merge is the live check". The first run after merge was
  red, and so was every run since.
- **Hypothesis, not established.** That the first report is answered
  `retryable` (`settlement_unobservable`) and not refused. The hosted
  follow-up adds `payment_header` and succeeds, which fits either arm; both
  paths send the header in the tree (`client.ts:2032-2037`,
  `merchant-completion.ts:326-329`). Which arm dev answered is not
  determinable without dev logs, which were not read. That the same report
  sometimes records (4 of 28 SDK attempts, 1 of 14 hosted) fits a race with
  the merchant's transaction better than a refusal, which would never
  record; it does not prove it. Whether the #3888
  sweep later recorded those settlements (it ticks ≥ 60 s after the funding
  confirm, per #4144's body) is not determinable either.
- **Expected benefit.** qa-dev's `money-flow` job can go green again, so the
  freshness gate has a run to admit. And an SDK-local EIP-3009 purchase gets
  its merchant record at purchase time, not only from the sweep: on the
  hosted path the client's first report recorded 1 time in 14.
- **Scope.** One PR, an owner decision first. Either bound a retry on a
  `retryable` answer on the local path (the funding report already has
  `EVIDENCE_RETRY_DELAYS_MS`), which revisits #3764 D2; or surface the
  outcome on the local `fetch` / `resumeX402Payment` path, as #4144's body
  proposes; or widen the legs' window to admit the sweep, which revisits
  #4119.
- **Verified at scan.**
  - The criterion grep above → 3 lines.
  - Routing for `packages/sdk/src/merchant-completion.ts` →
    `code backend sdk connect mcp mcp_server signer qa_agent`; for
    `packages/qa-agent/src/lib/settlement-record.ts` → `code qa_agent`.
  - Money-path matcher → `merchant-completion.ts` **money-path**,
    `settlement-record.ts` off; control `sweep.ts` money-path.
  - Mutation recipe *unrun*: the retry does not exist yet. Once built, a
    local-path test whose settlement report answers 503 then 200 must see two
    posts, and deleting the retry must turn it red.
- **Verification still needed.** That test, red without the retry. One
  qa-dev run with `money-flow` green on both SDK legs.

### C2 — the backend's delegation builders send MetaMask SDK analytics to a third-party host, and nothing in the tree turns it off

- **Observed by execution.** A preload that refuses and records every TCP
  connect to a non-loopback host (positive controls: a bare `node` fetch to
  `example.com`, and a temporary vitest probe file that dialed
  `api.coingecko.com`, each recorded and refused) ran over 428 of the 512
  backend test files (`src/modules`, then `src/routes`, `src/infra`,
  `src/rails`, `src/platform`, `src/domain`, `src/middleware`; not
  `src/db`, `src/openapi`, `src/__tests__`, `src/docs-drift`, `src/testing`,
  84 files). **31 files** opened, between them, **87 connections** to
  `mm-sdk-analytics.api.cx.metamask.io:443`. The same `src/modules` run with
  `DO_NOT_TRACK=1` → 0 such connections (was 11 files / 37), 168 / 168 files
  green.
- **Why.** `@metamask/smart-accounts-kit` 1.6.0 (`package-lock.json`) wraps
  `createDelegation`, `createOpenDelegation`, `toMetaMaskSmartAccount`,
  `createCaveatEnforcerClient` and six other exports in
  `trackSmartAccountsKitFunctionCall`, which batches events to that endpoint
  (`dist/chunk-TNGQTVSY.mjs:1780`). It disables itself only when `CI`,
  `DO_NOT_TRACK`, `navigator.doNotTrack` or `window.doNotTrack` is `1`,
  `yes` or `true` (`:1877-1892`). Payload, read from the same file: the
  function name, `hasInheritance`, the scope type and caveat names, plus
  `sdk_version`, a random `anon_id`, the platform and, in a browser, the
  page's hostname (`:1611-1650`, `:2068-2100`). No address or amount.
  CI never sees it: GitHub Actions sets `CI=true`.
- **Callers in the tree** (whole token, non-test,
  `git grep -l -P '(?<![\w-])\Q<fn>\E(?![\w-])' 8cc3717c8 -- 'packages/*/src/*' ':!*.test.ts' ':!*.test.tsx' ':!*__tests__*'`):
  `createDelegation` → 4 backend files (`rails/delegation-policy.ts`,
  `modules/x402/x402-delegation.ts`, `modules/task-budgets/task-budget-delegation.ts`,
  `modules/sub-budgets/sub-budget-delegation.ts`), 1 qa-agent pilot, and 1
  SDK comment line; `toMetaMaskSmartAccount` → 2 backend
  (`rails/delegation-rail.ts`, `rails/hybrid-provisioning.ts`), 1 frontend
  (`lib/delegationPasskeySigner.ts`, the owner's passkey signing), 3
  qa-agent; `createCaveatEnforcerClient` → 1 backend
  (`infra/chain/delegation-budget-reader.ts`), 1 qa-agent: 7 distinct backend
  files in all. The
  frontend's CSP is report-only with `connect-src 'self' https:`
  (`packages/frontend/next.config.ts:126`, `:139`), so it would not stop the
  browser's post. The frontend path was read, not executed.
- **Not set anywhere:** `git grep -l -P '(?<![\w-])DO_NOT_TRACK(?![\w-])' 8cc3717c8`
  → 0 files (control `NODE_ENV` → 8). `mm-sdk-analytics` → 0 files.
  Whether the deployed backend's environment sets `CI` or `DO_NOT_TRACK` is
  not determinable from the tree, and Railway was not read.
- **Tracking.** `gh issue list --state all --search` for `mm-sdk-analytics`,
  `DO_NOT_TRACK`, `smart-accounts-kit analytics` and `telemetry metamask` →
  no issue about it (one unrelated coordination-channel hit). Ledger and
  `docs/bug-reports/` → 0 hits for each term.
- **Expected benefit.** A third-party egress from a custody-adjacent service,
  and from the owner's browser at the signing step, becomes either off or a
  recorded decision. Each local test run stops posting to MetaMask.
- **Scope.** One PR, after the owner decides whether the telemetry is
  acceptable. If not: set `DO_NOT_TRACK` before the kit loads in the backend
  entry and its vitest setup; for the browser, which the kit reads through
  `navigator`/`window` only, either a shim before the dynamic import in
  `delegationPasskeySigner.ts` or an upstream ask; a test that refuses the
  host while a delegation is built; and a line in the security model. If
  yes: the line in the security model only.
- **Verified at scan.**
  - The criterion grep above → 0 (control 8).
  - The recorder: 31 files / 87 connections; with `DO_NOT_TRACK=1` over
    `src/modules`, 0.
  - Routing for `packages/backend/src/index.ts` and
    `packages/backend/vitest.setup.ts` → `code backend`; for
    `packages/frontend/src/lib/delegationPasskeySigner.ts` → `code frontend`.
  - Money-path matcher → all three off, and
    `docs/security/delegation-rail-security-model.md` off; control `sweep.ts`
    money-path.
  - Mutation recipe built once: the recorder over `src/modules` with and
    without `DO_NOT_TRACK=1` (above). The browser half is *unrun*.
- **Verification still needed.** The same recorder run after the change
  reading 0 for that host; a browser-side check on the passkey signing path.

### C3 — the backend's rule that "a test body must not dial the real network" is enforced nowhere, and two test files still dial CoinGecko

- **Observed by execution** (the C2 recorder, same 428 files). **2 files /
  11 tests / 12 connections** to `api.coingecko.com:443`:
  `modules/payments/__tests__/x402-agent-reported-outcome.test.ts` (7 tests,
  8 dials) and `routes/__tests__/payments-sub-budget.test.ts` (4 tests, 4
  dials). Refused, every one of those tests passed: the price capture's
  documented null degradation applies.
- **The rule and its incidents.** #3963's two `dev` reds of 2026-10-14 were
  each a backend test dialing the real network under vitest's 5000 ms
  `testTimeout` on the CI runner: #3969 (the catalog ownership proof fetch)
  and #3974 (CoinGecko via `getBookTimeCapture`). Each was fixed at its site.
  #3974 also bounded the price fetch to 2 s (`PRICE_FETCH_DEADLINE_MS`,
  `packages/backend/src/infra/prices.ts`), so a test that reaches it twice can
  spend 4 s of its 5. The rule is written once, as a comment
  (`git grep -n -i "must not dial" 8cc3717c8 -- packages` → 1 line,
  `delivery-reference.test.ts:30`). The backend's `vitest.setup.ts` and
  `vitest.global-setup.ts` carry no network net; `MockAgent` resolves in 1
  file repo-wide, a frontend test.
- **What a net would trip today** (the recorder in refusing mode is its
  prototype). Of the 428 files, 425 behaved as before. 3 went red:
  - `ops-readonly-role.test.ts`, 20 tests — "permission denied to create
    role", the disposable database's owner role. Environment, not network.
  - `ssrf-guard.real-transport.test.ts`, 5 tests — it pins `.test` hostnames
    to a local server through its own lookup. The recorder refuses by
    hostname; a real net must match the resolved address.
  - `non-custody-onchain-enforcer.contract.test.ts` — a deliberate Base
    Sepolia probe ("could not reach https://sepolia.base.org"). A net needs
    a named exemption for it.
- **Tracking.** `gh issue list --state all --search` for `"real network"`,
  `disableNetConnect` and `network in:title test` → #3963 (the dev-red
  tracker) and two coordination channels, no issue for a net. Ledger and bug
  reports → 0 hits for "real network".
- **Expected benefit.** A test that reaches the network fails on its first
  run, on any machine, naming the host, instead of timing out on a slow
  runner and reopening the dev-red tracker. The two remaining files become
  deterministic.
- **Scope.** One PR: a refusing preload in the backend's `vitest.setup.ts`
  that matches the resolved address, with a named allowlist (the live-chain
  contract test); stubs for the two files. qa-agent and the other packages
  are a later question (not measured).
- **Verified at scan.**
  - Routing for `packages/backend/vitest.setup.ts` and the two test files →
    `code backend`.
  - Money-path matcher → all off; control `sweep.ts` money-path.
  - Mutation recipe built once and run: the recorder (above). The
    resolved-address matcher is *unrun*.
- **Verification still needed.** The backend suite green under the net in
  CI. The net's own self-test: a probe that dials is red, an allowlisted one
  is not.

### Verified, held back (notes, not proposed)

- **Cold dynamic imports inside timed test bodies** (#4126, #4134, both
  2026-10-20, fixed by hoisting). A heuristic census at the scan SHA, `await
  import(<spec>)` inside an `it`/`test` body, in a file that does not reset
  modules, `<spec>` neither a `node:` builtin nor statically imported by the
  file → **105 sites in 43 files**. Positive controls: it finds both fixed
  sites at their parents (`15606bfba^`, `2a247e0ac^`). But the one remaining
  site sampled, `payments-session-rail.test.ts:364` (the #4134 module,
  `openapi/response-shape.js`), ran in 50 ms and 46 ms over two runs: the
  app's static graph had already loaded it. The static census overcounts
  cold loads; it needs per-site timing before it is evidence. The repo's
  recorded posture (§1) also applies.
- **Wall-clock-bound assertions.** `expect(Date.now() - …)` or
  `expect(<elapsed>).toBeLessThan(…)` in test files → 11 files (control: the
  #4189 site at `31b838009^`). Several are deliberate deadline tests (the
  SSRF guard's, the rate-limit store's). #4189 fixed the one that reddened
  `dev` twice in this window (run 39431650076, "expected 3104 to be less
  than 1000"; run 39506943669, "expected 3102 …").
- **Adding one hosted tool edits 8 existing test or test-support files.**
  Files carrying at least 20 of the snapshot's 29 tool names → 16. #4148
  (+658/−20 over 17 files) and its revert #4195 (+89/−582 over 17) each
  edited the same 8 existing test or test-support files besides the tool's
  own test. Their comments say the literal lists are deliberate
  anti-vacuity pins. No drift incident since #4140.
- `tools-contracts.test.ts:33` says "The 28 hosted tool names" above a list
  the test holds at 29 (stale since #3770, before this window).

## 3. Context for tracked work (not new items)

- **#4123** is open by design. Its build landed as #4133 (`55ef0d264`) with
  `Refs`, to close after a live check on dev.
- **The revert of #4148 left no runtime residue.** `haven_check_token_safety`
  resolves in 3 files at the scan SHA, all history: the runtime-compatibility
  doc's removal note and the two CASP shards (control `haven_check_funds` →
  32 files).

## 4. Dispositions observed (prior items, for the record)

- 2026-10-19 **C2** → #4119 closed 2026-10-20 via PR #4144 (`aa818795d`) →
  **`shipped`**. C1 above is what its check found.
- 2026-10-19 **C3** → #4120 closed 2026-10-20 via PR #4153 (`688b5c8dc`) →
  **`shipped`**.
- 2026-10-19 **C4** → #4121 closed 2026-10-20 via PR #4140 (`5bb6d4ae7`) →
  **`shipped`**. Re-verified by execution: this run's M5 is the 10-19 M7
  re-run, 2 red of 130 where 10-19 read 79 / 79 green.
- The spec reviews' siblings: #4122 closed 2026-10-20 via PR #4131
  (`44ce131a9`); #4123 open (§3).
- 2026-10-19 C1 → `shipped`, already recorded.

## 5. Coverage record (block → examined / partial / not examined → command → result)

- **sizing** → examined → the 09-22 command pinned with `git ls-tree`/`git show`
  at `8cc3717c8`; the control at `595b43c07` reproduces backend 112,970 /
  146,150 and qa-agent 12,691 / 10,530 →
  - backend 113,538 / 147,443 (+0.5 % / +0.9 %);
  - frontend 71,713 / 73,900 (+5.6 % / +6.3 %);
  - sdk 18,678 / 20,769;
  - core 25,245 / 669;
  - **qa-agent 14,550 / 12,678 (+14.6 % / +20.4 %)**;
  - mcp-server 13,332 / 24,360;
  - signer 5,273 / 8,404; connect 12,436 / 15,676; cli 3,200 / 3,573;
    ops 3,143 / 2,216; ui 2,519 / 1,990; mcp 2,792 / 4,974;
    demo-merchant-mcp 3,788 / 4,210.
- **block 1 (guard falsifiability)** → examined. The reference's census
  script at `8cc3717c8` → **8 candidate test files over 1 of the last 20
  landings** (the revert `758909bb1`, the only one of the 20 touching a
  money-path file); one of the 8 (`token-safety.test.ts`) is deleted at the
  SHA, so 7 exist. Five census mutations, one per file, then two probes:
  - M1 `tools/registry.ts` `toolInputSchema` `.strict()` → `.passthrough()`:
    **caught**, 31 red of 213 in `strict-tool-input.test.ts`, 27 of them the
    transport-path "REFUSES … and never reaches the handler" tests. In the
    failures printed, the handler's own strict parse still refused the key
    (`invalid_input`); the reds are on the transport's `unrecognized` wording,
    plus one identity read made before the handler.
  - M2 `findHostedToolRegistryIssues` missing-handler check → `false &&`:
    **caught**, 2 red of 10 in `tools-registry.test.ts`.
  - M3 `haven_get_task_budget`'s description → `''` in `tools/contracts.ts`:
    **caught**, 2 red of 9 in `tools-contracts.test.ts`.
  - M4 the same description's first two characters → `#1` (byte length
    unchanged, so the size pins cannot be the red): **caught**, 1 red of 3 in
    `description-size.test.ts` (the issue-archaeology guard).
  - M5 a 30th hosted tool in `tools-list.snapshot.json` (`haven_pay` copied
    under a new name, +43/−0): **caught**, 2 red of 130 across the three
    eval suites (`tools.test.ts`'s set-equality and partition tests). This
    is the 10-19 M7, green 79 / 79 then.
  - P1 (second copy of M1's guard) `parseStrict` in `tools/parsing.ts`
    `.strict()` → `.passthrough()`: **caught**, 27 red of 213, all in the
    direct-embedder block.
  - P2 (a count-only pin) `scripts/ci/release-on-merge.test.mjs`'s "#2268
    hand close … releases" asserts only `d.releases.length === 1`. Mutation:
    `decideClose` returns the release with `body: null`. The count-only test
    stayed green; **6 sibling tests red of 94** assert the body. Diagnosis:
    held elsewhere, not a survivor.
  - Every restore was checked with `cmp` against its backup and
    `git diff --quiet`; `git status --porcelain` → 0 at the end.
  - Census files exercised: 5 of 8 (the four above in `mcp-server` and the
    eval tools test). Not exercised: `server.test.ts`,
    `queue-framing-census.test.mjs` (budget); `token-safety.test.ts` does not
    exist at the SHA. Context, not the sample: over the whole window
    (`595b43c07..8cc3717c8`), 5 of 55 landings touched a money-path file and
    their test files number 15.
- **block 2 (`covers:` completeness)** → examined. The reference loop under
  `bash` with `set -f` → 20 raw misses over 8 contract docs, 2 of them glob
  strings (dropped). Each of the other 18 was confirmed with
  `node scripts/docs/coupling-gate.mjs --strict --changed=<path>`: none
  names the loop's doc (control `--changed=packages/backend/src/rails/sweep.ts`
  → 7 docs named) → **18 across 6 of 8**: x402 sequence 3, docs-quality
  system 2, dev-environment 4, package-dev-channel 2, CASP guardrails 6,
  security model 1. Unchanged since 09-25. `npm run docs:covers-gaps` → 129
  pairs / 35 docs (unchanged); the same 2 docs are outside the governed set.
- **block 3 (stale numbers)** → partial.
  - Positive control: 3 / 3.
  - The 25 newest shards (`2026-10-15-3988` … `2026-10-21-4193`) → **9**
    figure-bearing lines, **0** with a command (10-19: 11 / 1).
  - Two shard figures re-derived and matching: #4122's "17 commits"
    (`git log --format=%h 399b1c00f..44ce131a9^ -- packages/sdk/src/merchant-completion.ts | wc -l`
    → 17) and #4097's "21 tests" (a static count of `it(` in
    `AccountSignersCard.test.tsx` at `fa1c20399` → 21; not run).
  - One stale prose figure found: the "28 hosted tool names" docblock (§2
    notes). #4198 removed another, the CASP doc's SDK runtime-file count.
  - `any` 38 (unchanged). db-mock gauge 54 / 270 / 57 (unchanged). Guard
    scripts 71, self-tests 74, non-spawning 25 of 74 (unchanged). Zod in the
    backend 0.
- **block 4 (retired vocabulary)** → examined. Positive control 36 shards.
  196 files, 46 historical / 150 live (10-19: 195 / 46 / 149). The file-set
  diff against `595b43c07`: the ship-next perimeter list moved from
  `SKILL.md` to its new reference (one for one), and one frontend test
  fixture gained `pendingApprovals: 0`, the dashboard compat field the spec
  documents as always 0 since #2055. `npm run lint:retired-rail-prose` → 30
  hits / 28 files, green below baseline (10-19: 32 / 30). Code half
  unchanged: `failPendingX402Intent` only its defining file; the other two
  have one QA-agent comment line each.
- **block 5 (merge-method drift)** → examined at `8cc3717c8`. Since
  2026-10-19T00:00:00Z → 0 merge-commit / 78 squash (clean).
  `595b43c07..8cc3717c8` → 0 / 55. Since 2026-08-10T00:00:00Z → 282 / 1,210
  of 1,495 (282 unchanged).
- **block 6 (nets with holes)** → examined, four halves.
  - Copy lint: 60 unscanned / 4 with hits (10-19: 56 / 4).
  - Money perimeter: 32 verb files / 20 outside (unchanged).
  - Visual gate: 16 of 28 app routes shot (10-19: 15; `/contacts` added).
  - Docs boundary, pinned: 41 (10-19: 39; the two new ship-next references,
    `money-path-perimeter.md` and `waiting-on-ci.md`).
  - Freshness-gate exit-branch grep: 14 lines (unchanged).
  - Probes beyond the reference: the network recorder (C2, C3) and the
    qa-dev job read (C1).
- **incident clustering** → examined. Issues created since
  2026-10-19T00:00:00Z → **60** (54 closed / 6 open). By hand:
  - account-page epic and follow-ups 12;
  - list-controls epic 12;
  - process hardening, preflight and claims 11 (#4171–#4177, #4191, #4192,
    #4193, #4200);
  - the 10-19 candidates and siblings 6;
  - agent evals 6;
  - tests timing out under load 2 (#4126, #4134);
  - settlement follow-ons 2 (#4061, #4062);
  - other 9.

  The untracked recurring mechanism is C1 (21 consecutive qa-dev reds,
  untriaged). C3's mechanism recurred twice on 10-14 and is fixed per site.
- **workflow archaeology** → examined.
  - `ci.yml`, newest 100 (2026-10-20T11:56Z → 10-21T07:50Z) → 67 success /
    18 failure / 15 cancelled. 9 had attempt > 1, all feature branches (6
    branches).
  - `dev`: 42 runs → 29 / 3 / 10. The 3 failures: the hung-receipt
    wall-clock test twice (§2 notes; fixed by #4189) and one TS2304 crossing
    (run 39473240898; fixed by #4169).
  - The 18 failures by failed job: design visual regression 6, browser smoke
    5, frontend checks 4, QA agent checks 3, none 1.
  - qa-dev at the `money-flow` job level: C1. Newest 30 runs (10-20T21:57Z →
    10-21T08:29Z): 29 `deployment_status` and 1 `schedule`; `money-flow` ran
    in 6 (6 failure, counting the scheduled run, which finished during the
    scan) and was gate-skipped in 24.
  - `agent-evals.yml` since 2026-10-20 → 3 runs: 1 success, 2 failure.
- **comment archaeology** →
  `git grep -c -w -E 'TODO|FIXME|HACK|XXX' 8cc3717c8 -- 'packages/*/src/*'`
  → 0 files (control `import` → 2,098 files). The real-network rule is
  written once (C3).
- **live exercise** → not taken (tree scan by brief). No runtime identity was
  needed. GitHub reads only.
- **SKILL step 3's unnumbered probes** →
  - fat controllers: not examined.
  - data-layer coverage: not examined as a census. The db-mock gauge was
    re-read, and 428 backend test files ran against a real database.
  - validation / contract enforcement: not examined.
  - cross-package duplication: partial. The hosted tool-roster census only
    (§2 notes).
- **novelty** → tracker searched per candidate (C1: `settlementEvidenceOutcome`,
  `reportSettlementEvidenceOnce`, `"posts once"`, `x402-delegation-3009`;
  C2: `mm-sdk-analytics`, `DO_NOT_TRACK`, `smart-accounts-kit analytics`,
  `telemetry metamask`; C3: `"real network"`, `disableNetConnect`,
  `network in:title test`). The ledger and `docs/bug-reports/` were grepped
  for each term: 0 hits except a 10-19 report line about the pre-#4075
  header. Bug-report bodies were not otherwise re-read.

## 6. Instrument lessons from this run

- A recorder that refuses by hostname reads a test that pins a hostname to a
  local server through its own lookup as an outbound dial (the SSRF guard's
  real-transport tests). Match the resolved address.
- `ops-readonly-role.test.ts` needs `CREATEROLE` on the database role; a
  disposable database owned by a role without it reddens 20 tests for
  environment reasons.
- The kit's analytics are batched on a timer, so the test a post is
  attributed to is not the test that triggered it. Count files and
  connections, not tests.
- The block-1 census over the last 20 landings can return a revert whose
  test files include a deleted one. Count only files that exist at the SHA.
- A `| head` after a vitest run cut the summary line from M1's first reading.
  Write the output to a file, then filter.
- A static census of imports inside a test body is not a census of cold
  loads (§2 notes).

## 7. Decisions requested

1. **C1–C3**: file each as a standalone task, accept it as debt, or reject
   it, each on its own. C1 needs a design choice first (§2 C1 *Scope*); C2
   needs the owner's view on the telemetry itself.
2. The notes in §2 are not proposed. Say if any should be.

Nothing was filed. On approval the ledger decision goes in a **separate**
pull request and the handoff is `new-task`, per the skill.
