---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/mcp-server/src/tools/support/errors.ts
  - packages/mcp-server/src/tools/contracts.ts
  - packages/signer/src/sign-context.ts
  - packages/signer/src/tools.ts
  - packages/signer/src/audit.ts
  - packages/sdk/src/x402-protocol.ts
  - packages/demo-merchant-mcp/src/http.ts
  - docs/operations/mcp-runtime-compatibility.md
  - packages/mcp/src/tools.ts
  - packages/mcp/src/tools.test.ts
  - packages/mcp-server/src/tools/support/mcp-context.ts
  - packages/signer/src/core.test.ts
  - packages/frontend/src/hooks/useAgentConnectionSetupStatus.ts
  - scripts/release-bump.test.mjs
  - scripts/verify-connect-bundle.mjs
  - scripts/docs/coupling-gate.mjs
  - scripts/README.md
  - packages/mcp-server/src/tools/support/cap-price.ts
  - packages/mcp-server/src/tools/state-direct-recovery.ts
  - packages/mcp-server/src/tools/parsing.ts
  - packages/mcp-server/src/tools/catalog-purchase.ts
  - packages/mcp-server/src/tools/support/quote-response.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/README.md
  - packages/mcp/README.md
  - packages/mcp/src/consent.ts
  - packages/mcp/src/server.ts
  - packages/signer/src/core.ts
  - packages/signer/src/settlement-child.ts
  - packages/signer/src/next-step-characterization.test.ts
  - packages/demo-merchant-mcp/src/x402.ts
  - packages/sdk/src/agent-guidance.ts
  - packages/sdk/src/connector-channel.ts
  - packages/sdk/src/skill-content.ts
  - packages/backend/src/modules/mpp/reconciliation.ts
  - packages/core/src/machine-payment-lifecycle.ts
  - packages/sdk/src/payment-mappers.ts
  - docs/bug-reports/quality-scan-2026-09-17-agent-surface.md
last-verified: "2026-09-21"
---

# Quality scan 2026-09-21 — agent surface, third pass

Scope (owner mandate 2026-09-12, re-invoked 2026-09-21): safe-retirement, the
Haven MCP (`packages/mcp`, `packages/mcp-server`), the signer
(`packages/signer`) and the MCP demo merchant (`packages/demo-merchant-mcp`),
exercised live on dev through the connected `haven-qa-dev` (agent `test3`,
chain 84532, hosted MCP `haven-ai-hosted-mcp-dev-25c7`) and
`haven-signer-qa-dev`. Testnet only; no intent was created and nothing was
signed — the agent's budget is 0.001 USDC by the owner's earlier refusal test
and every read below is read-only. Measured on `origin/dev` @ `e42ed68f`
(2026-09-21, after #3208).

Prior runs on this surface: 2026-09-13 and 2026-09-17 (ledger). Everything
they recorded is excluded here unless a delta was measured; §5 lists what
was re-checked and found unchanged.

## 1. What the live exercise showed

The twenty in-scope landings since 2026-09-17 (`git log --first-parent
4ed69592..e42ed68f -- <the four packages>` → 20) were the target. Observed:

- **Discovery** (`haven_discover_tools`): 9 entries, every one
  `verified_payable: true` (`verified=verified` → 9 of 9; 2026-09-13's B1 was
  0 of 6 — **shipped, confirmed live**), each carrying `suggested_tool` +
  `suggested_arguments` in the target tool's own key (`url` for
  `haven_quote_x402`, `catalog_id` for the catalog quote) — #3100 live.
- **Quotes**: `haven_quote_catalog_purchase` and `haven_quote_mcp_tool`
  answer the same informational shape (`expected_settlement_scheme`,
  `expected_settleable`, `mcp_transport.handshake_required`); the 50 GB
  fixture's description says it never settles on-chain (F2 slice (a) live).
  `haven_quote_x402` on Ampersend: `retry_url` is https while the merchant
  declares `http://` (`resource_url_differs_from_request: true`) — #3097
  live; the success carries `idempotency_key` (F3's key half live).
- **Strict refusal** (`haven_quote_mcp_tool` with `url` instead of
  `merchant_url`): names the declared keys — #3100 live — but the
  explanation attached is the spending-cap paragraph, which does not fit a
  renamed URL key (note N1, not filed).
- **Reads**: `haven_get_agent` (`spend_authority_readiness: ready`, on-chain
  remaining), `haven_get_allowances`, `haven_list_receipts` (`total`,
  cursor, the `parties` triple — #3128 and F1's remedy live),
  `haven_get_payment_status` (`parties` present; `nextAction: none`).
- **Sufficiency check** (`haven_check_funds`, #3126): three refusals
  before one answer — see D1.
- **A transient**: the first `haven_quote_x402` on
  `https://services.sandbox.ampersend.ai/api/fact` answered
  `API_ERROR` "Expected an x402 quote response with HTTP 402, got HTTP 500";
  the merchant answered 402 to a direct `curl` at the same minute and the
  same tool call succeeded on retry. The refusal carried no `next_action`
  and no next-step family — see D2.
- **The signer half was NOT the tree.** `haven-signer-qa-dev` on this
  machine runs `@haven_ai/signer 0.0.0-dev.202609151245.66966f3`
  (`~/.haven/agents/qa-dev/signer-runtime.json`; the dev dist-tag is
  `0.0.0-dev.202609200127.a29d546`, and `a29d5469` is after #3103). A
  `haven_sign` with a well-formed unknown `payment_id` answered
  `SIGN_CONTEXT_REFUSED` + `next_action: stop_and_tell_user` + `http_status:
  404` and **no** `next_tool_name`. At head the tree sets `nextTool:
  'haven_get_payment_status'` for a non-410 refusal
  (`packages/signer/src/sign-context.ts:129-136`) and renders
  `next_tool_name` (`packages/signer/src/tools.ts:789`; pinned by
  `packages/signer/src/next-step-characterization.test.ts:49`) — the absence
  is the pre-#3103 runtime, not the tree. The live signer predates the fix.
  Coverage limit, recorded in §4: every signer claim below is from the tree
  and the mutation sample, not from the live runtime. The stale-runtime
  class itself is tracked (#3119 epic; #3121 doctor severities shipped).

## 2. Structural findings

None in the examined sample. Nothing measured here meets all five bars: the
generic-refusal hole (D2) is a one-branch remedy; the `token` argument (D1)
is one tool; the `covers:` gap (C1) is one front-matter edit.

## 3. Defects and candidates (one PR each) — pending the owner's word

**D1 — `haven_check_funds` refuses the token spelling every other read
hands the agent.** Live, three refusals in a row: no arguments → the Zod
error names `token` required (fine); `token: "USDC"` alone → `INVALID_INPUT`
"A spending cap is REQUIRED before a paid merchant call … No merchant was
contacted" — the prepare tool's copy
(`packages/mcp-server/src/tools/support/cap-price.ts:143-145`), on a
read-only check; `token: "USDC",
max_amount_human: "0.001"` → `MAX_AMOUNT_UNCONVERTIBLE` "Haven does not
recognise token USDC … Re-send the amount as max_amount in atomic units"
(`packages/mcp-server/src/tools/state-direct-recovery.ts:134-148`, the
`if (!token)` branch; the echo is `token: token?.symbol ??
coverage.tokenSymbol` at `:184`) —
the wrong remedy, since the address `0x036cbd…f7e` with the same
`max_amount_human` answers `covered: true` and then **echoes `token:
"USDC"`**, the string it refused as input. The description
(`packages/mcp-server/src/tools/contracts.ts`, `CHECK_FUNDS_DESCRIPTION`)
does say "Pass the token contract address"; the schema is `z.string().min(1)`
with no shape (`packages/mcp-server/src/tools/contracts.ts:160`), `haven_get_agent`/`haven_get_allowances`
hand the agent `tokenSymbol: "USDC"` beside `tokenAddress`, and the refusal
points the agent at atomic units. Expected benefit: the one read a cold
agent is told to make before paying stops failing twice on the symbol it
was just shown. Scope: `contracts.ts` (`token` described as `0x…` address,
or resolved from the agent's own allowances when a symbol is passed), the
two refusal copies in the check-funds path, one test per refusal — one PR.
Verification: the three live calls above as a characterization test (symbol
→ resolved or refused with the ADDRESS as the remedy; the read-only check
never says "paid merchant call"). Tracking: `gh issue list --search
"check_funds"` / `MAX_AMOUNT_UNCONVERTIBLE` → no open issue; #3126 (shipped
2026-09-18) is the tool's birth.

**D2 — the hosted MCP's generic refusal branches carry no next step, and a
transient 500 lands in exactly those branches.** Live: the `API_ERROR`
refusal above had `code`, `message`, `statusCode` and nothing else. Tree:
`packages/mcp-server/src/tools/support/errors.ts:228-250` — the
`HavenApiError`, `HavenError` and `UNKNOWN_ERROR` branches return no
`next_action`, no `next_tool_*`, no `next_tool_omitted_reason`, while the
state-error branch above them (`:210-226`) says "so no hosted refusal
carries a bare next_action" (#3102). The claim holds for refusals that
carry a `next_action`; these three carry none at all, and the transport /
upstream-5xx case — where "re-run the same quote with the same
idempotency_key" is the one thing an agent needs to hear — is the branch
with nothing. Mutation M5 (below) shows the next-step ratchet
(`next-step-refusal.test.ts`) guards the state-error branch only.
Expected benefit: a merchant or backend hiccup stops reading as a dead end
to an agent that has no other signal. Scope: `errors.ts` (three branches
gain a step: a 5xx / transport `HavenApiError` → "retry the same tool with
the same arguments once", a 4xx → `stop_and_tell_user` with an omitted
reason, `UNKNOWN_ERROR` → omitted reason), the characterization test, the
epic #3105 contract note — one PR, money-path by file. Verification: the
live 500 replayed as a unit case; `next-step-refusals-characterization`
extended to the three branches; mutation red. Tracking: `gh issue list
--search "API_ERROR next_action"` / `UNKNOWN_ERROR` → nothing open; #3102
(closed) did not enumerate these branches.

**C1 — `mcp-runtime-compatibility.md` cites 44 tracked paths and covers 42
entries; 7 cited paths sit outside every declared glob, 0 of them in this
run's four-package scope.** Block 2 at `e42ed68f`, under `bash` with
`set -f`: `packages/sdk/src/agent-guidance.ts`, `packages/sdk/src/connector-channel.ts`,
`packages/sdk/src/skill-content.ts`,
`packages/frontend/src/hooks/useAgentConnectionSetupStatus.ts`,
`scripts/README.md`, `scripts/release-bump.test.mjs`,
`scripts/verify-connect-bundle.mjs`; `node scripts/docs/coupling-gate.mjs
--changed=<path>` names the doc for none of the seven, run one at a time.
`connector-channel.ts` is the dev-channel constant the doc's manifest prose
depends on, so a change there never re-implicates the runtime contract.
*Corrected before merge (2026-09-21, same day):* this paragraph first read
"21 cited-but-not-covered, 9 in scope" and listed signer, mcp and mcp-server
files — all of which `packages/signer/**`, `packages/mcp/**` and
`packages/mcp-server/src/tools/**` do cover. The number came from the
reference loop as published: its unquoted `for g in $declared` let the shell
expand each `**` glob into directory entries before the match, so every
glob-covered file counted as a miss; the coupling gate, asked directly,
names the doc for `packages/signer/src/sign-context.ts` and
`packages/mcp/src/tools.ts`. The 2026-09-15 and 2026-09-17 ledger figures
for this doc (17 of 27 / 17 of 28) — and the same figure in
`quality-scan-2026-09-17-agent-surface.md` §4 — were taken the same way and
are not comparable; the reference gains `set -f` in the PR that records this. The
x402 sequence doc, which declares no `**` glob, reads 26 / 45 / 3 either
way (control). Scope: the `covers:` block, one PR, no prose — plus a
decision on whether re-verification notes are allowed to cite files the
doc does not cover (they are the source of the drift). Verification: block
2's loop (with `set -f`) → `cited-but-not-covered=0` for the doc; `npm run
docs:coupling` green.

**Notes, not filed** (below the bar or already tracked):
- N1 — the strict-refusal explanation for an unknown key is the cap
  paragraph even when the unknown key is `url` (rename, not cap); one
  sentence in `packages/mcp-server/src/tools/parsing.ts`'s copy, cosmetic until an agent is misled by it.
- N2 — the stale qa-dev signer runtime on this machine (§1): #3119/#3121's
  class; the operator step is `npx @haven_ai/connect@dev` after a publish.
- N3 — the status read's `payerAddress` is the delegate while the receipt's
  is the treasury account (F1's legacy field, unchanged); `parties` is the
  canonical read and is present on both — no delta against 2026-09-13.
- N4 — `haven_check_funds`'s `next_step` on success is prose
  ("ask haven_get_allowances …"), not `next_tool_*` — the success half of
  F3 / proposal 1, pending the owner since 2026-09-13.

## 4. Coverage record (block → examined / partial / not examined → command → result)

- Sizing → examined → `git ls-tree -r --name-only origin/dev packages/<p>/src | grep '\.ts$'`, split on `.test.ts|__tests__`, `git show | wc -l` summed → signer 3,536 / 5,190 (09-17: 3,042 / 4,417); mcp 1,959 / 3,691 (1,863 / 3,577); mcp-server 7,627 / 14,683 (6,830 / 13,407); demo-merchant-mcp 3,741 / 4,042 (3,556 / 3,746).
- Block 1 (guard falsifiability) → examined, 5 of a 64-file census → the reference's census script at `e42ed68f` → 64 candidate files; in scope, newest landing first: **5 mutations, 5 caught** — M1 #3169 `packages/signer/src/tools.ts:542` refusal removed → `server.test.ts` 4 red (`core.test.ts` stays green: its #3169 case pins the absence of a raw-hash primitive, the tool-layer refusal is `server.test.ts`'s); M2 #3172 `packages/signer/src/audit.ts:63` rotation bound → never → `audit.test.ts` 2 red; M3 #3171 `packages/demo-merchant-mcp/src/http.ts` `-32001` recovery `data` dropped → `http-session-restart.test.ts` 2 red; M4 #3116 `packages/sdk/src/x402-protocol.ts` `unsupportedOnly = false` (sdk rebuilt) → `catalog-purchase.test.ts` 4 red; M5 #3102 `packages/mcp-server/src/tools/support/errors.ts:225` next-step family dropped → `next-step-refusal.test.ts` 3 red. Each restored byte-identically (`cmp`), `git status` clean. **Instrument lesson recorded:** the first pass of M1/M5 ran with a BSD-`sed` substitution that did not apply (`grep -c mutated` → 0) and reported green — a would-be false survivor; the census worktree also had to be `npm ci`'d, since a `node_modules` symlink resolves workspace packages to the main checkout (`Missing "./edge" specifier`, `checkFunds` undefined). Not examined: the 59 other candidates; `consent.test.ts`/`cli-args.test.ts` (#3173) beyond the census.
- Block 2 (`covers:` completeness) → examined, all 8 contract docs → the reference's loop under `bash` (with `grep -rl`; `rg` is not on bash's PATH) with `set -f` — the published loop's unquoted `for g in $declared` globs `**` entries into directory names and counts every glob-covered file as a miss; first reading 21, corrected same day → in scope: runtime doc 44 cited / 42 declared / 7 not covered, 0 in the four-package scope (C1); `04-x402-payment-sequence.md` 26 / 45 / 3 (identical with and without `set -f`; `packages/backend/src/modules/mpp/reconciliation.ts`, `packages/core/src/machine-payment-lifecycle.ts`, `packages/sdk/src/payment-mappers.ts` — out of scope); the other six unchanged from 09-15.
- Block 3 (stale numbers) → partial → the ledger's 09-17 sizing re-derived above (all four grew); the four package READMEs not re-swept this run.
- Block 4 (retired vocabulary) → examined → the reference's term list over the full tracked set at `e42ed68f` → 192 files (192 on 09-15), 46 historical / 146 live; positive control 36 shards; **in scope 16 live files** (09-17: 15; first written as 10 — a hand sub-count, corrected before merge to the instrument's reading) — 7 tests, 2 package READMEs (`packages/mcp/README.md`, `packages/mcp-server/README.md`) and 7 non-test files (9 lines, three of them strings rather than comments) each describing the term as history (`packages/mcp/src/consent.ts:19-20`, `packages/mcp-server/src/tools/catalog-purchase.ts:684,699`, `packages/mcp/src/tools.ts:560`, `packages/mcp/src/server.ts:112`, `packages/mcp-server/src/server.ts:102`, `packages/mcp-server/src/tools/contracts.ts:963`, `packages/mcp-server/src/tools/support/quote-response.ts:208`); `npm run lint:retired-rail-prose` → green. Safe-retirement pins: `git grep -l 'process.env.SAFE' -- packages/backend/src` → 0 (positive control `process\.env\.` → 57 files); the routing guard test, the retired-safe-names middleware + test and, since #3030, the four `retiredSafeInflowRoute(` registrations that put the 410 before request validation — present.
- Block 5 (merge-method drift) → not examined (out of scope; 09-15 baseline stands).
- Block 6 (nets with holes) → examined, money-verb half → the reference's `rg` + classifier command → 28 verb files, 18 outside the perimeter (09-15: 29 / 20 — the two that left are C1 #3098's); **in scope 3 verb files (`packages/signer/src/core.ts`, `packages/signer/src/settlement-child.ts`, `packages/demo-merchant-mcp/src/x402.ts`), 0 outside** — #3098 held. Copy-lint, visual-gate and docs-boundary halves not taken (out of scope).
- Block 7 (chain health, the ledger's name; not in the reference) → partial → dev backend `/health` `db: ok`; `haven_get_agent` `remainingIsFromChain: true`; `haven_check_funds` `budget_remaining_is_from_chain: true`; the Ampersend sandbox 402 on all three endpoints by direct `curl` — the chain and the merchant answered; no RPC latency figure taken.
- Incident clustering → examined → `gh issue list --state all --search "created:>=2026-09-17"` filtered to `area:mcp|area:signer|area:demo-merchant` → 30 of 65 issues; by class next_* 6 (epic #3105, closed), connector/doctor 6 (#3119 open, #3210 open — `packages/connect`, out of scope), vocabulary 4 (#3130 open), x402 protocol 3, agent reads 3, demo merchant 3, perimeter 1.
- Workflow archaeology → examined → `gh run list --limit 200` → 0 runs with `attempt > 1`, 4 failures; `ci.yml` last 60 → 45 success / 10 failure / 5 cancelled (09-17: 45 / 5 / 10); the 10 failures are all on feature branches mid-build (4 `Design visual regression` — the baseline round trip, #1777; 2 backend ratchets on #3030's branch; 2 frontend checks; 1 browser smoke; 1 cancelled) — none on `dev`, none in scope. `qa-dev.yml` last 40 → 40 / 40 success.
- Comment archaeology → examined → `git grep -E 'TODO|FIXME|HACK' origin/dev -- packages/<p>/src` → 0 in all four; the only comment repeated across ≥ 3 files is a fixture section banner.
- Live path → partial by design → reads and quotes only (agent, allowances, receipts, status, discovery ×2, catalog quote, MCP quote, x402 quote ×2, check_funds ×4, signer refusal ×1); no prepare, no signature, no settlement — the budget is 0.001 USDC and the mandate was read-only this pass.

## 5. Re-checked and unchanged (so they are not mistaken for new findings)

- 2026-09-13 B1 (badges): shipped, confirmed live 9 / 9. F1 (`parties`): live on receipts and status. F2 (a)/(b): the 50 GB fixture's quote says it never settles. F3: the key half live on the x402 quote; the success `next_*` half still pending (N4). 2026-09-17 F1 → #3105: closed; #3100 (arguments) and #3102 (state-error branch) confirmed live; D1 #3097 confirmed live (`retry_url` https).
- The 2026-09-13 report's §8 audit note (2026-09-21, #3206) lists B1/B2/B3/B6/B7/B8/B10/B11/B12 as "read as open"; the 2026-09-17 ledger entry records B1–B13 shipped. This run re-verified only B1 live (shipped). The two records disagree on the other eight; whoever closes #3206 should reconcile them against GitHub, not against either record.

## 6. Decisions requested

1. File D1 (one PR, `area:mcp`), D2 (one PR, money-path by file), C1 (one PR, docs) — or drop any of them with a reason. **Decided 2026-09-21: file all three → #3213 (D1), #3214 (D2), #3215 (C1, at the corrected figure); D1 and D2 are money-path by file (`packages/mcp-server/src/**`).**
2. The proposal-1 success half (N4) has been pending since 2026-09-13; a decision either way lets the next run stop carrying it. **Decided 2026-09-21: dropped — `rejected`; the next run does not carry it.**
