---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/components/AccountSignersCard.tsx
  - packages/frontend/src/hooks/useAccountSigners.ts
  - packages/frontend/src/components/onboarding/RecoveryNudge.tsx
  - packages/backend/src/routes/agent-delegations.ts
last-verified: "2026-08-04"
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

The account enforces this itself: it **refuses to drop below two signers**
on-chain, so you can't accidentally remove your last one. Haven surfaces the
same rule as a clear message ("add a backup first") rather than a failed
transaction.

Because a fresh single-passkey account starts with exactly one way to approve,
**On mainnet, a backup is required — not just suggested.** Real-money accounts
must have at least two ways to approve before they can be created or grant an
agent a budget. If you truly want to run with a single device, you must
explicitly acknowledge that losing it loses the account — Haven records that
choice. (On testnets this rule does not apply.)

**Haven nudges you to add a backup right after signup.** It is dismissible, and
you can add one at any time from **Backup & recovery** on any agent that uses
the account.

## Add a backup (do this early)

On an agent's page, open **Backup & recovery** and choose one:

- **Add a backup with Face ID / Touch ID** — creates a second passkey. On the
  same device it's a second credential; on a *different* device (your phone as
  well as your laptop) it's true device redundancy. One prompt, no transaction
  you pay for.
- **Add a wallet** — enrols a browser wallet address as an owner. Useful if you
  already keep a hardware or browser wallet.

Each takes one approval from a signer you already have.

## Recover after a lost device

1. Open Haven on a device that still has a working signer (your backup passkey,
   or the wallet you enrolled).
2. Go to **Backup & recovery** on any agent.
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
