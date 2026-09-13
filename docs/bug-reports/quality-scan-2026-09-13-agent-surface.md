---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp-server/src/tools/paid-mcp-completion.ts
  - packages/mcp-server/src/tools/catalog-purchase.ts
  - packages/backend/src/modules/x402/settlement-observed.ts
  - packages/backend/src/modules/x402/x402-delegation.ts
  - packages/backend/src/modules/payments/agent-payment-status.ts
  - packages/backend/src/modules/catalog/lifecycle.ts
  - packages/backend/src/testing/__tests__/mock-factory-exports.guard.test.ts
  - packages/backend/src/modules/x402/settlement-sweeper.ts
  - packages/backend/src/rails/execution-rail.ts
  - packages/backend/src/routes/__tests__/retired-rail-routing.guard.test.ts
  - packages/mcp-server/src/description-size.test.ts
  - docs/operations/agent-qa.md
  - docs/operations/demo-agent-purchase-runbook.md
  - packages/backend/src/__tests__/execution-rail-live-census-pin.test.ts
  - packages/sdk/src/x402.ts
  - packages/signer/src/sign-context.ts
  - packages/signer/src/tools.ts
  - packages/demo-merchant-mcp/src/x402.ts
  - packages/demo-merchant-mcp/src/http.ts
  - packages/demo-merchant-mcp/src/invoice.ts
last-verified: "2026-09-13"
---

# Quality scan — the agent surface (safe-retirement, MCP, signer, demo merchant) — 2026-09-13

Owner mandate (2026-09-12): after the naming chain, scan safe-retirement, the
Haven MCP (hosted + local), the signer and the MCP demo merchant for bugs and
for what would make them smoother to use; propose improvements and features;
do not rely on local testing alone. This report is the scan's output under the
[`quality-scan`](../../.agents/skills/quality-scan/SKILL.md) bar; the ledger
entry is in [`docs/quality/scan-ledger.md`](../quality/scan-ledger.md). Nothing
is filed — every finding waits for the owner's disposition. **Deliberate
deviation from the skill:** the mandate asked for bugs and proposals as well
as structural findings, so this report carries three findings (the skill says
top 1–2), a defect table (§ 3) and proposals (§ 5) that the skill would
otherwise leave out; the ledger entry keeps the skill's shape.

## Method

- **Live exercise on dev** (Base Sepolia `84532`, agent `Test2`
  `b2808f80…`, 1 USDC daily budget) through the connected hosted MCP and the
  local signer, exactly as an agent would: `haven_get_agent` →
  `haven_discover_tools` → `haven_quote_catalog_purchase` →
  `haven_prepare_catalog_purchase` → `haven_sign` → `haven_settle_mcp_tool` →
  `haven_get_payment_status` / `haven_list_receipts`, plus deliberate misuse
  (prepare twice without a key, a cap below the price, the `verified` filter).
  Two testnet purchases were made (0.0005 + 0.001 USDC). Payment ids:
  `941c667e`, `86f70974`, `2fbf43c0`, `9deb902e` (the last two left at
  `pending_signature` on purpose — they expire).
- **Four read-only explorations** (one per area) over `origin/dev`
  `c3f0eddc`, followed by **my own verification** of every claim quoted below
  against the code or live. Claims I could not verify are listed separately
  in § 6 so nobody mistakes them for findings.
- The ledger's prior findings (2026-07, 08-14, 08-18, 08-19) were read and
  excluded; the *in-memory-state / restart* class refused on 2026-08-19 is
  not re-surfaced (no delta measured).

## 1. What the live exercise showed

| step | result | note |
|---|---|---|
| `haven_get_agent` | `ready`, `accountAddress` `0xc70f…`, `delegateAddress` `0xa3dc…` | both names present (P1 #2908 dual-emit works on dev) |
| `haven_discover_tools` | 6 operator entries, every one `domain_verified:false`, `verified_payable:false` | see B1 |
| `haven_discover_tools verified=verified` | `[]` | the tool's own description recommends this filter — it hides the operator's demo merchant (B1) |
| quote 50 GB | `0.0005 USDC`, `accepted_scheme: "standard"` | the quote does not say the purchase will settle erc7710; `prepare` does |
| **purchase A** `storage_50gb` | `settled: true`, `settlement_tx_hash: 0x000…000`, merchant text "Purchase confirmed … Status: Paid … Tx: 0x000…", invoice `FAK-2026-1789252832`, budget unchanged 1.0 USDC, `agent_summary.status: "submitted"`; status afterwards `submitted / check_status_later / txHash null` (still, 30 min later) | `storage_50gb` is the dev **skip-settle QA fixture** (`MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb`, `docs/operations/agent-qa.md:151`). See F2 / B5 / B6 |
| **purchase B** `vpn_basic` | `settled: true`, real hash `0xc632…`, status `confirmed`, budget 0.999, receipt row present with `proofStatus: protocol_receipt_attached` | the real erc7710 path works end to end |
| merchant invoice BUYER / `PAYMENT-RESPONSE.payer` | `0x69c033…` | a **third** address for "the payer" — see F1 |
| `haven_sign` (signer) | `{ signature, x402_binding }` | no `next_action` / `next_tool` on the signer's success shape (B4) |
| prepare 200 GB twice, no `idempotency_key` | two different `payment_id`s (`2fbf43c0`, `9deb902e`), both `pending_signature`, both with `idempotencyKey: null` | see F3 / B2 |
| prepare with cap `0.0001` below the `0.0015` price | `{ code: PRICE_EXCEEDS_MAX, message, statusCode: 400 }` — no `next_action`, no `next_tool` | see F3 / B3 |

## 2. Findings that meet the bar (structural, measured, costed, splittable)

### F1 — There is no single "party" model: three different addresses are called the payer of one payment

- **Evidence (one payment, `86f70974`):** `haven_list_receipts` →
  `payerAddress: 0xc70f…` (the treasury/smart account) and
  `settlementAddress: 0x55c9…` (the merchant); `haven_get_payment_status` →
  `payerAddress: 0xa3dc…` (the delegate EOA —
  `packages/backend/src/modules/payments/agent-payment-status.ts:780`
  `payer_address: payment.delegate_address`); the merchant's
  `PAYMENT-RESPONSE.payer` and invoice BUYER → `0x69c033…` (the delegate
  *smart account* — `packages/backend/src/modules/x402/x402-delegation.ts:211`
  `delegator: delegateAccountAddress`). On the 2026-08-13 EIP-3009 receipt the
  merchant's `payer` was the delegate EOA instead. The signer's context adds
  `payerDelegate`, and P0 (#2907) just shipped `components.payer_account` as a
  twin of `components.safe` precisely because `components.account` already
  meant the delegate. Tally of wire shapes naming a payer:
  `git grep -c -i "payer_address\|payerAddress\|payer_account\|payer:\|payerDelegate"`
  → `openapi/spec.ts` 7, `sdk/src/types.ts` 10, `demo-merchant-mcp/src/x402.ts` 4,
  `signer/src/core.ts` 6 — 27 sites, resolving at runtime to three distinct
  addresses for one payment.
- **Cost, demonstrated:** the naming-epic review (#2906) spent a round on
  exactly this collision; the invoice a Swedish bookkeeper receives names a
  buyer address that appears nowhere in Haven's receipts; an agent
  reconciling `payerAddress` across two Haven tools gets two answers.
- **Changes how contributors work:** every new surface today picks its own
  meaning of "payer". A party vocabulary (`treasury_account`, `delegate`,
  `delegate_account`, `merchant`) with one mapper per wire shape would make
  the choice a lookup, not a judgment, and the naming epic's P5 contraction
  (#2914) is the natural place to land it.
- **Slices:** (a) backend payment-status + receipts emit the party triple;
  (b) `x402-delegation` / merchant `PAYMENT-RESPONSE.payer` documented as the
  delegate account with the treasury alongside; (c) SDK/CLI/MCP mappers and
  `tool-descriptions`; (d) demo-merchant invoice shows treasury + delegate
  account; (e) Fortnox feed uses the treasury as counterparty (verify first).

### F2 — "Settled" is decided by the merchant's HTTP 200, not by settlement evidence

- **Evidence:** `packages/mcp-server/src/tools/paid-mcp-completion.ts`
  (erc7710 branch) returns `settled: merchant7710.ok` and passes
  `settlement_tx_hash` through unchecked — purchase A returned
  `settled: true` with the zero hash and `next_action: none`. On the backend
  `settlement-observed.ts` (#2092) is fail-closed by design: an unverifiable
  hash leaves the intent `submitted`, so `941c667e` is `submitted /
  check_status_later / txHash null` indefinitely, has **no receipt row**
  (`haven_list_receipts` shows only `86f70974`), and is therefore absent from
  the accounting feed while the agent was told the purchase is complete. The
  merchant side prints "Status: Paid" and a Swedish invoice for it
  (`packages/demo-merchant-mcp/src/x402.ts:913` returns
  `buildSettledPayment(…, ZERO_TX_HASH)` on the skip-settle hook, and `:628`
  on `AuthorizationAlreadyUsedError`).
- **Cost, demonstrated:** the runbook has to say "**NEVER `storage_50gb`**"
  (`docs/operations/demo-agent-purchase-runbook.md:66`) because the dev
  catalog lists the fixture as an ordinary product; on dev a demo or a cold
  agent that picks the cheapest tier gets a "Paid" invoice for nothing, and
  Haven's own status never resolves (the fixture is chain-gated to Base
  Sepolia — `packages/demo-merchant-mcp/src/x402.ts:77`, PR #1277 — so this
  cannot happen off testnet; the `AuthorizationAlreadyUsedError` zero-hash path
  at `:628` is not gated). `settlement-sweeper.ts:655/707/783` already
  carries three log lines for the "settled but no evidence" hole.
- **Changes how contributors work:** one definition of *settled* — "an
  on-chain transfer Haven verified" — enforced at the hosted tool, with a
  distinct `delivered_unsettled` outcome for the merchant-says-200 case,
  removes a class of "why is this payment stuck" tickets and makes the
  fixture safe to list.
- **Slices:** (a) hosted `settle`/`complete`: `settled` requires a non-zero
  hash that the backend verified (or an explicit `delivered_unsettled` with
  `next_action`); (b) demo merchant: skip-settle and already-used paths
  answer with a distinct status and no "Paid"; (c) catalog: fixture products
  carry a `qa_fixture` flag and are hidden from `haven_discover_tools` by
  default; (d) `haven_get_payment_status` surfaces `awaiting_settlement_evidence`
  instead of `check_status_later` when nothing will be checked.

### F3 — Retry and idempotency are prose, not protocol

- **Evidence:** `haven_prepare_catalog_purchase` without a key creates a new
  intent every call (`2fbf43c0`, `9deb902e`, `idempotencyKey: null` — the
  catalog path passes `args.idempotency_key ?? quote.idempotencyKey`,
  `packages/mcp-server/src/tools/catalog-purchase.ts:294,696`, and the erc7710
  quote carries none), while the plain x402 path derives
  `x402:<sha256>` over resource/payTo/asset/amount/network **and a 5-minute
  bucket** (`packages/sdk/src/x402.ts:24` `X402_IDEMPOTENCY_BUCKET_MS =
  300_000`, `:898-913`) — so a retry after the bucket boundary is a second
  payment and nothing tells the agent which side of the boundary it is on.
  The `PRICE_EXCEEDS_MAX` refusal carries `code`/`message`/`statusCode` only —
  no `next_action`, no `next_tool` naming the quote tool — while every success
  carries the full `next_*` block. The signer's success shape carries no
  `next_*` at all (`packages/signer/src/tools.ts:194-199` puts the next step
  in the description prose).
- **Cost, demonstrated:** `gh issue list --state all --search idempotency` →
  55 issues; `next_action` → 27; the closed cluster #2145 / #2290 / #2292 /
  #2366 / #2393 is this class (recovery guidance that lived in prose, spelling
  divergence local vs hosted).
- **Changes how contributors work:** a response contract — *every* tool
  response and *every* refusal carries `code`, `next_action`, `next_tool_*`,
  and echoes the `idempotency_key` it used (auto-generated when absent) —
  turns "read the description" into "follow the field", and the description
  budget (`description-size.test.ts`) stops carrying protocol.
- **Slices:** (a) hosted tools: idempotency key auto-generated and echoed on
  prepare/pay; (b) refusals carry `next_*` (`PRICE_EXCEEDS_MAX` →
  quote tool with the same args); (c) signer responses carry `next_*`;
  (d) bucket boundary surfaced (`idempotency_window_ends_at`); (e) the
  `nextAction` enum gains `requote` and `report_or_sweep`.

## 3. Verified defects (each small enough for a `new-task`; not epics)

| id | what | evidence | severity |
|---|---|---|---|
| B1 | `haven_discover_tools verified=verified` hides the operator's own demo merchant; operator entries are never probed to `verified_payable` | live `[]`; `packages/backend/src/modules/catalog/lifecycle.ts:223-232` builds probe candidates from `ownership_verified` rows and verified rows due for re-check only — an operator row never reaches the probe | medium (demo/cold-agent UX) |
| B2 | catalog prepare creates a new intent per call with `idempotencyKey: null` | live; `catalog-purchase.ts:294,696` | medium (double-pay if an agent signs twice) |
| B3 | `PRICE_EXCEEDS_MAX` has no `next_action`/`next_tool`; message reads "1500 exceeds max_amount_human 0.0001 USDC (= 100 atomic) (USDC, atomic units)" | live | low |
| B4 | signer success (`haven_sign`) carries no `next_*` fields | live; `signer/src/tools.ts:194-199` | low |
| B5 | hosted settle accepts a zero settlement hash as `settled: true`, `next_action: none` | live `941c667e`; `paid-mcp-completion.ts` erc7710 branch | high (part of F2) |
| B6 | the dev catalog lists the skip-settle fixture as a normal product | live; `agent-qa.md:151`, runbook `:66`; dev-only by the chain gate (`x402.ts:77`) | medium |
| B7 | demo merchant `/mcp` never consults settlement readiness; only `/healthz` does (`http.ts:98`) — an out-of-gas merchant answers 402s with no reason | code read | medium (demo reliability) |
| B8 | invoice counter seeded from `Date.now()/1000` collides after a restart when more invoices were issued than seconds elapsed (`invoice.ts:27-33`) | code read | low |
| B9 | signer `fetchX402SignContext` has no timeout/abort signal (`sign-context.ts:72-92`) — a hung `/sign-context` hangs the agent | code read | low-medium |
| B10 | `packages/backend/src/testing/__tests__/mock-factory-exports.guard.test.ts` covers `vi.mock(` only; 3 backend test files use `vi.doMock(` (`git grep -l "vi.doMock(" -- 'packages/backend/src/**/*.test.ts'` → 3) — the defect class it caught on #2935 has an unguarded neighbour | code read; reviewer on PR #2935 | low |
| B11 | on an EIP-3009 receipt `txHash` (Haven funding tx) ≠ `protocolReceiptPayload.transaction` (merchant settlement tx) with no field naming which is which | 2026-08-13 receipt `dcc28fad` | low |
| B13 | the retired-rail routing guard's `PAYMENT_ENTRY_POINTS` allowlist limit is undocumented and its comment says "five" for four entries (`retired-rail-routing.guard.test.ts:161-166, :266`) | code read | low |
| B12 | `haven_quote_catalog_purchase` reports `accepted_scheme: "standard"` while `prepare` then settles erc7710 — the quote hides the scheme the agent will be asked to sign | live | low |

## 4. Safe-retirement — where it stands (read-only check, 2026-09-13)

- The rail is fail-closed at every agent entry point through
  `rails/execution-rail.ts` `sessionRailRetired()` /
  `allowanceModuleRailRetired()`; the structural guard
  `routes/__tests__/retired-rail-routing.guard.test.ts` pins four
  `PAYMENT_ENTRY_POINTS` (`payments`, `x402`, `machine-payments`,
  `agent-delegations`) — a fifth agent-spend route added tomorrow is outside
  the net until someone adds it; this limit is **not** among the nine the
  guard documents (its comment at `:266` also says "five pinned entry
  points" against a four-element array) — a small `new-task` (B13).
- Remaining: #2851 (drop `self_sign_agents`, `self_sign_payment_intents`,
  `owner_aliases`; waits on the operator census on #1440) and the naming P3
  #2911 (rename `user_safes` → `smart_accounts` + columns, quiesced deploy).
  #2911's body already says "if #2851 has not dropped it yet — order the two
  migrations and say which"; **recommendation: #2851 first**, so #2911 never
  renames a relation that is about to be dropped.
- No fail-open path found; the explorer's "no bug candidates" matched my
  spot-checks (`git grep "process.env.SAFE" -- packages/backend/src` → 0; the
  rail *decision* has one resolver — `ExecutionRailDecision` is exactly
  `delegation` plus two `retired_*` arms, pinned by
  `packages/backend/src/__tests__/execution-rail-live-census-pin.test.ts`; the
  column itself is read by 8 repository files, which is not the claim).

## 5. Proposals (features and improvements), ranked by evidence

1. **Response contract v2** (F3): every hosted and signer response carries
   `code`, `next_action`, `next_tool_*`, `idempotency_key` (auto-generated,
   echoed), `idempotency_window_ends_at`; refusals included. Evidence: 55 +
   27 issues in the class; live B2/B3/B4.
2. **Settlement evidence gate + `delivered_unsettled`** (F2): `settled` only
   with a backend-verified hash; a distinct outcome and `next_action` for
   merchant-200-without-evidence; fixture products flagged and hidden.
   Evidence: live `941c667e`; sweeper's three log lines.
3. **Party model** (F1): `treasury_account` / `delegate` /
   `delegate_account` / `merchant` on status, receipts, merchant receipt and
   invoice; land with P5 #2914. Evidence: three payer values for one payment.
4. **`haven_explain_payment` / signer "explain what I am about to sign"**:
   one read-only call returning the party triple, amount, merchant,
   scheme, expiry and the exact bytes the signer will sign — the agent can
   show the user before signing. Evidence: B12 (quote hides the scheme), the
   signer's refusal prose being the only explanation today.
5. **Catalog badges for operator entries** (B1): run the ownership/probe
   lifecycle on operator rows too, or badge them `operator_verified` so
   `verified=verified` returns them.
6. **`merchant_status` tool + 402 reason catalog on the demo merchant**
   (B7): expose settlement readiness (gas band, DelegationManager pin,
   nonce store) as an MCP tool and gate `/mcp` on it with a 503 + reason;
   402 bodies carry a machine-readable `reason_code`.
7. **`haven_signer_status` + structured consent refusals**: the MCP
   instructions say "a signer tool call is the signer check"; a status tool
   (version, supported context versions, credential key names found, Node
   version, consent state with `reason`) makes `connect --doctor` reachable
   from inside an agent session.
8. **Dry-run / preflight on prepare**: `dry_run: true` returns the cap/budget
   verdict without creating an intent — closes B2's half-open intents.
9. **`haven_get_spending_summary`**: period totals, pending authorizations,
   top merchants — the one question `haven_get_allowances` cannot answer.
10. **Demo merchant durability for demos**: persistent nonce + invoice store
    (file-backed on dev), `--explain` mode printing the exact x402 exchange,
    and a self-test that pays itself on testnet in CI.

## 6. Explorer claims I could not verify (recorded so they are not mistaken for findings)

- "Nine hosted tools have no strict-input refusal" — contradicts the same
  report's "20 of 22 strict"; the strict/permissive list was not
  re-derived here.
- "Consent-hash rotation on a new tool is untested" (local MCP) — not checked.
- "Signer CLI splits `--credentials` paths on spaces" — `process.argv` is
  already split by the shell; not reproduced.
- The safe-retirement report's merge dates for P0/P1/P2a ("2026-09-03") are
  wrong — they merged 2026-09-12/13 (#2930, #2933, #2932).
- Demo merchant "verification-before-handler race" — the handler gate reads
  the payment from the request's `AsyncLocalStorage`; a cross-request leak
  was asserted, not shown.

## 7. Decisions requested

1. F1–F3: epic each (via `new-task`'s Epics section), or fold F1 into the
   naming epic's P5 and F2/F3 into one "agent response contract" epic?
2. B1–B13: file as `new-task`s now, or bundle B1/B6 (catalog) and B7/B8
   (demo merchant) into two PRs?
3. Proposals 4, 7, 8, 9: which (if any) to take into the backlog as
   features.
