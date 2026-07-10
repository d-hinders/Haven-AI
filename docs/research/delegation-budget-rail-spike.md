---
owner: "@d-hinders"
status: research
covers:
  - packages/qa-agent/src/pilot/delegation-budget-spike.ts
last-verified: "2026-07-10"
---

# Delegation budget rail — spike #820 report (arm B, Hybrid DeleGator)

Gate G1 of [epic #821](https://github.com/d-hinders/Haven-AI/issues/821): can
the MetaMask Delegation Framework carry Haven's agent budgets on a **Hybrid
DeleGator** account — with native refill, recipient control, revocation, and a
sponsored gas path — with zero Haven-authored Solidity? Run live on Base
Sepolia via `pilot:delegation-spike`, off the #818 shared test matrix.

**Verdict: the matrix is green.** Every #818 case passed with on-chain
evidence, including the two claims the whole epic rests on: the **observed
zero-signature period rollover** (native refill) and a **sponsored redemption
where the agent key holds no ETH and Haven holds no key at all**.

## 1. The matrix (evidence per row)

Delegator (Hybrid): `0xE5dcD295FdC7bb21E075392F3A1d7229D7D023c3` ·
DelegationManager: `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` ·
budget 0.05 USDC / 240 s period. Cases 1–6 from run 4 (2026-07-10), case 8
from run 6 — each row's evidence is an independent transaction.

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | Grant — ONE offline signature | ✅ | No tx at grant time; restricted payload ≈1 196 bytes; caveats `[erc20PeriodTransfer, allowedCalldata(recipient), timestamp]` |
| 2 | Spend within budget — direct, no funding leg | ✅ | [0x9053fd…](https://sepolia.basescan.org/tx/0x9053fd05aa9a5f989530ffd07f9d3572212511421fe1d1d803571d375fac1c6c) — delegator→recipient, delegate never holds USDC |
| 3 | Overspend within the period | ✅ reverts | Second 0.03 against a 0.05 budget reverted on-chain |
| 4 | **Period rollover — ZERO signatures** | ✅ | [0xc9bc7e…](https://sepolia.basescan.org/tx/0xc9bc7e82a7267508cfcbc61633cc3922aef69bb6cf05ce5412d1dafa4abf09d5) — fresh budget after the boundary, no human, no cron, no Haven machinery |
| 5 | Recipient modes (both, per #810) | ✅ | Pinned delegation blocked a stranger; open variant paid one: [0x4267e0…](https://sepolia.basescan.org/tx/0x4267e0fa57394bdb9f0fcd9be1ac1b8d9386f88f1b7226e97625c6acc9f096f1) |
| 6 | Revoke — `disableDelegation` | ✅ | [0xe94d46…](https://sepolia.basescan.org/tx/0xe94d466f4c4c043066c42b90760e8da431e4247350eaf620ccebca144871c111) — further redemption fails |
| 7 | Metrics | ✅ | Direct-EOA redemption **209–307k gas**, 0.6–1.1 s latency |
| 8 | **Sponsored redemption — agent holds ZERO ETH** | ✅ | [0x1156bc…](https://sepolia.basescan.org/tx/0x1156bcbe609f37f4b4907a250b588a4f2b4f42e9a11ff7f2e66b5da61d93a224) — delegate-as-Hybrid, Pimlico-sponsored UserOp, 581k gas |

## 2. The two findings that matter beyond pass/fail

**Native refill is real and it deletes a subsystem.** Case 4 is the exact
property the session rail cannot have (ERC-7562 forbids clock reads at
validation) and that Haven synthesized with the pre-signed schedule machinery
(#769/#770/#796: ~2 500 lines plus the #813 salt-collision bug class). Here it
is one caveat config — `periodAmount`, `periodDuration`, `startDate` — enforced
by an audited contract.

**The gas-routing shape for #826 is proven, with a measured price.** The
delegate is itself a counterfactual Hybrid owned by the agent key; redemption
rides a sponsored UserOp. Overhead vs a direct-EOA redemption: **581k vs
~210–307k gas** (the premium includes the delegate account's first-op
deployment — steady-state will sit lower; #826 should measure the warm path).
Non-custody holds throughout: Haven signs nothing, the agent key holds no
funds and no gas.

## 3. Operational gotchas (paid for live, encoded in the script)

- **Clock skew kills `startDate = now`**: local time ran ahead of chain time →
  `ERC20PeriodTransferEnforcer:transfer-not-started`. Anchor `startDate` ~60 s
  in the past.
- **Public-RPC read-after-write lag** (known pilot gotcha) false-fails gas
  estimation right after funding — poll the balance before the first
  redemption, and classify infra errors separately so a negative case never
  passes on the wrong revert (the run-2 lesson: "revert" evidence must name the
  enforcer, not a gas error).
- The `smart-accounts-kit` ↔ repo **viem type-graph split** needs one seam cast
  (`client as never`) — runtime-identical, same pattern as the module-sdk
  calls.

## 4. Comparison to the session rail (RFC #791 §10 inputs)

| Dimension | Delegation rail (measured) | Session rail (today) |
|---|---|---|
| Refill | Native, on-chain, zero signatures | Pre-signed schedule machinery (#769) |
| Grant | 1 offline signature, no tx, ~1.2 kB | 1 owner **tx** per schedule window (~4.1 kB payload ceiling, #810) |
| Redemption gas | 209–307k (direct) / 581k (sponsored, cold) | 4337 UserOp, same order (see #723/#724 report) |
| Recipient modes | Pinned + open, both proven | Pinned per session; open added by #810 |
| Revoke | One `disableDelegation` | One `removeSession` (equivalent) |
| Third-party verifiable | Yes (anyone simulates redemption) | No (session invisible outside the account) |

## 5. Recommendation

Arm B passes its half of the #818 decision rule with no framework forks and
acceptable gas. Proceed per epic #821: gates G2–G4, then Phase 1. The #826
gas-routing issue inherits the proven delegate-as-Hybrid shape and should
quantify the warm-path premium. Arm A (#819) remains an optional 1-day hedge
for pricing Safe-optics — nothing in these results requires it.
