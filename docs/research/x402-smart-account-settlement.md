---
owner: "@d-hinders"
status: research
covers: []  # narrative — no direct code mirror
last-verified: "2026-06-28"
---

# Research — Smart-account-native x402 settlement (removing the funding leg)

> Status: **investigation / decision aid** for [#431](https://github.com/d-hinders/Haven-AI/issues/431).
> No production code changes. The companion testnet prototype is specified in
> [§8](#8-prototype-spec-the-testnet-spike); running it needs funded testnet keys +
> a facilitator and is the next execution step, not part of this write-up.
>
> Partner-shareable background note (Google Doc) is linked from the issue.

## 1. TL;DR / recommendation

Haven's x402 payments settle in two legs today: the Safe AllowanceModule funds
an agent-controlled **delegate EOA**, which then signs the merchant-facing
EIP-3009 authorization. It works and is the right *compatibility* default, but
the funding leg is the source of our worst structural properties: a transient
hot balance, a payer-identity mismatch (merchant sees the delegate, not the
Safe), per-payment funding+signing overhead, and a two-leg reconciliation
surface (the `sweep` recovery path exists precisely because of it).

**Recommendation — pursue two tracks in parallel, keep EIP-3009/delegate as the
production default until a replacement is mature + audited + facilitator-supported:**

1. **Near-term (low lift, high certainty): Permit2 rail.** Broadens token
   coverage beyond EIP-3009 and is well supported by facilitators. It does
   *not* remove the funding leg (payer is still a delegate-style EOA), so treat
   it as a coverage win, not the architectural fix.
2. **Strategic (high lift, removes the funding leg): ERC-7710 smart-account
   delegation**, prototyped on testnet first. This is the only evaluated option
   that makes the **Safe the direct payer with no transient balance** while
   keeping the agent to scoped, revocable authority. It is also the cleanest
   on-chain home for Haven's budget model (see [§6](#6-mapping-haven-budgets--delegation-constraints)).
3. **Evaluate but don't bet on: EIP-1271/7598 "Safe-as-payer".** Conceptually
   the fastest way to remove the funding leg without a new permission model, but
   it lives or dies on **facilitator support for contract-signature verification**,
   which is the key unknown. Cheap to spike; verify support before investing.

Rail taxonomy used throughout:

```ts
type X402Rail =
  | 'eip3009_delegate_eoa'             // current default
  | 'permit2_delegate_eoa'             // broader ERC-20 coverage, still delegate payer
  | 'eip3009_safe_1271_experimental'  // Safe-as-payer via contract signature
  | 'erc7710_smart_account_experimental' // smart-account-native target
```

## 2. Current baseline (grounded in code)

Standard merchant x402 is `Safe → delegate EOA → merchant`:

1. Agent hits a paid resource → HTTP 402; the SDK parses x402 requirements
   ([`packages/sdk/src/x402.ts`](../../packages/sdk/src/x402.ts)).
2. The delegate EOA signs a merchant-facing EIP-3009 authorization.
3. Backend validates allowance / token / amount / network / policy and **funds
   the delegate EOA from the Safe via the AllowanceModule** for the exact amount
   ([`packages/backend/src/routes/x402.ts`](../../packages/backend/src/routes/x402.ts),
   [`packages/backend/src/lib/allowance-module.ts`](../../packages/backend/src/lib/allowance-module.ts)).
4. SDK retries with `X-PAYMENT`; merchant/facilitator settles delegate → merchant.

Two implementation details that exist *only because of the funding leg* and are
the clearest evidence of its cost:

- **Delegate-balance pre-flight.** Before funding, the backend reads the
  delegate's on-chain balance and computes coverage as
  `delegateBalance + remainingAllowance`, failing early with `insufficient_funds`
  when short ([`x402.ts`](../../packages/backend/src/routes/x402.ts)). This logic
  exists to reason about a wallet that *transiently holds liquid funds*.
- **Gasless delegate sweep.** [`packages/backend/src/lib/sweep.ts`](../../packages/backend/src/lib/sweep.ts)
  recovers stranded delegate USDC (merchant verified but didn't settle before
  expiry) via an EIP-3009 `transferWithAuthorization` back to the Safe. A target
  architecture with no funding leg deletes the *entire reason* this path exists.

Custody invariant today (must be preserved by any new rail): Haven never holds
the delegate key and never has unilateral signing authority over the Safe; the
delegate only ever holds funds transiently and within the user's budget
([`docs/regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md)).

## 3. Why the funding leg is hard to remove

The blocker is **EIP-3009 itself**: the authorization is token-native and signed
by the `from` address. To keep `from = Safe` we need the Safe to produce a valid
authorization — i.e. a **contract signature** (EIP-1271 / EIP-7598) — or to move
to an account-native authorization model (ERC-7710). Today's facilitators are
most mature around EIP-3009 (USDC/EURC) and Permit2; contract-signature and
delegation verification are emerging, not universal. So the funding leg is
fundamentally a *compatibility shim* that lets an EOA produce the one signature
shape facilitators reliably accept.

## 4. Options evaluation

| Dimension | `eip3009_delegate_eoa` (today) | `permit2_delegate_eoa` | `eip3009_safe_1271` | `erc7710_smart_account` |
|---|---|---|---|---|
| Merchant-visible payer | delegate EOA ❌ | delegate EOA ❌ | **Safe** ✅ | **Safe** ✅ |
| Removes funding leg | no | no | **yes** | **yes** |
| Transient hot balance | yes ❌ | yes ❌ | none ✅ | none ✅ |
| Token coverage | EIP-3009 only (USDC/EURC) | **broad ERC-20** ✅ | EIP-3009 tokens | token-agnostic (transfer calldata) |
| Facilitator maturity | **mature** ✅ | mature ✅ | **unknown — key risk** | emerging |
| Safe support | shipped | shipped | needs 1271 path + facilitator | **no native manager** (needs module / 3rd-party framework) |
| New permission model to audit | no (Allowance Module) | no | no | **yes — caveats/delegation** |
| Relative lift | — (baseline) | **low** | medium (gated by facilitator) | **high** |
| Strategic fit | compatibility | coverage win | funding-leg removal, narrow | funding-leg removal + budget-native |

Reading of the table: **Permit2** is the cheap coverage win; **ERC-7710** is the
strategic end state; **EIP-1271/7598** is a potential shortcut whose viability is
entirely a facilitator question and should be spiked before it's planned.

## 5. Recommended phased direction

- **Phase 0 (now):** keep `eip3009_delegate_eoa` as default. Make the rail a
  first-class, typed seam in the SDK/backend (the `X402Rail` union) so additional
  rails are additive, not forks — this also dovetails with the rail-agnostic fee
  module ([`docs/architecture/09-fee-module.md`](../architecture/09-fee-module.md)),
  whose `RailFeeExecutor` boundary should be the same seam.
- **Phase 1 (low lift):** add `permit2_delegate_eoa` for token coverage. No
  custody-model change; same delegate payer.
- **Phase 2 (spike, this issue):** testnet ERC-7710 prototype ([§8](#8-prototype-spec-the-testnet-spike)).
  In parallel, a one-day EIP-1271/7598 facilitator-support probe to decide if the
  Safe-as-payer shortcut is real.
- **Phase 3 (only after audit + facilitator support):** promote the chosen
  funding-leg-free rail to an opt-in production rail alongside EIP-3009, then make
  it default once mature.

## 6. Mapping Haven budgets → delegation constraints

The reason ERC-7710 is the strategic target and not just a settlement tweak: our
budget model maps almost 1:1 onto on-chain delegation caveats, moving enforcement
from backend checks into the account/module.

| Haven budget concept | Delegation constraint (ERC-7710 caveat) |
|---|---|
| Allowed token | token-contract allowlist |
| Max per payment | max ERC-20 transfer per redemption |
| Daily/monthly budget | on-chain period accounting / revocable session budget |
| Merchant restriction | recipient allowlist / merchant registry |
| x402-only usage | restrict callable target/method to the settlement path |
| Expiry | delegation expiration timestamp |
| Chain restriction | chain-specific delegation / domain separation |
| Agent identity | delegate/redeemer address restriction |

**Design invariant:** any security-critical permission must be enforceable by the
smart account / module / Delegation Manager. Backend checks remain
defense-in-depth, **not** the sole protection. This is the same invariant the
Allowance Module gives us today and must not regress.

## 7. Open questions — positions

Reasoned starting positions for the partner discussion (not final):

1. **Safe vs. a different ERC-7710-native account first?** Prototype on a
   ready-made ERC-7710 framework (e.g. MetaMask Delegation Framework) to prove
   the *settlement* end-to-end fast, then port to Safe-via-module. Don't block the
   spike on building a Safe delegation manager.
2. **Who is the redeemer?** The **agent EOA** as redeemer keeps Haven non-custodial
   and mirrors today's trust split (agent triggers, account pays). A Haven-controlled
   settlement contract centralizes a chokepoint we deliberately avoid.
3. **Can a delegation bind to a specific x402 request/resource/merchant?** Yes via
   caveats (recipient + amount + expiry + target-method); binding to a *resource
   URL* is off-chain metadata, so bind on-chain to merchant address + amount +
   expiry and carry the URL only as evidence.
4. **On-chain daily/monthly budgets without excess gas?** Prefer a revocable,
   short-lived **session budget** (re-issued per period) over on-chain rolling
   accounting; cheaper and simpler, and revocation is the safety valve.
5. **Replace the Allowance Module for x402, or run alongside?** **Alongside**, as a
   distinct rail. The Allowance Module is audited and shipped; ERC-7710 is Draft.
6. **Is EIP-1271/7598 a faster route?** Potentially yes — *if* facilitators verify
   contract signatures. Treat as a cheap spike that gates the decision; do not plan
   around it until confirmed.
7. **Which facilitator first?** Target the one with documented `erc7710`
   `assetTransferMethod` support for the exact scheme; fall back to a **local
   facilitator** for the prototype so the spike isn't blocked on a vendor.
8. **What evidence to return?** Same shape as today's machine-payment evidence
   ([`packages/backend/src/lib/machine-payment-evidence.ts`](../../packages/backend/src/lib/machine-payment-evidence.ts)):
   smart account, merchant, token, amount, chain, x402 resource, tx hash — so the
   fee/bookkeeping ledger ([#386](https://github.com/d-hinders/Haven-AI/issues/386))
   is rail-agnostic.
9. **Minimum audit scope before real funds?** The delegation/caveat policy
   contract or Safe module, the redemption path, and the off-chain→on-chain
   permission translation (budget → caveats). Backend changes alone are not
   sufficient since the security boundary moves on-chain.

## 8. Prototype spec (the testnet spike)

Kept isolated from production paths, behind an experimental flag. **Not run in
this write-up** — it needs a funded testnet account + a facilitator.

- **Chain:** Base Sepolia, test USDC.
- **Pieces:** one paid demo endpoint (reuse the demo-merchant pattern); one
  ERC-7710-capable smart-account framework; one compatible *or local* facilitator.
- **Delegation:** single caveat set — max amount, fixed recipient, expiry.

**Success criteria (copy of the issue's, as the prototype's acceptance):**
- [ ] Merchant returns x402 requirements with `assetTransferMethod = erc7710`.
- [ ] Haven/agent builds the payload with `delegator`, `delegationManager`,
      `permissionContext`, execution calldata.
- [ ] Facilitator verifies by simulation.
- [ ] Settlement transfers funds **directly from the smart account to the
      merchant** — no delegate funding leg.
- [ ] Evidence links smart account, merchant, token, amount, chain, x402 resource.

## 9. Non-goals (carried from the issue)

- Not replacing the EIP-3009 delegate-EOA flow as the production default.
- No production implementation, Safe-module audit, or mainnet rollout here.

## 10. References

- ERC-7710 (smart-contract delegation): https://eips.ethereum.org/EIPS/eip-7710
- ERC-3009 (transfer with authorization): https://eips.ethereum.org/EIPS/eip-3009
- ERC-1271 (contract signature validation): https://eips.ethereum.org/EIPS/eip-1271
- ERC-7598 (contract signature for signed transfer): https://eips.ethereum.org/EIPS/eip-7598
- x402 EVM exact scheme: https://raw.githubusercontent.com/x402-foundation/x402/main/specs/schemes/exact/scheme_exact_evm.md
- Coinbase x402 network/token support: https://docs.cdp.coinbase.com/x402/network-support
- MetaMask x402 delegation guide: https://docs.metamask.io/smart-accounts-kit/guides/x402/buyer/delegations/
- Current flow: [`docs/architecture/04-x402-payment-sequence.md`](../architecture/04-x402-payment-sequence.md)
