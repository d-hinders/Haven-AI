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
  - packages/frontend/src/components/settings/ManageApprovers.tsx
  - packages/frontend/src/lib/passkey-approver.ts
  - packages/backend/src/routes/passkeys.ts
  - packages/backend/src/routes/safe-exec.ts
last-verified: "2026-08-24" # #1988: the "Legacy passkey Safes" section told a user to add a backup owner through Settings → Approvers. That surface is deleted with the Safe rail, so the instruction was a dead end for exactly the population the section exists to help. Rewritten to say what an owner CAN still do — move funds out via the still-open owner-signed relay, manage owners themselves at Safe's own interfaces, and use a backup owner already on the list — and to say plainly that a sole-passkey Safe with no backup should be emptied and closed. The exposure paragraph is unchanged and was already correct. Scope: that section; the delegation-rail half of the doc was not re-verified. Prior: #1702: new section "Not the same thing: replacing an agent's key" — the account-signer / agent-delegate distinction stated from THIS side, paired with the same distinction stated from `agent-key-rotation.md` (the epic asked for both directions, because a reader arrives at whichever page their search terms hit and only one of them is right for a lost account signer). No existing claim changed: the two-signer rule, the single-signer limit, the removal floor and the legacy-Safe section were all re-read against `hybrid-signer-actions.ts` and `delegation-rail-security-model.md` §7 and stand. Scope: the new section only; no recovery flow was re-executed. Prior: #1199: both signer-removal paths permit an informed two-to-one transition
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

## Not the same thing: replacing an agent's key

This page is about the signers that control your **account**. It is routinely
confused with replacing an **agent's** signing key, and the two have opposite
answers, so it is worth thirty seconds:

|  | Account signer | Agent delegate key |
|---|---|---|
| What it can do | Approve anything the account can do | Only *request* payments, inside a budget you granted |
| Lost, with no backup | **Unrecoverable.** Nothing brings it back | **Recoverable.** You replace it |
| Who fixes it | Your other signer, if you have one | You, from the dashboard |

The asymmetry is not a policy choice, it is the structure. An agent's delegate
never held authority over the account, so you are still there to revoke it and
issue a new one — that is [replacing an agent's signing key](agent-key-rotation.md).
Your account's last signer *is* the authority, so there is nobody above it to
appeal to. **Replacing an agent's key does nothing for a lost account signer**,
and it is the wrong page to be reading if that is what happened.

## The one thing you must do: keep at least two

- **Two or more ways to approve → you can recover.** Lose one, use the other to
  add a replacement.
- **Exactly one way → there is no recovery.** Lose it and the account, and any
  funds in it, are unreachable — by you *and* by Haven. This is not a policy we
  can override; it is how self-custody works.

Removing either a **backup passkey** or a **wallet** down to one remaining way
to approve is allowed only after Haven clearly shows what it costs: the account
will have no recovery if that remaining device or wallet is lost. The account
itself still refuses on-chain to remove its *last* signer, so that floor holds
even outside Haven.

Because a fresh single-passkey account starts with exactly one way to approve,
**A backup is strongly recommended — and it is your choice.** Haven used to
require two ways to approve before a real-money account could be created or
give an agent a budget. It no longer does: you can create an account, fund it,
and run it with a single device. Nothing about the risk changed — with one
device there is **no recovery**, and losing it loses the account and everything
in it. What changed is that Haven tells you rather than stopping you.

**You'll be asked to add a backup once the account holds funds — not during
signup.** Signup is one screen and one passkey prompt (#1162). The prompt to add
a backup appears on the dashboard after money arrives, because before that
there is nothing to protect and no reason for the question. It is dismissible,
it stops appearing once you add a backup, and you can add one at any time from
**Backup & recovery** on your account page.

## Add a backup (do this early)

On your account page, open **Backup & recovery** and choose one:

- **Add a backup passkey** — creates a second passkey (approve with Face ID,
  Touch ID, Windows Hello, or your device PIN). On the
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

## Legacy passkey Safes

Accounts created through the Safe onboarding path — closed since
[#1984](https://github.com/d-hinders/Haven-AI/issues/1984); no new account can
be created on it — differ from the delegation rail in two ways worth stating
plainly.

**The exposure is identical, and the wording is not softer for being older.**
That Safe is deployed with your passkey signer as its **sole owner**, threshold
1. Lose that passkey with nothing else on the account and the Safe — and
anything in it — is unreachable, by you and by Haven. There is no server-side
reset that changes this: Haven can clear the database row so you can onboard a
*new* account, but the old Safe stays exactly where it is, owned by a key
nobody holds. Restoring access is not something a support ticket can do.

**Haven no longer offers a way to add a backup owner.** Settings → Approvers
built the owner-change transaction for you to sign; that surface is removed
with the rest of the Safe rail
([#1988](https://github.com/d-hinders/Haven-AI/issues/1988)). Haven never
signed an owner change and now does not construct one either.

What you can still do, and it is the whole of it:

- **Move the funds out.** Haven still relays any Safe transaction *you* sign as
  an owner, so sending the balance to an account you control — a Haven account
  on the delegation rail, or any wallet — works exactly as it did.
- **Manage owners yourself.** A Safe owned by a wallet address is managed at
  [app.safe.global](https://app.safe.global) with that wallet, independently of
  Haven. This was always true; it is the point of a non-custodial account, and
  it is why removing Haven's builder takes away a convenience rather than your
  control.
- **A backup owner you already added still works.** If a second passkey is
  already on the Safe's owner list, it still signs, and Haven still relays for
  it.

If your Safe's only owner is a passkey and you never added a backup, treat the
account as move-the-funds-out-and-close rather than as something to keep.

> Until [#1229](https://github.com/d-hinders/Haven-AI/issues/1229) the second
> passkey could not be added at all — enrolment refused a second credential on
> the same network, so the only backup available was a wallet. If you created
> your account before that fix and never added a wallet, adding a second
> passkey now is the single most useful thing you can do to it.
