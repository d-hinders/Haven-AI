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

**The problem this solves.** We test on **Vercel preview links**, and every PR
gets its own. A passkey is bound to the exact domain it was created on, so a
passkey made on one PR's preview is unreachable on the next — the browser only
offers the "use another device" QR. Testing a handful of PRs a week that way
means creating a handful of throwaway accounts a week.

**The fix.** A delegation-rail account accepts **any** of its enrolled signers.
Enrol a wallet (EOA) as a signer once, and from then on that same account works
on *every* preview link — you connect the wallet and sign with it instead of the
passkey. A wallet is not domain-bound, so changing preview URLs stops mattering.

Nothing about the product changes: passkey + wallet is a supported account
shape, and the one Base mainnet requires anyway.

Set this up once (~5 minutes) and you should not need a new dev account again.

---

## Before you start

You need a **wallet you are happy to use for testing** — MetaMask (or any
injected wallet), on Base Sepolia. It never holds real value; it only signs.

**Which URL do I do this on?** Whichever preview link you have open. There is no
stable dev frontend URL — every preview link is a different domain, and they all
point at the **same** dev backend and database, so they are all the same account
and the same data. The setup below is the one and only step that needs a
passkey, and it needs it for about two minutes. After that you never return to
that domain.

⚠️ **Not** on `haven-ai-frontend.vercel.app` — that is the Vercel production
alias pointing at the **production** backend. Check for the `DEV` badge in the
top bar before you start; if it isn't there, you're on prod.

Dev serves **Base Sepolia (84532) only**, which is also the only chain where
delegation onboarding is switched on.

---

## One-time setup

Pick any current preview link and stay on it until step 3 is done.

**1. Create the account.**
Sign up with email + password, then create your account with Face ID / Touch ID.
The account is counterfactual at this point — no transaction, no gas.

**2. Enrol your wallet.**
Account page → **Backup & recovery** → add a wallet, and paste your wallet's
address. Approve with Face ID once.

Behind the scenes this is `transferOwnership(yourWallet)` submitted as a
sponsored UserOperation, which also deploys the account. You pay nothing, and
you sign nothing with the wallet itself — you only supply its address, so the
wallet doesn't even need to be connected yet.

**3. Check it took effect.**
Backup & recovery should now list **two** ways to approve: "A connected wallet"
(your address) and "Face ID / Touch ID". The one-way warning banner should be
gone.

Done. From here on the wallet is your signer and the preview domain is
disposable.

> **What happens to that first passkey?** It stays enrolled on-chain, but once
> that preview link is gone it can no longer be used — it belongs to a domain
> that no longer exists. In practice your wallet becomes the account's only
> *usable* signer. That is fine on a testnet dev account, and it is the reason
> this shortcut stays on dev: on mainnet the second signer has to be one you can
> actually reach. Haven will also refuse to let you remove the dead passkey (it
> won't drop an account below two signers), so just leave it there.

---

## Everyday testing on a preview link

On any PR's preview:

1. **Log in** with email + password. Sessions are not domain-bound, so the same
   login works on every preview, and you land on the same account with the same
   agents, budgets and history.
2. **Connect your wallet first** — before you touch anything that signs.
3. Set budgets, revoke them, manage signers, run agents. Each action pops a
   MetaMask signature request instead of a passkey prompt.

### Why "connect first" matters

The app picks a signer per **device**, not per account: a passkey enrolled in
*this* browser wins, then a connected owner wallet, then any passkey
(`pickSigningPath` in
[`useDelegationBudget.ts`](../../packages/frontend/src/hooks/useDelegationBudget.ts)).

On a preview domain you've never used before there is no local passkey, so:

- **Wallet connected** → it signs with the wallet. What you want.
- **Wallet not connected** → it falls back to the passkey, and because that
  passkey belongs to a different domain you get the cross-device QR dead end.

Connecting the wallet is the whole trick. If you ever land on that QR screen,
that is what it's telling you — close it, connect, try again.

### Connect the *enrolled* wallet

The app will use whatever wallet is currently connected; the check that it is
actually your account's owner happens on-chain, at signing time. Connect the
wrong account and the action fails with a generic error rather than a helpful
one. If a signature fails for no obvious reason, check which account MetaMask
has selected.

---

## When you *do* need a working passkey

To test passkey behaviour itself — WebAuthn signing, backup and recovery flows —
you need a passkey that lives on the preview domain you're testing. You do
**not** need a new account for that:

1. Open the preview link, log in, connect your wallet.
2. Backup & recovery → **add a backup passkey**. Your wallet signs the change,
   and the new passkey is created on *this* domain.
3. That passkey now works here, for as long as this preview link does.

Which means you keep your account, your agents and your history, and still get a
live passkey to test with. Note that these accumulate — one per preview domain
you do this on. You can remove old ones from the same card, as long as two
signers remain.

The exception is **onboarding** itself: signing up and creating the first
passkey is by definition a new account, so those PRs still need a throwaway.

Agent-side testing (API keys, MCP, x402) is unaffected by any of this — agent
credentials are portable and the backend executes.

---

## Notes worth knowing

**One wallet owner per account.** Enrolling a wallet is `transferOwnership` — a
single slot, not a list. You cannot add a second person's wallet to the same
account; the UI will tell you the account already has a wallet owner. So each
person gets their own dev login and their own wallet. If you genuinely need two
people driving identical state, share one throwaway Base Sepolia key in a
dedicated browser profile — but per-person accounts are cheaper and less
confusing.

**It is not a one-way door.** You can remove the wallet again (Backup & recovery
→ Remove) as long as a usable passkey remains, so an account can go back to
passkey-only.

**This pattern generalises to mainnet, deliberately.** On Base mainnet a
delegation-rail account must have **at least two signers** — which is exactly
what passkey + wallet is. The floor does not apply on Base Sepolia (testnets are
exempt in [`mainnet-gate.ts`](../../packages/backend/src/lib/mainnet-gate.ts)),
which is what makes the disposable-passkey shortcut above acceptable on dev and
not on mainnet.

**Don't domain-hop mid-flow.** Switching between preview links in the middle of
something has burned real sessions before. Finish what you're testing on one
link before moving to the next.

See [`dev-environment.md`](dev-environment.md) for the rest of the dev stack —
backend, database, chain and the `DEV` badge.
