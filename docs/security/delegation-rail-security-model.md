---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/lib/hybrid-account-config.ts
  - packages/frontend/src/components/AccountSignersCard.tsx
  - packages/qa-agent/src/pilot/delegation-budget-spike.ts
last-verified: "2026-07-12"
---

# Delegation rail — security model & exit story (epic #821, gate G4)

Design doc for issue #824. The delegation stack (Hybrid DeleGator accounts +
MetaMask Delegation Framework) changes Haven's security model in three ways
the Safe/session stack did not have; this doc names them, maps every existing
non-custody invariant to its delegation-rail equivalent, fixes the custody
semantics of the delegation object itself, and specifies the independent exit
story with an acceptance test. (Since #834 the Smart Sessions **session rail
is retired** — `session_key` accounts get HTTP 410 from the payment paths —
so the "Safe/session stack" comparisons below are the mapping's historical
baseline; the only other live rail is the legacy AllowanceModule path,
import-only for existing Safes.) The implementation issues are #831 (CI
invariants) and #832 (exit tool); this doc is their contract.

Contracts in scope (Base Sepolia; mainnet addresses pinned at #825): 
DelegationManager `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`, the Hybrid
DeleGator implementation behind `toMetaMaskSmartAccount`, and the caveat
enforcers referenced below — all Consensys Diligence-audited (Aug 2024 / Apr
2025), deployed immutable, and forkable. Spike evidence:
[`delegation-budget-rail-spike.md`](../research/delegation-budget-rail-spike.md).

## 1. What changes vs the Safe/session stack

1. **UUPS upgradeability.** A Hybrid DeleGator is a UUPS proxy whose upgrade
   authority is the account's **own signers** — not Haven, not MetaMask. This
   is a new surface (the Safe proxy pattern had owner-controlled masterCopy
   semantics, but our stack never exercised it). Consequence: "who can
   upgrade" becomes part of the custody perimeter and must be provable.
2. **Authority is a held object, not account state.** A Smart Sessions grant
   lives in account storage; a delegation is a **signed message the agent
   holds**. Different theft model: exfiltrating a delegation (plus the
   delegate key) is sufficient to spend — but only within the caveat stack.
3. **The exit story loses Safe{Wallet}.** Haven's CASP/GTM line — "inspect
   and revoke everything without us" — was demonstrable via a mature
   third-party UI. On this stack it must be **rebuilt and demonstrated**
   (§4) before any external user touches the rail.

## 2. Invariant mapping (implemented — `non-custody.invariants.test.ts`, #831)

Every invariant in `non-custody.invariants.test.ts` maps as follows. "CI"
means a named check in the delegation-rail invariant suite; nothing is
dropped.

| # | Session/legacy invariant (baseline; session rail retired, #834) | Delegation-rail equivalent | Enforcement |
|---|---|---|---|
| 1 | No private-key/seed columns in the schema | Unchanged, plus: **no delegation-signing key columns** | CI (schema scan) |
| 2 | Agent secrets stored hashed | Unchanged | CI (existing) |
| 3 | Exactly one server-side signer: the gas-only relayer | **Zero** value-bearing server signers on this rail (no relayer leg exists); the sponsorship credential is the only vendor secret | CI (signer-construction scan scoped to the delegation rail) |
| 4 | No server-side key generation | Unchanged — delegate keys and account owners are client-generated | CI (existing, extended to delegation modules) |
| 5 | Session-rail owner is watch-only (refuses to sign) | Account interactions use a **watch-only owner**; Haven never holds a DeleGator signer | CI (watch-only pattern scan) |
| 6 | No viem key-based signers server-side | Unchanged, extended to `smart-accounts-kit` call sites | CI |
| 7 | UserOps submitted with caller-provided signature only | Redemptions submitted with **client-signed** UserOp/tx only; the backend constructs and relays, never signs | CI (the #737 pattern, delegation flavor) |
| 8 | Session-config modules signer-free | Delegation lifecycle modules (grant/replace/revoke construction, #827/#828) are **signer-free and relayer-free**: they build payloads and typed data, never sign | CI (module import/AST scan) |
| 9 | Bundler credential read in exactly one place | Unchanged (one choke point; `redactVendorSecrets` on every error surface) | CI (existing) |
| 10 | Paymaster has no value-transfer surface | Unchanged — sponsorship pays gas only; proven in the spike (agent key held zero ETH and zero USDC) | CI + spike evidence |
| 11 | *(new)* **No upgrade path from Haven code** | Haven's codebase contains no call site that can reach the account's UUPS upgrade function; upgrade authority = account signers only | CI (ABI/selector scan for `upgradeToAndCall` against DeleGator targets) |
| 12 | *(new)* **Delegations are client-signed only** | No Haven code path calls `signDelegation`/EIP-712 delegation signing with a server-held key (pilot scripts with throwaway testnet keys excepted, path-scoped) | CI (import + call-site scan) |
| 13 | *(new, #888)* **Signer changes are client-signed only** | Enrolling/removing a backup signer (`addKey`/`removeKey`/`transferOwnership`) is PREPARED by Haven and signed by an EXISTING account signer; the submit step pins the DB sync to the signed calldata. Haven holds no key that can change an account's signer set | CI (route + config-loader scan) |

**Monitored-not-enforced:** enforcer/manager *contract immutability* is a
property of the deployed bytecode, not our code — covered by pinning exact
addresses with audit provenance (#825) and the #826 tripwires (framework repo
activity, alternative 7710 implementations), not by CI.

## 3. Delegation custody semantics (#828's contract)

**Where the signed delegation lives:** the agent receives it through the
existing credential channel (same trust envelope as the agent API key).
Haven stores a copy server-side for reconstruction, revocation targeting and
observability. It is **not** key material — but it is spend-enabling in
combination with the delegate key, so it is stored with the same care as
`api_key_hash`-class data: encrypted at rest, never logged, never in error
surfaces.

**Leak analysis:**

| Compromised | Attacker gets | Bounded by |
|---|---|---|
| Delegation object alone | Nothing — redemption requires the delegate key's signature | — |
| Delegate key alone | Nothing beyond existing agent-credential risk — no delegation, no authority | — |
| Both (agent fully compromised) | Spend **within the caveat stack**: ≤ period budget per period, only to pinned recipients, until expiry or revocation | `MultiTokenPeriodEnforcer` + `allowedCalldata` + `Timestamp`; owner kill-switch `disableDelegation` |
| Haven fully compromised | Constructs malicious payloads but **cannot sign** grants, redemptions, or upgrades (invariants 3/5/7/11/12); worst case = denial of service | The perimeter this doc exists to prove |

Blast radius on full agent compromise is therefore **identical in kind** to
the retired session rail's (one period's budget per recipient) — with
revocation one `disableDelegation` away.

## 4. Exit story — design + acceptance test (#832's contract)

**Claim to keep true:** *a user can enumerate and revoke every authority on
their account, and recover control of the account itself, without Haven.*

Design (minimum viable, in order of preference):

1. **A statically hostable, open-source exit page** (no Haven backend): connect
   the account's owner (passkey or EOA) → enumerate delegations Haven has
   issued for the account (from public inputs: the account address + the
   published caveat/enforcer addresses; delegations are off-chain objects, so
   enumeration uses redemption events + `disabledDelegations` reads for state,
   and Haven's published delegation-format doc for decoding) → one-click
   `disableDelegation` per row → signer management (add/remove passkey/EOA).
2. **A documented manual path** (published in Haven's public docs): the same
   two operations via a block explorer with the DelegationManager ABI — exact
   contract addresses, function names, and argument construction, written for
   a technically competent user.

**Honest limitation to document:** off-chain delegations that Haven issued but
never surfaced cannot be *discovered* by a third party until first redemption
— the exit page therefore also renders Haven's attested list when available,
but the **revocation guarantee never depends on Haven**: `disableDelegation`
works on any delegation the user can reconstruct, and rotating/removing the
compromised delegate signer (or in the worst case moving funds out — the
account's signers always can) is the universal backstop.

**Acceptance test (verbatim from #824, verified in #832):** a person holding
only their account credentials (passkey/EOA) and Haven's *public* docs — no
Haven session, no Haven support — (a) enumerates the active authorities on a
Base Sepolia test account, and (b) executes `disableDelegation` and confirms
further redemption fails. Recorded as a walkthrough with tx links.

## 5. Copy rules (per `copy-guidelines.md` + the #736 formulation bank)

- MAY say: "your money stays in your own account", "budgets are enforced by
  public, audited contracts — we can't override them", "you can revoke your
  agent's budget yourself, even without Haven — here's how" (link §4).
- MUST NOT say: "audit-ready", "your keys never leave your device" (passkey
  platform semantics vary), anything implying Haven holds/controls funds, or
  "MetaMask wallet" (the account uses MetaMask's *contracts*, not the wallet
  product).
- The exit path is a **published feature**, referenced from the dashboard
  ("your exit path") — not fine print.

## 6. Recovery & the signer-set model (shipped, epic #836)

The interim single-passkey stance is retired — recovery shipped.

**The model.** An account's authority is its **signer set**: one or more passkeys
(P256) and/or one EOA owner. Any enrolled signer can add or remove others
(`addKey` / `removeKey` / `transferOwnership` on the Hybrid). A **backup signer
is the entire recovery story**: lose the device holding your primary passkey,
and the backup removes the lost one and enrols a replacement. The user-facing
walkthrough is [account-recovery.md](../product/account-recovery.md); the
independent-of-Haven path is [exit/README.md](../exit/README.md).

**Recovery invariants (non-custody preserved through recovery):**

- **Haven can never change an account's signer set.** Every `addKey`/`removeKey`/
  `transferOwnership` is prepared by Haven and **signed by an existing signer**
  (WebAuthn or EOA). Haven holds no key that can add, remove, or use a signer —
  invariant 13, CI-enforced.
- **The account enforces ≥1 signer on-chain** (`CannotRemoveLastSigner`, proven
  in the #884 spike). Haven mirrors a **≥2** floor in the API as a clean refusal
  so a user is nudged to add a backup before they can strip redundancy — the UI
  never lets you approach a no-recovery state silently.
- **Storage tracks the chain, not the reverse.** The stored signer set (which the
  deploy/sign paths rebuild the account config from) is synced only *after* the
  on-chain op confirms, and the submit step **pins the sync to the signed
  calldata** — the DB can never record a signer the owner didn't actually sign.
- **UUPS upgrade authority stays with the signers** (invariant 11); recovery
  changes signers, never the implementation.

**The honest limit, stated plainly:** a **single-signer account has no recovery**
— if its only signer is lost, the account is unreachable by the user *and* by
Haven. This is inherent to self-custody, not a Haven policy. Mitigation is
structural: onboarding nudges a backup, the account blocks dropping below the
safe floor, and copy never promises recovery Haven cannot deliver.

## 7. Mainnet-gate criterion (recorded)

Before any account holds **mainnet** funds:

> **No mainnet delegation-rail account may operate with fewer than two enrolled
> signers**, unless the owner has explicitly acknowledged the single-signer
> risk (a recorded, signed-off "I understand losing my only device loses this
> account"). The enrollment nudge is not sufficient on its own for mainnet —
> the ≥2 floor (or the explicit waiver) is a launch gate, tracked on the
> mainnet decision issue (#908).
