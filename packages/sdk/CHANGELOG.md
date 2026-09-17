# @haven_ai/sdk

Release headers are written by the release bump (`npm run release:bump`), never by
hand — true since the changelog-heading gap, and stated here only because it was asserted for a long
time while being false. The bump rewrites the `## Unreleased` heading below into
`## <version> — <date>`; add entries under `## Unreleased` and leave the heading
alone.

## Unreleased

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
