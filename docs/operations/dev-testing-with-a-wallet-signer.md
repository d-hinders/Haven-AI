---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/lib/signer.ts
  - packages/frontend/src/lib/passkey.ts
  - packages/frontend/src/hooks/useDelegationBudget.ts
  - packages/frontend/src/hooks/useAccountSigners.ts
  - packages/frontend/src/components/AccountSignersCard.tsx
  - packages/backend/src/lib/hybrid-signer-actions.ts
last-verified: "2026-08-06"
---

# Dev testing with a wallet signer

**The problem this solves.** A passkey is bound to the exact domain it was
created on. Every PR gets its own Vercel preview URL, so a passkey created on
one preview is unreachable on the next — the browser only offers the "use
another device" QR. Testing a handful of PRs a week that way means creating a
handful of throwaway accounts a week.

**The fix.** A delegation-rail account accepts **any** of its enrolled signers.
Enrol a wallet (EOA) as a second signer once, on the stable dev URL, and from
then on that one account works on *every* preview link — you connect the wallet
and sign with it instead of the passkey. Nothing about the product changes; this
is a supported account shape, used the way it was designed.

Set this up once (~5 minutes) and you should not need a new dev account again,
except when you are specifically testing passkey behaviour.

---

## Before you start

You need:

- **A wallet you are happy to use for testing** — MetaMask (or any injected
  wallet) on Base Sepolia. It never holds real value; it only signs.
- **The stable dev URL**, not a PR preview:
  `https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app`
  (the branch-tracking preview of `dev`, per
  [`dev-environment.md`](dev-environment.md)).

⚠️ Do **not** do this on `haven-ai-frontend.vercel.app`. That is the Vercel
production alias pointing at the **production** backend.

Dev serves **Base Sepolia (84532) only**, which is also the only chain where
delegation onboarding is switched on.

---

## One-time setup

**1. Create the account on the stable dev URL.**
Sign up with email + password, then create your account with Face ID / Touch ID.
This is the one passkey you will make, and it lives on a domain that does not
change. The account is counterfactual at this point — no transaction, no gas.

**2. Enrol your wallet as a second signer.**
Go to your account page → **Backup & recovery** → add a wallet, and paste your
wallet's address. Approve with Face ID once.

Behind the scenes this is `transferOwnership(yourWallet)` submitted as a
sponsored UserOperation, which also deploys the account. You pay nothing and
sign nothing with the wallet itself — you only supply its address.

**3. Confirm it worked.**
The Backup & recovery card should now list **two** ways to approve: "A connected
wallet" (your address) and "Face ID / Touch ID". The one-way warning banner
should be gone.

That's it. The passkey stays enrolled as your backup; you just stop needing it.

---

## Everyday testing on a PR preview

On any preview link:

1. **Log in** with email + password. Sessions are not domain-bound, so the same
   login works everywhere, and every preview points at the same dev backend and
   database — it's the same account and the same data you left behind.
2. **Connect your wallet first** — before you touch anything that signs.
3. Set budgets, revoke them, manage signers, run agents. Each action pops a
   MetaMask signature request instead of a passkey prompt.

### Why "connect first" matters

The app picks a signer per **device**, not per account: a passkey enrolled on
*this* browser wins, then a connected owner wallet, then any passkey
(`pickSigningPath` in
[`useDelegationBudget.ts`](../../packages/frontend/src/hooks/useDelegationBudget.ts)).

On a fresh preview domain there is no local passkey, so:

- **Wallet connected** → it signs with the wallet. What you want.
- **Wallet not connected** → it falls back to the passkey, and because the
  passkey belongs to a different domain you get the cross-device QR dead end.

Connecting the wallet is the whole trick. If you ever see the QR screen, that is
what it's telling you.

### Connect the *enrolled* wallet

The app will happily use whatever wallet is currently connected — the check that
it is actually your account's owner happens on-chain, at signing time. Connect
the wrong account and the action fails with a generic error rather than a
helpful one. If a signature fails for no obvious reason, check which account
MetaMask has selected.

---

## What still needs a fresh passkey

Testing passkey behaviour itself — onboarding, WebAuthn signing, backup and
recovery flows. That still needs an account created on the preview domain you're
testing, and there is no way around it: WebAuthn derives its relying-party ID
from `window.location.hostname`
([`passkey.ts`](../../packages/frontend/src/lib/passkey.ts)). Make a throwaway
account for those PRs and keep your wallet account for everything else.

Agent-side testing (API keys, MCP, x402) is unaffected either way — agent
credentials are portable and the backend executes.

---

## Notes worth knowing

**One owner per account.** Enrolling a wallet is `transferOwnership` — a single
slot, not a list. You cannot add a second person's wallet to the same account,
and the UI will tell you the account already has a wallet owner. So each person
gets their own dev login and their own wallet. If you genuinely need two people
driving identical state, share one throwaway Base Sepolia key in a dedicated
browser profile — but per-person accounts are cheaper and less confusing.

**It is not a one-way door.** You can remove the wallet again (Backup &
recovery → Remove) as long as a passkey remains, so an account can go back to
passkey-only.

**This pattern generalises to mainnet, deliberately.** On Base mainnet a
delegation-rail account must have **at least two signers** — which is exactly
what passkey + wallet gives you. The rule does not apply on Base Sepolia
(testnets are exempt from the floor in
[`mainnet-gate.ts`](../../packages/backend/src/lib/mainnet-gate.ts)), so nothing
here is a dev-only hack that breaks later.

**Don't domain-hop mid-session.** Passkeys aside, switching between preview URLs
during a flow has burned real sessions before. Pick a URL for the thing you're
testing and stay on it.
