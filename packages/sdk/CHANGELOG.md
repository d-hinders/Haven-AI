# @haven_ai/sdk

Release headers are written by the release bump (`npm run release:bump`), never by
hand — true since the changelog-heading gap, and stated here only because it was asserted for a long
time while being false. The bump rewrites the `## Unreleased` heading below into
`## <version> — <date>`; add entries under `## Unreleased` and leave the heading
alone.

## Unreleased

- `@haven_ai/sdk/edge` (#3173): a second, ethers-free entry for the local signer — the error classes, the refusal/next-action code enums and constants (`AgentPaymentFailureCode`, `AgentPaymentNextAction`, `SignerRefusalCode`, `SIGNER_UPDATE_FALLBACK`), `createNextStepBuilder`, `connectorRerunCommand` and `HAVEN_CONNECTOR_CHANNEL`, the Node-floor helpers, base64 helpers, the x402 message builders (`buildX402ExpectedMessage`, `selectStandardPaymentOption`, `toStandardPaymentRequirements`, `x402AuthorizationAmount`, `x402V2PaymentEnvelope`), the sweep builders, and `addressFromKey` / `signHash` / `verifySignature` re-implemented on viem + `@noble/curves` (new direct dependency, pinned `1.9.1` — exactly what viem pins, so a consumer install of sdk + viem hoists one copy; in this monorepo a newer copy is hoisted for other dependents, so the SDK resolves its own nested `1.9.1` beside viem's nested `1.9.1` — two instances of the same version, exchanging only hex strings, which the byte-equivalence test does not depend on) with byte-equivalence to the ethers forms pinned by test. `edge-imports.test.ts` fails if the subpath's import graph ever reaches ethers, `x402`, the client or its transports. The package barrel is unchanged. **Build:** tsup now emits a shared chunk (`dist/chunk-*.js` / `.cjs`) so a class imported from the barrel and from the subpath is the same class (`instanceof` across the two entries holds, verified in ESM and CJS).
- Unknown-session recovery on the paid retry (#3171): when the merchant answers the paid `tools/call` with HTTP 404 + JSON-RPC `-32001` carrying `error.data = { settled: false, next_action: 'reinitialize_then_retry_same_payment_header' }`, `fetch()`, `payX402Quote()`, `resumeX402Payment()` and `completeX402MerchantCall()` re-initialize once and resend the SAME payment header on the new session instead of surfacing `merchant_status=404` as a rejection after funding. Only that exact shape licenses the resend — a bare `-32001`, any other 404, a failed re-initialize or a second 404 is returned unchanged. Internal `mcp-merchant-transport` module: `deliverPaymentRecoveringSession`, `sessionNotFoundRecovery`, `SESSION_NOT_FOUND_NEXT_ACTION` (not on the package index); the `HavenClient` facade and public export list are unchanged.
- `HavenPaymentReceipt.scope` (#3132): each receipt row states its list scope as two values, `{ source: 'agent', filter: null }` — this agent's evidence rows, no query-time narrowing — so a receipt read is never mistaken for the wallet's transaction history (`GET /transactions`, `{ source: 'wallet', filter }`). Present when the backend states it; absent on an older backend, never invented. `haven_list_receipts`'s selection guidance says the same in words. New type export `HavenListScope`.
- Native x402 MCP transport profile (#3118): `fetch()`, `quoteX402()`, `quoteMcpX402()` and `completeX402MerchantCall()` now recognise a payment-required TOOL RESULT (`isError: true`, `PaymentRequired` as `structuredContent`, text fallback) answered with HTTP 200 and quote it like a 402; the paid retry adds the payment as `params._meta["x402/payment"]` beside the unchanged `PAYMENT-SIGNATURE` / `X-PAYMENT` headers whenever the body is a `tools/call` request; settlement is read from `result._meta["x402/payment-response"]` when there is no `PAYMENT-RESPONSE` header. An in-band refusal (an `isError` challenge on the paid retry, or `success: false`) is a rejection, never a success. The tool-result challenge is read only from a response declaring `application/json` or `text/event-stream`; any other content type passes through untouched. The helpers live in the internal `mcp-merchant-transport` module (not on the package index); the `HavenClient` facade and the public export list are unchanged.

## 0.4.0-alpha.0 — 2026-09-19

- #3128: `listReceiptsPage({ limit, cursor })` returns `{ receipts, total, hasMore, nextCursor }` (the three page fields are `null` against a backend older than #3128); `listReceipts()` keeps returning the first page's array. `HavenAllowance.remainingDisplay` (derived client-side) and `HavenAgentAllowanceSummary.id` / `.tokenAddress` added, so the compact and detailed allowance reads agree field for field. `haven_list_receipts` on both MCP runtimes accepts `cursor` and returns the page object instead of a bare array.

## 0.3.0-alpha.0 — 2026-09-17

### Removed

- **BREAKING (#2914, naming epic #2906 phase 5).** The Safe-vocabulary
  compatibility half promised by 0.2.0-alpha.0 is gone, one release later as
  stated there.
  - `safeAddress` leaves `HavenAgent` and `HavenAllowanceSummary`;
    `safe_address` / `safe_id` leave the raw server shapes.
  - `SignData.components.safe` is gone. `payer_account` is the account the
    payment is drawn from; `components.account` still means the DELEGATE
    account address — a different address, deliberately never merged.
  - `AgentPaymentNextAction.FundSafeOrRaiseAllowance` is now
    `FundAccountOrRaiseAllowance`, value `fund_account_or_raise_allowance`.
    `AgentPaymentNextActionAccountAlias`, `canonicalAgentPaymentNextAction`
    and `isFundAccountOrRaiseAllowance` are deleted — there is one spelling to
    switch on now.
  - The dual-name read helpers collapse to single-name reads.

## 0.2.1-alpha.0 — 2026-09-16

### Added

- `reportSettlementEvidence(paymentId, settlementTxHash)` on `MerchantCompletion` — an
  erc7710 agent hands Haven the merchant's settlement hash, which Haven verifies
  on-chain before the payment counts as settled (#2973).
- `HavenPaymentReceipt.fundingTxHash` and `.settlementTxHash` name the two legs the
  single unlabeled `txHash` conflated; `txHash` is now `@deprecated` but still emitted
  (#2998).
- `parties` on `HavenPaymentReceipt` and `AgentPaymentSummary` —
  `{ treasury_account, delegate, delegate_account, merchant }` (#2965). Optional.
- `EvidenceReportOutcome`, `HavenZeroSettlementHashError`, `isZeroSettlementTxHash`.

### Changed — read this before upgrading

- **`settled` now means verified.** An erc7710 payment where the merchant returned 200
  without an on-chain confirmation reports `settled: false` where it previously
  reported `true`, and a zero transaction hash never rides out (#2968, #2971). If you
  branch on `settled`, this is a behaviour change, not only a type change.
- **Two exported unions widened**, which is a compile-time break for consumers doing an
  exhaustive `switch` with a `never` check, or building their own
  `Record<AgentPaymentFailureCode, string>`:
  `AGENT_PAYMENT_NEXT_ACTION_VALUES` gains `"awaiting_settlement_evidence"`, and
  `AGENT_PAYMENT_FAILURE_CODE_VALUES` gains `"MERCHANT_NOT_READY"`. No value was
  removed; runtime behaviour for existing values is unchanged.
- `MERCHANT_UNRESPONSIVE_AFTER_FUNDING` on erc7710 no longer advises a sweep — there is
  no funding leg to sweep on that scheme — and says to check status instead (#3000).

### Known gap

- `PaymentParties` is declared but **not re-exported from the package barrel**, so the
  type named by the two `parties` fields above cannot be imported by name yet. The
  fields are structurally usable. Tracked for a follow-up; not fixed in this release,
  which is a version bump.

## 0.2.0-alpha.0 — 2026-09-14

### Breaking (public type shape) — naming epic #2906, phase 1 (#2908)

Under the 0.x convention this is a **minor** bump (`0.1.x → 0.2.0`). Every
renamed field is additive during the one-release window: the new name is
added, the old name is kept with the same value and a `@deprecated` JSDoc.
**Removal release: the release after the one carrying #2908 (#2914).**

| Old (deprecated, removed at #2914) | New | Where |
|---|---|---|
| `PaymentReceipt.payment.safe` | `PaymentReceipt.payment.account` (optional for the window) | `getReceipt()`/`verifyPaymentReceipt()` input — additive; verification reads only `authorization` |
| `HavenAgent.safeAddress` | `HavenAgent.accountAddress` | `getAgent()`, `getAgentSummary()` (also the hosted `haven_get_agent` output) |
| `HavenAllowanceSummary.safeAddress` | `HavenAllowanceSummary.accountAddress` | `getAllowances()` (also the hosted `haven_get_allowances` output) |
| `RawHavenAgent.safe_address` (now optional) | `RawHavenAgent.account_address` | `@internal` wire shape |
| `RawHavenAllowanceSummary.safe_address` (now optional) | `RawHavenAllowanceSummary.account_address` | `@internal` wire shape |
| `RawX402AuthorizeResponse.safe_address` | `RawX402AuthorizeResponse.account_address` | `@internal` wire shape |
| `SignData.components.safe` | `SignData.components.payer_account` | response metadata — NOT part of the signed expected-context payload; no version change |
| `AgentPaymentNextAction.FundSafeOrRaiseAllowance` (`fund_safe_or_raise_allowance`) | `AgentPaymentNextActionAccountAlias.FundAccountOrRaiseAllowance` (`fund_account_or_raise_allowance`) | accepted and documented now; the server keeps emitting the old value until #2914 |

Added: `AgentPaymentNextActionWire` (the `AgentNextStep.next_action` type,
widened by the alias), `canonicalAgentPaymentNextAction()`,
`isFundAccountOrRaiseAllowance()`, and the `account-naming` helpers
`readAccountAddress()`, `readAccountId()`, `accountAddressTwins()`,
`readX402ReceiptPayer()`.

Behaviour: the x402 receipt builder resolves `payer` as
`raw.payer ?? raw.account_address ?? raw.sign_data?.components.payer_account ?? raw.safe_address ?? raw.sign_data?.components.safe`
(never `components.account`, which is the delegate). `next_action` values are
canonicalised at the read boundary, so a `switch` on the taxonomy const keeps
matching after the server flips its emit. Tool descriptions document both
enum spellings, list `accountAddress` first with `safeAddress` as a deprecated
alias, and say "originating account" instead of "originating Safe".

`SUPPORTED_X402_EXPECTED_VERSIONS` is untouched (`[1, 2, 3]`).
