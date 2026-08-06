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

**The problem this solves.** We test PRs on **Vercel preview links**, and every
PR gets its own domain. A passkey is bound to the exact domain it was created
on, so a passkey made on one PR's preview is unreachable on the next — the
browser only offers the "use another device" QR, which is domain-bound too and
won't save you. Testing a handful of PRs a week that way means creating a
handful of throwaway accounts a week.

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

**Which URL do I do this on?** Use the **stable dev URL** —
`https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app`, the
branch-tracking preview of `dev` (see [`dev-environment.md`](dev-environment.md)).
Vercel keeps that hostname pointed at the newest `dev` deployment, so it never
changes, which means the passkey you create there keeps working. That is the
only reason it matters here: it gives your account a real, reachable backup
signer, not just a wallet.

Any preview link would also work for the setup — this needs a passkey for about
two minutes and never again — but the passkey would die with that preview
domain, leaving your wallet as the account's only usable signer. Fine on a
testnet account, avoidable in one click, so use the stable URL.

All of these hosts — stable dev URL and every PR preview — point at the **same**
dev backend and database, so it is the same account and the same data
throughout. Only the domain differs, and only passkeys care about the domain.

⚠️ **Not** on `haven-ai-frontend.vercel.app` — that is the Vercel production
alias pointing at the **production** backend. Check for the `DEV` badge in the
top bar before you start; if it isn't there, you're on prod.

Dev serves **Base Sepolia (84532) only**, which is also the only chain where
delegation onboarding is switched on.

---

## One-time setup

Do all three steps on the stable dev URL, in one sitting.

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

Done. From here on the wallet is your signer on every PR preview, and the
passkey stays as a real backup on the stable dev URL.

> **If you did the setup on a PR preview instead**, that passkey stops working
> when the preview goes — it belongs to a domain that no longer exists — leaving
> the wallet as your only usable signer. On a testnet dev account that is fine,
> but note Haven will refuse to remove the dead passkey (it won't drop an account
> below two signers), so it just sits there. Redo the setup on the stable URL if
> you want a backup you can actually reach.

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

You will also see a hint on the Backup & recovery card: *"This account's Face ID
/ Touch ID may be on another device — your browser will guide you there when you
approve."* On a preview that is expected and correct (your passkey **is**
elsewhere), and you can ignore it — with the wallet connected, the wallet signs.

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
