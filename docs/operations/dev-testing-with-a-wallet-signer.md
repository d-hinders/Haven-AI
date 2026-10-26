---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/lib/signer.ts
  - packages/frontend/src/hooks/useDelegationBudget.ts
  - packages/frontend/src/hooks/useAccountSigners.ts
  - packages/frontend/src/components/AccountSignersCard.tsx
  - packages/frontend/src/components/PasskeyElsewhereHint.tsx
  - packages/backend/src/rails/hybrid-signer-actions.ts
last-verified: "2026-10-24"
---

# Dev testing with a wallet signer

Passkeys are bound to the domain they were created on, so a passkey made on one
preview is useless on the next. (PR previews are opt-in since #3821: a branch
gets one only under a `preview/` name, [`dev-environment.md` § PR previews are
opt-in](dev-environment.md#pr-previews-are-opt-in).) Enrol a wallet as a second signer once, and
the same dev account works on every preview link — you connect the wallet and
sign with that instead.

Five minutes, once. You need a test wallet (MetaMask on Base Sepolia); it never
holds real value.

## Setup

Do all three steps on the **stable dev URL** —
`https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app` — so
the passkey you create stays reachable. (Not `haven-ai-frontend.vercel.app`,
which is production.)

1. **Sign up** with email + password, then create your account with a passkey
   (usually approved with your device's screen lock).
2. **Account page → Security & details tab → *Who can approve* → Or add a
   wallet** (the tab and the *Who can approve* heading since #4142; #4166
   removed the card's second "Backup & recovery" heading). Paste your wallet's
   address, choose *Add wallet* and approve with your passkey. You supply the
   address only — the wallet doesn't need to be connected, and you pay no gas.
3. **Check the card now lists two ways to approve:** your wallet (labeled
   "Browser wallet", its address behind "Show address", #3825), and your
   passkey (labeled "Passkey · added {date}", #1679).

## Testing on a preview

1. **Sign in** with email + password — same account, same data, every preview
   points at the same dev backend.
2. **Connect your wallet before anything else:** Settings → Security →
   Passkeys and wallets → Connect wallet (#4358; the top bar has no wallet
   button since #3825), or the in-flow
   Connect wallet a signing screen offers.
3. Set budgets, revoke, manage signers, run agents. Each action pops a MetaMask
   signature instead of a passkey prompt.

**Connect first, or it won't work.** With no wallet connected the app falls back
to the passkey, which lives on another domain, and you land on the cross-device
QR screen — a dead end, because that QR is domain-bound too. Close it, connect,
retry.

**Connect the *enrolled* wallet.** Since #2068 the ownership check is
client-side: the EOA path is only offered when the connected address equals the
account's `owner_address`. A wrong account no longer fails on-chain with an
unhelpful error — it is never offered at all, and the app falls back to the
passkey path (the cross-device QR dead end above) or shows the no-signer state.
Check MetaMask's selected account first; "connected" alone proves nothing here.

If a signing screen says *"This account's passkey may be on another device"*,
the enrolled wallet is NOT the one that will sign — the passkey path will, and
that ends at the cross-device QR dead end above (since #3825 the line shows only
on the passkey path). Connect the enrolled wallet and retry.

## Testing passkeys on a preview

You don't need a new account. Sign in, connect your wallet (Settings → Security
→ Passkeys and wallets),
then on the account page's **Security & details** tab choose **Add a backup
passkey** — the wallet signs the change and the new passkey is created on
that domain. Only onboarding itself still needs a
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

> **Re-verified #3093 (frontend hooks: wire keys default instead of crashing):**
> this diff touched `hooks/useDelegationBudget.ts`, in this document's coverage list, by
> defaulting the array keys it stores (`?? []`; and `?? 0` on the portfolio
> totals) so an API answer without the key degrades to an empty state instead
> of sending the route into the ErrorBoundary. No endpoint, flow or
> behaviour this document describes changes. Scope of this note: those
> expressions. Nothing else in this document was re-verified.

> **Re-verified 2026-10-24 (#4372 part F, at dev `6d87ddf95`), a full re-read.**
> Changed: the add-a-wallet and add-a-backup-passkey steps name where the card
> lives now — the account page's *Security & details* tab, under *Who can
> approve* (both #4142), with its *Or add a wallet* / *Add wallet* and *Add a
> backup passkey* buttons (`components/AccountSignersCard.tsx`) — instead of a
> "Backup & recovery" card heading the page no longer renders (#4166, PR #4190,
> removed it). Re-checked
> without change: the stable dev URL (`dev-environment.md`), the opt-in PR
> previews (#3821), the "Browser wallet" / "Show address" (#3825) and
> "Passkey · added {date}" (#1679, `lib/passkeyLabels.ts`) labels, Settings →
> Security → *Passkeys and wallets* → *Connect wallet*
> (`components/settings/SignersSection.tsx`), the #2068 client-side owner
> check (`lib/signer.ts`), the "passkey may be on another device" line
> (`PasskeyElsewhereHint`, shown on the owner-signing flows when the passkey
> path signs), the single `transferOwnership` owner slot
> (`rails/hybrid-signer-actions.ts`), removal disabled below two signers, and
> #1153.
>
> **Review round 1 (haven-doc-reviewer @ `344d7ea91`).** The attribution was
> wrong: *Who can approve* came with #4142 (`git log -S'Who can approve</h2>' -- packages/frontend` →
> `fa1c20399`), and #4166 (PR #4190, `37ec8b7ba`) removed the card's
> duplicate "Backup & recovery" heading (`git log -S "Backup & recovery"` on
> `AccountSignersCard.tsx`).
