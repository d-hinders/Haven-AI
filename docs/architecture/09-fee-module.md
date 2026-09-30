---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/modules/fee/**
  - packages/backend/src/modules/payments/agent-payment-status.ts
  - packages/backend/src/modules/mpp/**
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/db/migrations/029_payment_fees.ts
  - packages/backend/src/config.ts
  - packages/sdk/src/payment-mappers.ts
  - packages/sdk/src/types.ts
  - packages/sdk/src/payment-fee.test.ts
last-verified: "2026-09-30"
---

# Haven — Platform fee scaffold and target design

Haven does not currently collect a platform transaction fee. The backend has a
zero-fee scaffold so payment responses and evidence can carry a stable fee
shape before any non-zero pricing or settlement is enabled.

## Current behavior

- `packages/backend/src/modules/fee/fee-module.ts` always quotes zero, including
  when `HAVEN_FEE_ENABLED` is set.
- No fee executor, treasury transfer, pricing tier, or quota source runs.
- Payment status/result responses expose the zero-fee result; the SDK maps that
  public shape.
- After settlement, machine-payment evidence best-effort records a zero-fee
  ledger row.
- Ledger insertion is idempotent by payment identity.

Therefore no Haven fee changes allowance consumption, merchant proceeds, or
on-chain transfers today.

## Deferred target

Epic #386 describes a possible future rail-agnostic policy and accounting
module with rail-specific settlement executors. Before non-zero fees can be
enabled, an implementation and review must establish all of these:

- The user sees the gross payment, fee, and total before authorization.
- The Haven wallet is never charged above the approved total.
- The merchant receives the stated payment amount in full.
- Retries cannot charge or record the fee twice.
- Every collected fee has reconcilable on-chain evidence.
- x402, MPP, direct payments, hosted MCP, and local MCP have explicit,
  reviewed policy rather than topology inferred from the caller.
- Treasury addresses, rate/tier/quota sources, failure behavior, and fee
  settlement are implemented and tested per supported chain.

The proposed mechanisms—such as funding an x402 delegate with payment plus fee
or using a multi-send for MPP—are design options, not current behavior.

Any move from zero to non-zero fees changes money movement and must follow the
current agentic workflow, CASP guardrails, the `money.md` characterization-test
bar, and explicit human review.

See [x402 payment sequence](04-x402-payment-sequence.md) for the current funding
mechanics and [CASP / MiCA guardrails](../regulatory/casp-risk-guardrails.md)
for authority constraints.

Re-verified 2026-09-30 (weekly docs audit #3413, at dev `5b5bd059`). No claim
needed rewriting; `modules/fee/` and migration 029 have no commits since the
last verification. Re-read at this head: `quoteFee` still returns the zero
quote unconditionally — including when `HAVEN_FEE_ENABLED` is set
(`fee-module.ts` zero-quote branch at both flag states); the ledger write
stays the best-effort zero-fee row, idempotent per payment via
`ON CONFLICT DO NOTHING` in `infra/repositories/payment-fees.ts`; the SDK
still maps the same public `fee` shape (`payment-mappers.ts`). The covered
commits that did move (`routes/payments.ts`, `modules/mpp/`,
`modules/payments/agent-payment-status.ts` — #3423 settle semantics, #3420
terminal delivered-unsettled status, #3479 settlement recording) changed
payment status and settlement handling around the scaffold, not the fee
shape or the zero-fee path.
