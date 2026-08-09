---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/lib/signer.ts
  - packages/frontend/src/hooks/useDelegationBudget.ts
  - packages/frontend/src/hooks/useAccountSigners.ts
  - packages/frontend/src/components/AccountSignersCard.tsx
  - packages/backend/src/rails/hybrid-signer-actions.ts
last-verified: "2026-08-09" # stale-claims sweep: #1153 posture (no code gate), #980 path moves
---

# Dev testing with a wallet signer

Passkeys are bound to the domain they were created on, so a passkey made on one
PR preview is useless on the next. Enrol a wallet as a second signer once, and
the same dev account works on every preview link — you connect the wallet and
sign with that instead.

Five minutes, once. You need a test wallet (MetaMask on Base Sepolia); it never
holds real value.

## Setup

Do all three steps on the **stable dev URL** —
`https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app` — so
the passkey you create stays reachable. (Not `haven-ai-frontend.vercel.app`,
which is production.)

1. **Sign up** with email + password, then create your account with Face ID /
   Touch ID.
2. **Account page → Backup & recovery → add a wallet.** Paste your wallet's
   address and approve with Face ID. You supply the address only — the wallet
   doesn't need to be connected, and you pay no gas.
3. **Check the card now lists two ways to approve:** your wallet, and Face ID /
   Touch ID.

## Testing on a PR preview

1. **Log in** with email + password — same account, same data, every preview
   points at the same dev backend.
2. **Connect your wallet before anything else.**
3. Set budgets, revoke, manage signers, run agents. Each action pops a MetaMask
   signature instead of a passkey prompt.

**Connect first, or it won't work.** With no wallet connected the app falls back
to the passkey, which lives on another domain, and you land on the cross-device
QR screen — a dead end, because that QR is domain-bound too. Close it, connect,
retry.

**Connect the *enrolled* wallet.** Any connected wallet is accepted by the UI;
the ownership check happens on-chain, so the wrong account fails with an unhelpful
error. Check MetaMask's selected account first.

The card may say *"This account's Face ID / Touch ID may be on another device"*.
On a preview that's expected — ignore it, the wallet signs.

## Testing passkeys on a preview

You don't need a new account. Log in, connect your wallet, then **Backup &
recovery → add a backup passkey** — the wallet signs the change and the new
passkey is created on that domain. Only onboarding itself still needs a
throwaway account.

## Notes

- **One wallet owner per account** (it's `transferOwnership`, a single slot), so
  each person needs their own dev account and wallet.
- **Reversible** — remove the wallet again from the same card, as long as a
  usable passkey remains.
- **Same shape as mainnet** — enrolling a second signer is exactly what the
  post-funding backup recommendation asks for there (#1153; no chain requires
  two signers any more), so nothing here is a dev-only hack. A dead passkey
  (setup done on a since-deleted preview) is survivable on any chain as long
  as one usable signer remains — which is the recommendation's whole point.

See [`dev-environment.md`](dev-environment.md) for the rest of the dev stack.
