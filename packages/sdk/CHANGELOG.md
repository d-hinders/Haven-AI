# @haven_ai/sdk

Release headers are written by the release bump (`npm run release:bump`), never by hand.

## Unreleased

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
