---
owner: "@d-hinders"
status: research
covers:
  - packages/backend/scripts/delegation-dod-matrix.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/lib/delegation-rail.ts
  - packages/backend/src/lib/delegation-authorization.ts
last-verified: "2026-07-24"
---

# Delegation rail — definition-of-done report (#835, epic #821)

Closeout evidence for [epic #821](https://github.com/d-hinders/Haven-AI/issues/821):
Haven's account/authority base rebuilt on MetaMask Hybrid DeleGator accounts +
the Delegation Framework, replacing the Smart Sessions / AllowanceModule rails
for new accounts. The eight build slices (#825–#833) are merged; this is the
[#835](https://github.com/d-hinders/Haven-AI/issues/835) definition-of-done —
merges don't close it, the live evidence does.

Per ship-next operator-verify discipline, the matrix is driven **entirely
through the production HTTP API** by `npm run pilot:dod` (the #739/#805/#798
standard: pilot scripts hit the real endpoints, zero manual DB steps). This is
strictly stronger than the per-slice lib smokes (#829/#830), which bypassed the
route layer — and that difference is exactly what caught the bug in §3.

## TL;DR

- **The full matrix passed live through the production API** — all eight rows,
  driven end to end by `pilot:dod` on Base Sepolia (account
  `0x8B9bfeC4B58ffF2c830c49F1F0b57daa8a4BCac1`).
- Driving the **production HTTP route** (which #835 requires, and no prior slice
  did — the per-slice smokes bypassed the route) caught **two money-path bugs**
  the unit tests and lib smokes never could: the token-config guard blocking
  delegation agents (§3, fixed #849), and the delegator/treasury Hybrid never
  being deployed (§4, filed #860).

## The proof matrix

| # | Proof | Status | Evidence |
|---|---|---|---|
| 1 | Fresh account provisioned | ✅ live (prod) | `POST /accounts/hybrid` → `0x8B9bfeC4B58ffF2c830c49F1F0b57daa8a4BCac1`; delegator deployed `0x38f15757a43a5d06f95c63bdf5a6d7ee754117ae2f3a694df335b0b0a728da70` |
| 2 | One-signature budget grant | ✅ live (prod) | `build`→owner signs the account's exact EIP-712 typed data→`activate`; 1 owner signature, 0 owner tx (activate relayer-deploys a counterfactual delegator, #860) |
| 3 | Within-budget payment | ✅ live (prod) | direct account→recipient, no funding leg — `0x1b85de04cacf2828ecfa539c471097fe38813ca70ca548b8c387a9465cd52756` |
| 4 | Overspend reverts | ✅ live (prod) | second in-period spend rejected on-chain; no funds moved |
| 5 | **Zero-signature refill** | ✅ live (prod) | spend to cap → period boundary → spend again, **no signature, no Haven cron** — `0x5eacf0130006af7f31212aec44b3901d49e18ec597c5a6bcb5303d492ff3727f` |
| 6 | N-recipient matrix | ✅ live (prod) | second recipient, distinct delegation — `0xcd22cad71beaa95dccc76bba67181ea741223e78cbbbdace470caec5ccc8660e` |
| 7 | Revoke kill-switch | ✅ live (prod) | `disableDelegation` → revoked delegation no longer authorizes payment |
| 8 | x402 direct settlement | ✅ live (smoke) | ERC-7710 treasury→merchant, single leg (#830) |

## §3 — first defect the DoD surfaced (fixed, #849)

`POST /payments` gated every request on an `agent_allowances` row (the
AllowanceModule per-token config) **before** it resolved the execution rail.
A delegation-rail agent is configured entirely through the delegation lifecycle
(#828) and the dashboard (#833) and holds **no** `agent_allowances` row — its
authority is the signed budget delegation. So the guard returned
`403 "Agent is not configured for USDC payments"` before the request ever
reached the delegation branch that would have authorized it on-chain.

It stayed latent because #829's proof was a **library** smoke that called
`prepareRedemption`/`submitRedemption` directly, never the HTTP route. #835's
requirement to drive the production endpoint is what exposed it — the whole
point of an operator-verify DoD.

**Fix:** resolve the execution rail first, then scope the allowance guard to
non-delegation rails (the delegation branch does its own authorization and
returns its own `403` when no delegation covers the token/recipient). The
session and legacy rails are unchanged; a non-delegation agent missing its
allowance row is still rejected (regression test added).

## §4 — second defect the DoD surfaced (blocks onboarding, #860)

A brand-new account's **first payment reverts** (`0x3db6791c` during
simulation): the redeeming UserOp deploys the *delegate* account (the redeemer),
but the *delegator/treasury* Hybrid that issued the budget delegation stays
counterfactual. On redemption the DelegationManager validates the delegator's
signature via EIP-1271 — which reverts on an account with no code.

`hybrid-provisioning.ts` states the intent (*"grant deploys if needed"*) but the
grant `activate` handler is a pure DB state change — nothing deploys the
treasury. #829's smoke passed only because its treasury was already deployed
from earlier pilot runs.

Deploying the treasury by hand (a sponsored no-op `createTreasuryOps` op,
owner-signed — `scripts/deploy-treasury.ts`, tx `0x38f15757…`) unblocked the
entire matrix above, so the mechanics are correct; only the lifecycle step is
missing. **Fixed by #860:** a 4337 factory deploy is permissionless, so grant
activation now deploys the delegator via the RELAYER's plain factory call —
no owner signature, no owner transaction; the one-signature grant UX is
preserved and non-custody is unchanged (the deployed account's signers are
the owner's keys). ERC-6492 was ruled out (no support in the kit/manager);
deploy-at-provisioning was ruled out (gas for accounts that may never grant).

## Gas / latency vs the session rail it replaces

*Populate from the `pilot:dod` run after §3 deploys; the runner reports
`actualGasUsed` per redemption. Baseline: the session-rail figures in
[session-key-pilot-report.md](session-key-pilot-report.md).*

| Metric | Delegation rail | Session rail (baseline) |
|---|---|---|
| Grant | 1 owner signature, 0 tx | 1 owner tx (migration) + session install |
| Payment | 1 agent signature, sponsored UserOp, direct account→recipient | 1 agent signature, sponsored UserOp |
| Refill | **native** at period boundary, 0 signatures, 0 Haven machinery | Haven schedule machinery (#769/#770) |
| Revoke | owner-signed `disableDelegation` UserOp | session disable |
| Gas / payment | _TBD from run_ | _see baseline_ |

## What the rail deletes

The delegation rail removes, for new accounts, entire classes of machinery the
session rail needed: coverage arithmetic, the approval queue, and the schedule
machinery for refills (#769/#770/#796) — the budget refills itself on-chain.
Retiring that code is [#834](https://github.com/d-hinders/Haven-AI/issues/834),
gated on this report.

## Post-script (epic #836)

After this closeout, the rail gained passkey-owned treasuries: delegation-rail.ts
accepts a WebAuthn signer set (`TreasuryPasskey`), and the #884 spike proved
passkey-signed grants redeem through the same DelegationManager path measured
here. Nothing in this report's measurements or conclusions changes.

## Post-script 2 — what the rail gained after this closeout

This report is the #835 record as it stood; every row still reproduces and
nothing below retracts one. But three later changes matter if you read it as a
description of the rail *today*:

- **x402 settles two ways now (#946).** Row 8's ERC-7710 direct settlement
  remains the default and the destination, but a delegation-metered **EIP-3009
  fallback** exists for facilitators that cannot redeem a delegation chain: the
  budget delegation is redeemed to the agent's own delegate EOA, which then
  signs a standard 3009 header. For those payments only, the transient hot
  balance this rail deleted comes back — so merchant-pinned budgets are
  erc7710-only. Terms and compensating controls:
  [security model §8](../security/delegation-rail-security-model.md).
- **The authorize path is hardened (#961).** Idempotent replays resume with a
  reconstructed signing payload instead of dead-ending, one-shot
  authorize+execute is refused, and the per-agent hourly x402 cap now covers
  the delegation branch as sponsorship-cost protection.
- **Mainnet has a signer floor (#947, gate #908).** On value-bearing chains no
  account may be provisioned, and no grant activated, below two enrolled
  signers without a recorded single-signer waiver (migration 046). The matrix
  above is unaffected — the gate exempts known testnets, including Base
  Sepolia.

The gas/latency table's `_TBD from run_` cells were never backfilled; the
measured figures live in
[the vendor-ops runbook §1](../operations/delegation-rail-vendor-ops.md).

## Running it

```
set -a; . ~/.haven/pilot.env; set +a
# Operator: fund the fresh Hybrid from a faucet, then:
npm run pilot:dod -w @haven/backend
# or self-fund from the owner key (testnet only):
DOD_FUND_FROM_OWNER=1 DOD_PERIOD_SECONDS=90 DOD_BUDGET_USDC=0.03 npm run pilot:dod -w @haven/backend
```

The runner is funding-aware (stops with the exact address + amount if the
account is short) and uses a short configurable period so the zero-signature
refill boundary (row 5) is observable in a single run.
