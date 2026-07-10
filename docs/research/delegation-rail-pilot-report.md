---
owner: "@d-hinders"
status: research
covers:
  - packages/backend/scripts/delegation-dod-matrix.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/lib/delegation-rail.ts
  - packages/backend/src/lib/delegation-authorization.ts
last-verified: "2026-07-10"
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

- The rail's **on-chain mechanics are proven live** (grant, redemption,
  native period refill, revoke, ERC-7710 x402) — the per-slice smokes landed
  real Base-Sepolia txs.
- Driving the **production HTTP route** end to end (which #835 requires, and no
  prior slice did) surfaced a real money-path defect: `POST /payments` ran the
  session-rail token-config guard *before* branching to the delegation rail, so
  a fully-configured delegation agent got a spurious `403`. **Fixed in this PR**
  (guard scoped to non-delegation rails) with regression tests.
- Rows 1–2 are **live-proven through production today**; rows 3–8 run to
  completion the moment the §3 route fix ships to the dev deploy (the test
  account is already funded).

## The proof matrix

| # | Proof | Status | Evidence |
|---|---|---|---|
| 1 | Fresh account provisioned | ✅ live (prod) | `POST /accounts/hybrid` → `0x8B9bfeC4B58ffF2c830c49F1F0b57daa8a4BCac1` (counterfactual; deploys on first op) |
| 2 | One-signature budget grant | ✅ live (prod) | `build`→owner signs the account's exact EIP-712 typed data→`activate`; 1 signature, 0 tx |
| 3 | Within-budget payment | ⏸️ blocked on §3 deploy | on-chain redemption proven by #829 smoke (live tx); production route blocked until fix ships |
| 4 | Overspend reverts | ⏸️ blocked on §3 deploy | caveat enforcement proven by #829; funds never move |
| 5 | **Zero-signature refill** | ⏸️ blocked on §3 deploy | native period refill is the headline — spend to cap, cross the boundary, spend again with NO signature and NO Haven cron |
| 6 | N-recipient matrix | ⏸️ blocked on §3 deploy | distinct delegations per recipient; per-recipient revoke |
| 7 | Revoke kill-switch | ⏸️ blocked on §3 deploy | `disableDelegation` (owner-signed account UserOp) → further redemption reverts (#832 exit proof) |
| 8 | x402 direct settlement | ✅ live (smoke) | ERC-7710 treasury→merchant, single leg (#830); production `/x402/:id/settle` re-run pending §3 |

*Fill the tx links for rows 3–7 from the `pilot:dod` output after the fix
deploys — the runner prints a Basescan link per row.*

## §3 — the defect the DoD surfaced (fixed here)

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
