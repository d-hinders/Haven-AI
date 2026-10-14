---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/infra/repositories/sponsored-userop-gas.ts
  - packages/backend/src/modules/payments/sponsored-gas.ts
  - packages/backend/src/modules/ops/sponsored-gas.ts
  - packages/backend/src/db/migrations/110_sponsored_userop_gas_events.ts
last-verified: "2026-10-10"
---

# Sponsored gas — the per-merchant view (#3837)

What Haven pays to sponsor delegation-rail UserOps on the payment path, per
merchant per day, next to the value those ops moved. The ops console shows it
at `/ops/sponsored-gas` (`GET /ops/sponsored-gas`); the ledger behind it is
`sponsored_userop_gas_events` (migration 110). Owner decision 2026-10-09:
**monitor only** — no threshold, no alert workflow, no new secret. An alert
can be a later issue once this view shows what a normal day looks like.

## What is recorded

Every UserOp submitted through `submitDelegationPayment` — the single caller
is `POST /payments/:id/sign`, which carries **both** direct payments and the
x402 EIP-3009 funding leg — writes one row:

| Column | Meaning |
| --- | --- |
| `leg` | `x402_funding` when `payment_intents.payment_rail = 'x402'`, else `direct` |
| `outcome` | `confirmed`, `included_reverted`, or `receipt_unconfirmed` |
| `actual_gas_cost_wei` | the EntryPoint receipt's `actualGasCost` (NULL when unknown) |
| `payment_intent_id` / `agent_id` / `user_id` | attribution; deliberately NOT foreign keys |

Three rules worth knowing:

- **A landed-but-REVERTED op still burned sponsored gas** — the cost rides the
  widened `SubmittedUserOpFailedError` (`actualGasCost`) and is recorded. Only
  the token transfer rolled back; the paymaster's gas did not.
- **A `receipt_unconfirmed` op has no known cost** — it is recorded with a
  cost-NULL row so the attempt still counts. The submission reconciler's later
  resolution does NOT backfill the cost (the reconciler reads a receipt shape
  that carries only inclusion/txHash; widening that is a deliberate
  non-goal for #3837).
- **A pre-send bundler rejection records NOTHING** — the op never entered the
  mempool, so nothing was sponsored.

erc7710 settlement is not sponsored by Haven (the merchant redeems the
[child, budget] chain) and never appears here.

## Cost basis

`actual_gas_cost_wei` is the EntryPoint receipt's **`actualGasCost`**, which
INCLUDES `preVerificationGas` — through which bundlers recover Base's L1 data
fee. The transaction-level `l1Fee` is therefore NOT added on top: it would
double-count the L1 data fee. This differs from #3777's measurement basis
(whole-transaction `gasUsed × effectiveGasPrice + l1Fee`) — compare against
this view, not those figures, when reasoning about the sponsorship bill.

## How the view prices gas

**ETH is priced at VIEW time.** The response states it
(`eth_priced_at: "view_time"`); the USD figures move with the market while the
wei figures do not. When the price feed returns no usable quote,
`eth_price_usd` is null and USD gas columns read `—` until a quote exists.

**Value moved** is the live join onto `payment_intents.usd_value` of
CONFIRMED intents only — a reverted op shows its burned gas against zero
value, and a still-pending intent contributes once it confirms.

**Gas / value** is `gas_usd / value_moved_usd`, null when gas was not priced
or nothing moved — a ratio against an empty denominator is meaningless, not 0.

## Bucketing

x402 funding legs bucket by the **merchant host** extracted (in SQL, by the
one shared host rule in `db/url-host.ts`) from the live join on
`payment_intents.payment_resource_url` (migration 012) — no host copy exists
on the ledger, so an intent-side backfill is reflected in the view. Direct
payments have no merchant and appear as their own `direct` / NULL-host
bucket. Day buckets are UTC.

## Why not `relayer_gas_events`

`relayer_gas_events` (migration 054) is simultaneously the relayer budget
guard's count substrate (`countRecentEvents`), the user-facing
`gas_sponsored_ops` figure (`GAS_EVENTS_BY_CHAIN_SQL` counts every row), and
the `relayerSpendSummary` rollup — new operation kinds there would either trip
none of that or silently change the meaning of all of it. The separate ledger
keeps those readers untouched, which is proven on the real-DB harness
(`infra/repositories/__tests__/sponsored-userop-gas.db.test.ts`: sponsored
rows inserted, `gas_sponsored_ops`'s query still returns nothing).

## Failure direction

Recording is **awaited-and-swallowed**: the route awaits the write (so it is
deterministic and testable) and swallows every failure with a warn. A
recording failure NEVER fails a payment, and the write sits OUTSIDE the
`confirmSubmittedIntent` booking flow — a forced-failing insert is proven to
leave the payment confirmed in
`routes/__tests__/payments-sponsored-gas.test.ts`.

## Reading a normal day

Gas on Base is cheap: a funding leg is typically ~10⁻⁴ ETH (a few cents), so
the interesting columns are the **ops count** (is volume spiking?) and the
**gas/value ratio** (is sponsorship cost becoming material relative to what
the legs move?). The ratio on direct payments is usually meaningless — direct
legs move arbitrary amounts to arbitrary recipients — so read it on the
x402-funding buckets.
