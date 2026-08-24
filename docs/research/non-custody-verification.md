---
owner: "@d-hinders"
status: research
covers:
  - packages/backend/src/rails/allowance-module.ts
  - packages/backend/src/infra/relayer.ts
  - packages/backend/src/rails/execution-rail.ts
  - packages/backend/src/__tests__/non-custody.invariants.test.ts
  - packages/frontend/src/lib/revoke-agent.ts
last-verified: "2026-08-24" # #1988: the "control surface already exposed" bullet cited `/user/safes/:id/approvers` in the present tense; that route is deleted with the Safe rail, so the example is repointed at the two reads that still serve an owner list. The design premise survives — the surface exists, it is just a different route. Scope: that bullet. Prior: #1986: the invariants table rows 4 and 5 re-read against the AllowanceModule retirement — row 5's mechanism ("queued for approval") is legacy-rail-only and gone, and Red Line #4 is now only PARTIALLY proven on the live rail; addendum added naming the gap (#2004, Depends-on into #1991). Rows 1-3 and 6+ unaffected. Part 2/Phasing left alone — its "design proposal" framing is pre-existing drift, not this diff's. Prior: re-verified for #1251 (MPP seam refusal) — no claim here affected
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
([`allowance-module.ts`](../../packages/backend/src/rails/allowance-module.ts):232).
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
- **Two server signers, neither able to spend.** The relayer
  ([`relayer.ts`](../../packages/backend/src/infra/relayer.ts):27) pays gas; it is
  not a Safe owner or an allowance delegate. Since #974 there is a second:
  [`modules/passport/receipt.ts`](../../packages/backend/src/modules/passport/receipt.ts)
  signs L0 passport verification receipts. It is a **message signer only** — no
  provider, no `sendTransaction`, and a dedicated key
  (`PASSPORT_RECEIPT_SIGNING_KEY`) that is never the relayer's, because its
  address is *published* for merchants to pin. Every other `new Wallet` is in
  tests. The invariant is unchanged in substance — neither signer can move value
  — but it is now an explicit two-name allow-list rather than a count, so adding
  a third is a decision someone has to make on purpose.
- **Agent secret is identity, hashed at rest.** `agents.api_key_hash` +
  `api_key_prefix` exist; a legacy plaintext `agents.api_key` column lingers
  (nullable). Per policy, "API auth is identity, signature is authority" — but
  the plaintext column should be fully retired.
- **Control surface already exposed.** `/safe/:addr/details` (owners,
  threshold), `GET /user/safes/:safeId`, on-chain allowances, and the agents
  API already return everything a "verify your control" view needs.
  (`/user/safes/:id/approvers` was on this list until #1988 deleted it with the
  Safe rail; the owner list it served is still reachable from the two reads
  named above.)

These facts are true *now* — the point of Part 1 is to keep them true.

## Part 1 — CI invariants that prove the perimeter

A small suite that runs on every PR (a dedicated `non-custody.invariants.test.ts`
plus one structural script), each check mapped to a guardrail line. A failure
blocks merge and points at the guardrail it would break.

| # | Invariant | Check | Guardrail |
|---|---|---|---|
| 1 | No key/seed storage | Scan all migrations + entity types for `private_key\|seed\|mnemonic\|secret_key` column names → must be empty | Red Line #1/#2; "no private key storage table" |
| 2 | No plaintext key material at rest | Assert agent secrets are stored hashed; fail if a new column matches a secret-value pattern without `_hash` | Red Line #3 |
| 3 | No server signer capable of spending | Static check: the env-derived `new Wallet(` sites in `src/` (excluding tests) are EXACTLY `infra/relayer.ts` and `modules/passport/receipt.ts` — an exhaustive allow-list, so a third is a deliberate decision. Assert the relayer address is never written as a Safe owner or allowance `delegate`, and that the receipt signer stays message-only (no provider, no `sendTransaction`, never the relayer key) | "no signer capable of spending"; Hard Invariants |
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

### Safe / AllowanceModule rail retirement (#1986, epic #1440) — what rows 4 and 5 now mean

> **Read this before rows 4 and 5 above.** Both were written against the legacy
> AllowanceModule rail, and #1986 fail-closes that rail: every payment entry
> point answers HTTP 410 for an `allowance_module` account. A rail that cannot
> spend cannot demonstrate "only a valid signature releases a transfer", so the
> three contract suites (`non-custody-authz`, `non-custody-onchain-gate`,
> `non-custody-relay`) were **re-based onto the delegation rail** rather than
> converted into refusal assertions — a proof that can only say no is not a
> proof.

**Row 4 (Red Line #3) — still proven, on the live rail.** The delegation-rail
cases assert that an authenticated request with no signature, a
shape-invalid signature, or a signature the account rejects on-chain never
releases a payment, and the positive control in the same run shows a correct
signature does. **Scope limit, stated:** the suite proves Haven *forwards* the
account's verdict; it does not prove the delegate smart account's
`validateUserOp` itself rejects a non-delegate signature, which is on-chain
code behind the mocked bundler seam.

**Row 5 (Red Line #4) — PARTIALLY proven, and the gap is filed.** The row's
described mechanism — *"an over-allowance payment is queued for approval"* — is
**legacy-rail-only and no longer exists**. The delegation rail has no approval
queue at all: an out-of-policy redemption reverts on-chain during bundler gas
estimation, enforced by the caveat enforcers. What the re-based suite proves is
that Haven performs **no off-chain coverage arithmetic** on that rail
(`computeEffectiveAllowance` / `getTokenAllowance` / `decideCoverage` are never
called on the delegation branch) and forwards a rejection verbatim with nothing
written. What it does **not** prove, and structurally cannot from a backend unit
test, is that the enforcers revert correctly. That gap is tracked as
[#2004](https://github.com/d-hinders/Haven-AI/issues/2004) and is a hard
`Depends on` for [#1991](https://github.com/d-hinders/Haven-AI/issues/1991), the
CASP rewrite — so the guardrails cannot be re-based onto the delegation rail
while claiming a control is proven on every PR that nothing proves. It needs a
forked-chain or testnet integration proof, with a positive control.

### Session-key rail extension (#736, ADR #719 Stage 2)

> **Historical (#834):** the session rail is retired and the modules named
> below are deleted. Invariants 5–10 live on in their delegation-rail
> equivalents — see the mapping table in
> [`delegation-rail-security-model.md`](../security/delegation-rail-security-model.md).

The ERC-4337 rail (Safe7579 + Smart Sessions) kept the same perimeter —
Haven constructs, the customer signs — and `non-custody.invariants.test.ts`
pinned the specific mechanisms:

| # | Invariant | Pin |
|---|---|---|
| 5 | The Safe "owner" the rail derives accounts from cannot sign | `watchOnlyOwner` in `session-rail.ts` — every owner sign method bound to a loud refusal |
| 6 | No viem key-derived signer server-side | `privateKeyToAccount` (and mnemonic/HD variants) absent from production `src/` |
| 7 | Session UserOps carry client signatures only | `submitSessionTransfer` takes the signature as an argument; nothing in the rail produces one |
| 8 | Session config is owner-signed, never relayer-submitted | `session-policies.ts` / `session-rotation.ts` / `execution-rail.ts` are signer-free and never reference the relayer |
| 9 | The bundler credential has one auditable choke point | `SESSION_RAIL_BUNDLER_URL` read only in `execution-rail.ts` |
| 10 | The paymaster sponsors gas, never value | Wired as a sponsorship client only; no token-paymaster surface |

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
- [`allowance-module.ts`](../../packages/backend/src/rails/allowance-module.ts) — on-chain allowance read + relayer-gas-only transfer.
- [`02-identity-and-custody.md`](../architecture/02-identity-and-custody.md) — the custody model this makes provable.
