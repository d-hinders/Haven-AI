---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/components/AccountSignersCard.tsx
  - packages/frontend/src/hooks/useAccountSigners.ts
  - packages/frontend/src/components/onboarding/RecoveryNudge.tsx
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/hybrid-accounts.ts
  - packages/backend/src/rails/hybrid-signer-actions.ts
  - packages/frontend/src/app/(authenticated)/accounts/[safeId]/AccountDetailClient.tsx
last-verified: "2026-08-07"
---

# Account recovery (delegation-rail accounts)

How a delegation-rail account is protected against a lost device — and the
honest limits of that protection. This is the product-facing companion to the
[delegation-rail security model](../security/delegation-rail-security-model.md)
and stays inside the [copy guidelines](copy-guidelines.md) and
[CASP guardrails](../regulatory/casp-risk-guardrails.md): **Haven can never
recover an account for you.** Recovery is something the account's own signers
do; Haven only prepares the on-chain operations.

## The model in one line

An account has one or more **ways to approve** it — a passkey (Face ID / Touch
ID) and/or a connected wallet. Any enrolled signer can add or remove other
signers. So a **backup** signer is the whole recovery story: if you lose the
device holding your primary passkey, the backup can remove the lost one and
enroll a replacement.

## The one thing you must do: keep at least two

- **Two or more ways to approve → you can recover.** Lose one, use the other to
  add a replacement.
- **Exactly one way → there is no recovery.** Lose it and the account, and any
  funds in it, are unreachable — by you *and* by Haven. This is not a policy we
  can override; it is how self-custody works.

Removing a **backup passkey** still requires keeping two ways to approve ("add
a backup first" — a clear message rather than a failed transaction). Removing a
**wallet** down to a single passkey is allowed, after Haven shows you what it
costs. And the account itself refuses on-chain to remove its *last* signer, so
that floor holds even outside Haven.

Because a fresh single-passkey account starts with exactly one way to approve,
**A backup is strongly recommended — and it is your choice.** Haven used to
require two ways to approve before a real-money account could be created or
give an agent a budget. It no longer does: you can create an account, fund it,
and run it with a single device. Nothing about the risk changed — with one
device there is **no recovery**, and losing it loses the account and everything
in it. What changed is that Haven tells you rather than stopping you.

**You'll be asked to add a backup once the account holds funds — not during
signup.** Signup is one screen and one Face ID prompt (#1162). The prompt to add
a backup appears on the dashboard after money arrives, because before that
there is nothing to protect and no reason for the question. It is dismissible,
it stops appearing once you add a backup, and you can add one at any time from
**Backup & recovery** on your account page.

## Add a backup (do this early)

On your account page, open **Backup & recovery** and choose one:

- **Add a backup with Face ID / Touch ID** — creates a second passkey. On the
  same device it's a second credential; on a *different* device (your phone as
  well as your laptop) it's true device redundancy. One prompt, no transaction
  you pay for.
- **Add a wallet** — enrols a browser wallet address as an owner. Useful if you
  already keep a hardware or browser wallet. Adding a wallet is reversible:
  **Remove** next to it takes the account back to passkey-only. You can't
  remove it while it's your *only* way to approve — that would leave nothing
  able to approve anything, and the account refuses it on-chain. Removing it
  when it's your *last backup* is allowed: Haven first shows you what you are
  giving up, and you decide.

Each takes one approval from a signer you already have.

## Recover after a lost device

1. Open Haven on a device that still has a working signer (your backup passkey,
   or the wallet you enrolled).
2. Go to **Backup & recovery** on your account page.
3. **Add a replacement** for the device you lost (a new passkey on the device
   you're on now), so you're back to two ways to approve.
4. **Remove** the lost signer from the list.

That's the whole flow — no support ticket, no seed phrase, no waiting period.
The account never trusts Haven to do any of it: each step is signed by a signer
you hold.

## What Haven cannot do (by design)

- **Recover a single-signer account.** If the only signer is gone, so is the
  account. Add a backup before that can happen.
- **Add, remove, or use a signer on your behalf.** Every signer change is signed
  by an existing signer of yours. Haven prepares the operation and relays gas;
  it holds no key that can approve anything.
- **Freeze, seize, or move your funds.** The delegation rail's whole point is
  that authority lives in your signers, not our servers.

If Haven disappeared entirely, an account with an enrolled signer stays fully
recoverable through the public contracts — see the
[independent exit path](../exit/README.md).
