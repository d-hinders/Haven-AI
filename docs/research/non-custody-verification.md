---
owner: "@d-hinders"
status: research
covers: []  # narrative — no direct code mirror
last-verified: "2026-06-28"
---

# Design — make non-custody provable (CI invariants + "verify your control")

> Status: **design proposal.** Forward-looking; no implementation yet. Turns the
> [CASP/MiCA guardrails](../regulatory/casp-risk-guardrails.md) from prose into
> (a) automated checks that *prove* the perimeter on every PR and (b) a user-
> facing surface that *shows* it. No new authority, no fund movement, no
> regulatory exposure — it strengthens the existing non-custodial model by
> making it demonstrable.

## Why this, and why now

Haven's custody-critical controls are **already on-chain**: the Safe
AllowanceModule enforces per-token amount and reset period keyed by
`(safe, delegate, token)`, and `executeAllowanceTransfer` is authorised by the
**delegate's signature** — the relayer only pays gas
([`allowance-module.ts`](../../packages/backend/src/lib/allowance-module.ts):232).
The model is sound. The gap is **demonstrability**: the guardrails doc asks us to
"maintain evidence that Haven does not control funds" (§ of the same name) and to
keep the property "if Haven's backend disappeared, the Safe would still be
revocable on-chain" — but nothing *enforces* that evidence over time, and the
user can't *see* it.

This proposal closes that gap on two fronts.

## Current state (grounded)

What the codebase shows today:

- **No key storage.** No `private_key` / `seed` / `mnemonic` / `secret_key`
  column exists in any migration. ✅
- **One server signer, gas-only.** The only `new Wallet(...)` from env in
  production is the relayer ([`relayer.ts`](../../packages/backend/src/lib/relayer.ts):27);
  every other `new Wallet` is in tests. The relayer pays gas; it is not a Safe
  owner or an allowance delegate.
- **Agent secret is identity, hashed at rest.** `agents.api_key_hash` +
  `api_key_prefix` exist; a legacy plaintext `agents.api_key` column lingers
  (nullable). Per policy, "API auth is identity, signature is authority" — but
  the plaintext column should be fully retired.
- **Control surface already exposed.** `/safe/:addr/details` (owners,
  threshold), `/user/safes/:id/approvers`, on-chain allowances, and the agents
  API already return everything a "verify your control" view needs.

These facts are true *now* — the point of Part 1 is to keep them true.

## Part 1 — CI invariants that prove the perimeter

A small suite that runs on every PR (a dedicated `non-custody.invariants.test.ts`
plus one structural script), each check mapped to a guardrail line. A failure
blocks merge and points at the guardrail it would break.

| # | Invariant | Check | Guardrail |
|---|---|---|---|
| 1 | No key/seed storage | Scan all migrations + entity types for `private_key\|seed\|mnemonic\|secret_key` column names → must be empty | Red Line #1/#2; "no private key storage table" |
| 2 | No plaintext key material at rest | Assert agent secrets are stored hashed; fail if a new column matches a secret-value pattern without `_hash` | Red Line #3 |
| 3 | Single, gas-only server signer | Static check: the only env-derived `new Wallet(` in `src/` (excluding tests) is the relayer; assert relayer address is never written as a Safe owner or allowance `delegate` in any code path | "no signer capable of spending"; Hard Invariants |
| 4 | Authn ≠ authz on spend paths | Contract test: payment / relay endpoints reject a request that is authenticated (valid bearer) but carries no delegate/owner signature | Red Line #3; "Separate Authentication From Authorisation" |
| 5 | On-chain is the final gate | Test that an over-allowance payment is queued for approval, never silently settled — i.e. the DB is not the only limit | Red Line #4 |
| 6 | No discretionary mutation in relay | Test that the relay path does not alter recipient/amount/token/route after signature | "Treat Relaying As Non-Discretionary" |
| 7 | No lock-in | Assert a revoke path exists that produces a user-signed on-chain tx (not a Haven-only DB flip), and that allowances are readable from chain without Haven | Red Line #10 |

Plus a **machine-readable version of the "Payment-Related Merge Checklist"**: a
CI step that requires payment/agent/Safe/SDK/relayer PRs to tick the checklist
(label or template gate), so the human review the doc already mandates is
recorded, not implicit.

**Value:** every future PR now *proves* the non-custodial claims instead of
relying on reviewer memory — exactly the "maintain evidence" the doc asks for,
and the strongest possible answer to a CASP perimeter question. Zero UX, zero
fund movement.

## Part 2 — "Verify your control" (dashboard)

A surface (a tab, or a section on the account/settings page) that shows the user,
per Safe, that **they** control it — composed almost entirely from endpoints that
already exist.

What it shows:

- **Owners & threshold** (`/safe/:addr/details`) — "These keys control this Safe.
  Haven is not an owner and cannot sign for it."
- **Enabled modules** — the AllowanceModule, labelled as the on-chain spend
  control. (Small addition: surface module list if `/safe/:addr/details` doesn't
  already.)
- **Per-agent on-chain allowances** — delegate, token, amount, spent, reset —
  read from chain, each marked **🔒 on-chain enforced**.
- **Honest scope labels** — amount/token/reset/delegate = 🔒 on-chain;
  recipient = **ⓘ not constrained on-chain today** (the `to` in
  `executeAllowanceTransfer` is arbitrary). Truthful, and the right home for the
  optional recipient-pinning enhancement later.
- **"What Haven cannot do"** — a short, plain-language panel derived from the
  Hard Invariants (cannot move funds unilaterally, holds no keys, cannot expand
  allowances without your signature, cannot block you).

Actions (all user-authority, already supported):

- **Revoke agent on-chain** — the existing user-signed revoke flow
  ([`revoke-agent.ts`](../../packages/frontend/src/lib/revoke-agent.ts)),
  surfaced here as the circuit breaker.
- **Open in Safe\{Wallet\}** — a deep link to the user's Safe in the official
  Safe UI, proving "Haven is replaceable infrastructure" (Red Line #10) in one
  click.

**Value:** turns the guardrails into a *trust feature* a prospect or auditor can
see, and matches the doc's Product Copy Rules ("you can revoke agent access
through your Safe"). New backend work is minimal — mostly composition + a deep
link + honest labels.

## What this is NOT

- Not new authority, not a new signer, not fund movement.
- Not recipient/expiry on-chain enforcement — that's a separate *optional*
  enhancement (a Safe Guard / session-key) with real UX cost; this proposal only
  *labels* the current boundary honestly.
- Not a legal opinion — engineering evidence that supports the existing position.

## Phasing

- **P0 — CI invariants (Part 1).** Pure value, no UX, no risk. Lands the
  evidence the guardrails ask for and protects it forever.
- **P1 — "Verify your control" view (Part 2).** Composition over existing
  endpoints + the Safe\{Wallet\} deep link + honest labels.
- **P2 — (optional) verifiable receipts** — overlaps the bookkeeping audit trail
  ([#462](https://github.com/d-hinders/Haven-AI/issues/462)); a signed
  per-payment proof bundle the user verifies independently.

## Open questions

1. Does `/safe/:addr/details` already return enabled modules, or is that the one
   small backend addition for Part 2?
2. Retire the legacy plaintext `agents.api_key` column entirely (invariant #2)
   as part of P0, or track separately?
3. CI checklist gate: PR-template checkbox vs a Danger-style automated check on
   changed paths?

## References

- [`casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md) — the source of every invariant above.
- [`allowance-module.ts`](../../packages/backend/src/lib/allowance-module.ts) — on-chain allowance read + relayer-gas-only transfer.
- [`02-identity-and-custody.md`](../architecture/02-identity-and-custody.md) — the custody model this makes provable.
