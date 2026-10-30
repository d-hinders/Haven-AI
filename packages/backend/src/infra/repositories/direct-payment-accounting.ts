/**
 * SQL fragments for the DIRECT payment source of the accounting feed (#4533).
 *
 * A direct payment (`haven_send`, the delegation-redemption rail behind
 * `POST /payments`) settles on-chain but never produces a
 * `machine_payment_evidence` row: `recordMachinePaymentEvidenceBase` refuses it
 * on the rail gate (`PROTOCOL_RAILS` excludes `direct`) and, even past that, on
 * `resource_url NOT NULL`. Widening that table would turn every direct send
 * into a "machine payment" on 25 readers, so the feed reads the intent itself
 * instead — a second source, no migration.
 *
 * The fragments live here, in the repository layer, because THREE statements
 * need them and they must not drift:
 *
 *   - `ENTRY_SOURCE_SQL` in `modules/accounting/entry.ts` — what the entry is
 *     built from (the single-payment build, the period build, the feed);
 *   - `LIST_UNPUSHED_PAYMENT_IDS_SQL` in `./accounting-feed-syncs.ts` — what
 *     the backfill and the retry sweep enumerate;
 *   - `LOAD_RECEIPT_UNDERLAG_SOURCE_SQL` in `./machine-payments.ts` — the
 *     receipt document the feed attaches.
 *
 * All three alias `payment_intents` as `pi`.
 */

/**
 * What makes a `payment_intents` row a settled DIRECT payment.
 *
 * `payment_rail` is NULL on every row written before migration 012, where
 * `source` carries the same value ('direct' by default) — the COALESCE is the
 * rail read every other surface uses (`agent-payment-status.ts`,
 * `transaction-history.ts`). `execution_rail = 'delegation'` is the rail the
 * intent was authorized on; the retired allowance rail can no longer settle,
 * and an x402/mpp intent carries its own rail value, so this predicate is
 * disjoint from the evidence source.
 */
export const DIRECT_PAYMENT_RAIL_SQL = `
  pi.status = 'confirmed'
  AND pi.tx_hash IS NOT NULL
  AND pi.execution_rail = 'delegation'
  AND COALESCE(pi.payment_rail, pi.source) = 'direct'`

/**
 * Owner decision (Daniel, 2026-10-29, #4533): only a payment to an address
 * OUTSIDE the user's own Haven footprint is a purchase worth an underlag.
 *
 * Excluded: a transfer to another of the user's own smart accounts, and a
 * transfer to one of their agents' delegate addresses (which covers a sweep of
 * stranded delegate funds back to the account, and a refund to the user).
 * Contacts and every other third-party address count as outside and ARE fed.
 *
 * Case-insensitive: `payment_intents.to_address` is stored as the caller sent
 * it, while `smart_accounts.account_address` is checksummed. A recipient that
 * matches nothing is outside — an unknown address is never silently dropped.
 */
export const DIRECT_PAYMENT_OUTSIDE_ADDRESS_SQL = `
  NOT EXISTS (
    SELECT 1 FROM smart_accounts sa
    WHERE sa.user_id = pi.user_id
      AND lower(sa.account_address) = lower(pi.to_address)
  )
  AND NOT EXISTS (
    SELECT 1 FROM agents a
    WHERE a.user_id = pi.user_id
      AND lower(a.delegate_address) = lower(pi.to_address)
  )`
