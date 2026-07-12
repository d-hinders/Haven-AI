---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/lib/delegation-rail.ts
  - packages/backend/src/lib/delegation-contracts.ts
  - packages/backend/scripts/check-delegation-contracts.ts
  - packages/backend/scripts/check-bundler.ts
last-verified: "2026-07-12"
---

# Delegation rail — vendor & gas operations (#826, epic #821)

Operational contract for the delegation rail's external dependencies: the
bundler/paymaster (Pimlico) and MetaMask's deployed Delegation Framework
contracts + SDK. Since the session rail's retirement (#834) this is the
**only sponsored rail** and the only live bundler/paymaster runbook (the
[session-rail runbook](session-rail-vendor-ops.md) is archived); the security
model lives in
[`delegation-rail-security-model.md`](../security/delegation-rail-security-model.md).

## 1. Who pays gas, and what that buys

A redemption is a sponsored ERC-4337 UserOp from the **delegate Hybrid
account** (owned by the agent key) calling `redeemDelegations`. The paymaster
pays gas; the agent key holds **no ETH and no tokens**; Haven holds **no key**
(watch-only construction, CI-enforced). Sponsorship can only ever pay gas —
it has no value-transfer surface.

**Measured cost** (Base Sepolia, #820 + the production-lib smoke 2026-07-10):
direct-EOA redemption 209–307k gas; sponsored delegate-account path
**584k cold** (includes the delegate account's one-time deployment) and
**303k warm** (steady state) at 5–8 s bundler latency. The premium over a UserOp
on the retired session rail was the redemption
indirection; the offset is that budgets refill natively (no schedule
machinery to execute).

## 2. Credentials & policies

- `DELEGATION_RAIL_BUNDLER_URL` — SECRET (embeds the API key). Falls back to
  `SESSION_RAIL_BUNDLER_URL`, which survives the session rail's retirement
  (#834) ONLY as this fallback. **Operator step:** set
  `DELEGATION_RAIL_BUNDLER_URL` in every deployed env, then drop the
  `SESSION_RAIL_*` variables (`SESSION_RAIL_SPONSORSHIP_POLICY_ID` and
  `SCHEDULE_RENEWAL_WEBHOOK_URL` are already dead). Read in exactly ONE place
  (`delegationRailBundlerUrl`); every error surface passes
  `redactVendorSecrets` (bundler errors echo the URL — the #764 incident).
- `DELEGATION_RAIL_SPONSORSHIP_POLICY_ID` — Pimlico policies bind **per
  request**, not per API key (#738): an unset id means unrestricted
  sponsorship against the key's account. Set it in every deployed env.
- Key rotation: new key in the vendor dashboard → update env → redeploy →
  delete old key (the #738 procedure). One credential, two
  env names — rotate BOTH vars if the fallback is still set.

## 3. Failure modes & the degradation contract

**Sponsorship exhaustion / bundler outage degrades to "payments pause" —
never to "policy weakens".** The caveat stack is enforced on-chain at
redemption regardless of who pays gas; when sponsorship declines,
prepare/submit throw and the payment route 502s cleanly with a redacted
error. There is no fallback signer, no retry-with-Haven-funds path, and none
may be added (red line — see the security model).

Probes:
- `ops:check-bundler` — bundler up + EntryPoint v0.7 + gas oracle (inherited
  from the retired session rail's runbook; same vendor account).
- `ops:check-delegation` — every PINNED contract (manager, entry point,
  factory, Hybrid impl, 8 enforcers) is live bytecode on every enabled
  chain. Run on deploy and daily; exit 1 = stop before any rail use.

## 4. Anti-lock-in: fork-and-pin policy + re-evaluation tripwires

**Contracts:** pinned by address in `lib/delegation-contracts.ts` with audit
provenance. Pins NEVER move on a package upgrade — adding a chain or a new
manager version is a reviewed change with its own verification run.

**SDK (`@metamask/smart-accounts-kit`):** pinned to a known version in
`package.json`. If the package is deprecated, breaks compatibility, or its
license changes: fork the repo at the pinned tag into the org and point the
dependency at the fork — the deployed contracts don't care what SDK built
the calldata. Budget for this is small by design: Haven touches only
delegation building, signing typed-data, and `redeemDelegations` encoding.

**Tripwires — reconsider the vendor posture if any fires:**
1. delegation-framework repo goes quiet (no releases/audits for ~12 months)
   or a critical advisory lands without a fix.
2. An alternative ERC-7710 manager implementation reaches production with
   independent audits (portability option appears).
3. Facilitator adoption signal (CDP `erc7710` support) — tracked in #830;
   raises the value of the whole posture rather than threatening it.
4. MetaMask Agent Wallet's consumer product begins to overlap Haven's B2B
   control-plane lane (positioning, not technical, review).

## 5. Deploy parity (the PR #840 incident)

A backend import satisfied only by workspace hoisting passes every local
gate but crashes the pruned production build at boot — and the platform then
silently serves the LAST healthy build (symptom: new routes 404 while
`/health` shows newer features). Now enforced by
`src/lib/__tests__/dependency-parity.test.ts`: every bare import in backend
`src/**` must be declared in the backend's own `package.json`. When
debugging "route missing on dev", check WHICH build generation is live by
probing a route from each recent merge before suspecting the code.
