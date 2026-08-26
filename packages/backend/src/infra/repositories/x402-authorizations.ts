/**
 * Data access for the x402 authorization flow over `payment_intents`
 * (#995, epic #980 M3). Extracted verbatim from `routes/x402.ts` and the
 * x402 rate-limit reads formerly in `lib/machine-payments.ts` (moved to
 * `modules/mpp/authorize.ts` by #997).
 *
 * The aggregate here is the x402 AUTHORIZATION LIFECYCLE, not a table of its
 * own: idempotent replay lookup, stale-intent refresh, one-shot execute
 * transitions, and the erc7710 settle handoff — all x402-scoped statements
 * against `payment_intents` (`COALESCE(payment_rail, source) = 'x402'` guards)
 * plus the per-agent hourly cap read (#961).
 *
 * Convention — see `README.md` in this directory. Executor last, defaulting to
 * the pool; `agentId` tenant scope required; SQL in exported constants so
 * `scripts/db-schema-smoke.ts` can PREPARE it by import.
 *
 * **The SQL here is verbatim from the call sites.** Behaviour-preserving by
 * construction — in particular the #961 idempotency semantics: the lookup that
 * decides "resume the winner" and the guarded refresh that frees a stale key
 * keep exactly their original predicates.
 */

import pool from '../../db.js'
import { type Executor, withTransaction } from '../transaction.js'
import { type PaymentIntentRow } from './payment-intents.js'

export type { Executor }

// ── Hourly cap (#961) ────────────────────────────────────────────────────────

export const GET_MAX_X402_PER_HOUR_SQL = `SELECT max_x402_per_hour FROM agents WHERE id = $1`

export const COUNT_RECENT_X402_INTENTS_SQL = `SELECT COUNT(*) as cnt FROM payment_intents
     WHERE agent_id = $1 AND source = 'x402' AND created_at > NOW() - interval '1 hour'`

export interface X402HourlyUsage {
  /** The agent's configured cap; 100 = default max per hour (NOT chain 100). */
  maxPerHour: number
  recentCount: number
}

/**
 * The two reads behind the per-agent hourly x402 cap, in their original order
 * (config, then count). The comparison stays with the caller — this function
 * only owns the data access.
 */
export async function getX402HourlyUsage(
  agentId: string,
  db: Executor = pool,
): Promise<X402HourlyUsage> {
  const agentConfig = await db.query(GET_MAX_X402_PER_HOUR_SQL, [agentId])
  // 100 = default max x402 calls per hour (rate limit), NOT chain 100.
  const maxPerHour = agentConfig.rows[0]?.max_x402_per_hour ?? 100
  const recentCount = await db.query(COUNT_RECENT_X402_INTENTS_SQL, [agentId])
  return { maxPerHour, recentCount: Number(recentCount.rows[0].cnt) }
}

// ── Idempotency lookups ──────────────────────────────────────────────────────

export const FIND_X402_INTENT_BY_KEY_SQL = `SELECT *
         FROM payment_intents
         WHERE agent_id = $1
           AND (x402_idempotency_key = $2 OR machine_idempotency_key = $2)
           AND COALESCE(payment_rail, source) = 'x402'
           AND status <> 'failed'
         ORDER BY created_at DESC
         LIMIT 1`

/**
 * The #961 replay lookup: excludes only `failed` rows, so a stale
 * `pending_signature` row past its expiry is still FOUND (and then lazily
 * expired by the caller to free the key). Both key columns are matched — x402
 * fills both.
 */
export async function findX402IntentByIdempotencyKey(
  agentId: string,
  idempotencyKey: string,
  db: Executor = pool,
): Promise<PaymentIntentRow | null> {
  const result = await db.query<PaymentIntentRow>(FIND_X402_INTENT_BY_KEY_SQL, [
    agentId,
    idempotencyKey,
  ])
  return result.rows[0] ?? null
}

export const FIND_ACTIVE_X402_INTENT_BY_KEY_SQL = `SELECT *
         FROM payment_intents
         WHERE agent_id = $1
           AND (x402_idempotency_key = $2 OR machine_idempotency_key = $2)
           AND COALESCE(payment_rail, source) = 'x402'
           AND status NOT IN ('failed', 'expired')
         ORDER BY created_at DESC
         LIMIT 1`

/**
 * The post-insert-conflict reload on the legacy rail — narrower than the
 * replay lookup above (`expired` excluded too, matching the unique index's
 * partial predicate). The two predicates differ deliberately; see #961.
 */
export async function findActiveX402IntentByIdempotencyKey(
  agentId: string,
  idempotencyKey: string,
  db: Executor = pool,
): Promise<PaymentIntentRow | null> {
  const result = await db.query<PaymentIntentRow>(FIND_ACTIVE_X402_INTENT_BY_KEY_SQL, [
    agentId,
    idempotencyKey,
  ])
  return result.rows[0] ?? null
}

// ── Stale-replay refresh (legacy rail) ───────────────────────────────────────

export const REFRESH_STALE_X402_INTENT_SQL = `UPDATE payment_intents
           SET allowance_nonce = $1,
               sign_hash = $2,
               status = 'pending_signature',
               expires_at = NOW() + interval '10 minutes',
               error_message = NULL
           WHERE id = $3
             AND agent_id = $4
             AND COALESCE(payment_rail, source) = 'x402'
             AND status IN ('pending_signature', 'expired')
             AND tx_hash IS NULL
             AND signature IS NULL
             AND (
               status = 'expired'
               OR expires_at <= NOW()
               OR allowance_nonce <> $1
               OR sign_hash <> $2
             )
           RETURNING id, status, sign_hash, allowance_nonce, expires_at`

export interface RefreshedX402IntentRow {
  id: string
  status: string
  sign_hash: string
  allowance_nonce: number
  expires_at: string
}

/**
 * Revive a stale/expired replayed intent with a fresh nonce+hash — guarded so
 * it can never touch a signed, submitted, or progressed row. Returns the
 * refreshed row, or `null` when the guard matched nothing (the caller decides
 * whether that is fine — nothing was stale — or a 409).
 */
export async function refreshStaleX402Intent(
  input: { allowanceNonce: number; signHash: string; intentId: string; agentId: string },
  db: Executor = pool,
): Promise<RefreshedX402IntentRow | null> {
  const result = await db.query<RefreshedX402IntentRow>(REFRESH_STALE_X402_INTENT_SQL, [
    input.allowanceNonce,
    input.signHash,
    input.intentId,
    input.agentId,
  ])
  return result.rows[0] ?? null
}

// ── One-shot execute transitions (legacy rail) ───────────────────────────────

export const RECORD_X402_SIGNATURE_SQL = `UPDATE payment_intents
         SET signature = $1, signed_at = NOW()
         WHERE id = $2
           AND agent_id = $3
           AND COALESCE(payment_rail, source) = 'x402'
           AND status = 'pending_signature'
           AND tx_hash IS NULL
         RETURNING id`

/**
 * One-shot mode records the signature WITHOUT flipping to 'submitted' — the
 * intent stays 'pending_signature' until execution succeeds so a crash before
 * the RPC call cannot strand it (see the route's comment). False when the row
 * progressed meanwhile.
 */
export async function recordX402Signature(
  signature: string,
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(RECORD_X402_SIGNATURE_SQL, [
    signature,
    intentId,
    agentId,
  ])
  return result.rows.length > 0
}

export const CONFIRM_X402_INTENT_SQL = `UPDATE payment_intents
           SET status = 'confirmed',
               tx_hash = $1,
               submitted_at = NOW(),
               confirmed_at = NOW(),
               usd_value = $3,
               eur_value = $4
           WHERE id = $2
             AND agent_id = $5
             AND COALESCE(payment_rail, source) = 'x402'
             AND status = 'pending_signature'
             AND tx_hash IS NULL
           RETURNING id`

/** One-shot confirm: 'pending_signature' → 'confirmed' in one guarded write. */
export async function confirmX402Intent(
  input: {
    txHash: string
    intentId: string
    usdValue: number | string | null
    eurValue: number | string | null
    agentId: string
  },
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(CONFIRM_X402_INTENT_SQL, [
    input.txHash,
    input.intentId,
    input.usdValue,
    input.eurValue,
    input.agentId,
  ])
  return result.rows.length > 0
}

export const FAIL_X402_INTENT_SQL = `UPDATE payment_intents
           SET status = 'failed', error_message = $1
           WHERE id = $2
             AND agent_id = $3
             AND COALESCE(payment_rail, source) = 'x402'
             AND status = 'pending_signature'
             AND tx_hash IS NULL`

export async function failPendingX402Intent(
  errorMessage: string,
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(FAIL_X402_INTENT_SQL, [errorMessage, intentId, agentId])
}

// ── erc7710 settle handoff (#830) ────────────────────────────────────────────

export const FIND_SETTLE_INTENT_SQL = `SELECT id, status, execution_rail, prepared_user_op, chain_id, x402_resource_url,
                to_address, amount_raw, token_address
         FROM payment_intents
         WHERE id = $1 AND agent_id = $2`

export interface SettleIntentRow {
  id: string
  status: string
  execution_rail: string | null
  prepared_user_op: unknown
  chain_id: number
  x402_resource_url: string | null
  to_address: string
  amount_raw: string
  token_address: string
}

export async function findSettleIntent(
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<SettleIntentRow | null> {
  const result = await db.query<SettleIntentRow>(FIND_SETTLE_INTENT_SQL, [intentId, agentId])
  return result.rows[0] ?? null
}

export const MARK_INTENT_SUBMITTED_FOR_SETTLEMENT_SQL = `UPDATE payment_intents
           SET status = 'submitted', signature = $1, signed_at = NOW(), submitted_at = NOW()
           WHERE id = $2 AND agent_id = $3 AND status = 'pending_signature'`

/**
 * Flip the settled child to 'submitted' AFTER the X-PAYMENT header is fully
 * assembled — the header is emitted exactly once, and a retry after this write
 * 409s on the status guard (see the route's #976 ordering comment).
 */
export async function markIntentSubmittedForSettlement(
  signature: string,
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(MARK_INTENT_SUBMITTED_FOR_SETTLEMENT_SQL, [signature, intentId, agentId])
}

// ── erc7710 settlement-observed confirm (#2092) ──────────────────────────────

export const CONFIRM_SETTLEMENT_OBSERVED_SQL = `UPDATE payment_intents
           SET status = 'confirmed',
               tx_hash = $1,
               confirmed_at = NOW(),
               usd_value = $4,
               eur_value = $5
           WHERE id = $2
             AND agent_id = $3
             AND COALESCE(payment_rail, source) = 'x402'
             AND execution_rail = 'delegation'
             AND machine_metadata->>'settlement_scheme' = 'erc7710'
             AND status = 'submitted'
             AND tx_hash IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM payment_intents other
                WHERE other.tx_hash IS NOT NULL
                  AND LOWER(other.tx_hash) = LOWER($1)
                  AND other.id <> $2
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM payment_intents me
                 JOIN payment_intents twin
                   ON twin.id <> me.id
                  AND twin.agent_id = me.agent_id
                  AND twin.chain_id = me.chain_id
                  AND twin.status = 'submitted'
                  AND twin.tx_hash IS NULL
                  AND LOWER(twin.token_address) = LOWER(me.token_address)
                  AND LOWER(twin.to_address) = LOWER(me.to_address)
                  AND twin.amount_raw = me.amount_raw
                  AND twin.execution_rail = 'delegation'
                  AND twin.machine_metadata->>'settlement_scheme' = 'erc7710'
                  AND twin.created_at
                        BETWEEN me.created_at - ($6 * interval '1 second')
                            AND me.created_at + ($6 * interval '1 second')
                WHERE me.id = $2
             )
           RETURNING id`

/**
 * The erc7710 completion transition: `submitted` → `confirmed` with the
 * merchant's settlement tx hash (#2092).
 *
 * Every conjunct in the WHERE clause is load-bearing:
 *
 * - `payment_rail/source = 'x402'` + `execution_rail = 'delegation'` +
 *   `settlement_scheme = 'erc7710'` scope this transition to the ONE lifecycle
 *   that legitimately sits at `submitted` with no hash. A 3009 or legacy-rail
 *   intent can never be confirmed through this door, so those rails keep
 *   exactly the transitions they had.
 * - `status = 'submitted' AND tx_hash IS NULL` is the CAS: concurrent reports
 *   race it and exactly one wins, and a confirmed intent can never be
 *   re-pointed at a different hash.
 * - The first `NOT EXISTS (… same tx_hash …)` is the REPLAY guard: one
 *   settlement transaction may confirm at most one payment intent. Without it
 *   an agent holding one genuine hash could confirm every same-shaped intent it
 *   owns and multiply a single real payment into many book entries.
 * - The second `NOT EXISTS (… twin …)` is the AMBIGUITY guard, and it exists
 *   because of a property of the settlement child itself: two authorizations
 *   for the same merchant, token and amount in the same second produce a
 *   BYTE-IDENTICAL child delegation (`salt` is constant and the only varying
 *   field is the clock-derived expiry). Nothing on-chain then distinguishes
 *   them, so a verified transfer could be attached to either — silently
 *   attributing a real payment to the wrong purchase, and stranding the one
 *   that actually caused it. Haven refuses to GUESS: when a look-alike
 *   `submitted` erc7710 intent of the same agent/chain/token/recipient/amount
 *   exists within `$6` seconds (the maximum settlement window, so the only
 *   span in which two windows can overlap), the confirm is refused and BOTH
 *   intents stay `submitted`. Failing closed on an ambiguous settlement is the
 *   whole point: a missing book entry is recoverable, a wrong one is not.
 *
 * Callers MUST run this under {@link confirmObservedSettlement}, which takes a
 * transaction-scoped advisory lock on the hash — the `NOT EXISTS` alone leaves
 * a window in which two concurrent statements each see no prior row.
 *
 * Returns false when the guard matched nothing; the caller reports "not
 * confirmed" and the intent stays `submitted`. There is no path here that
 * confirms without a hash.
 */
export interface ObservedSettlementConfirm {
  txHash: string
  intentId: string
  agentId: string
  usdValue: number | string | null
  eurValue: number | string | null
  /** Maximum settlement-window span, in seconds — the ambiguity guard's reach. */
  windowSeconds: number
}

export async function confirmObservedSettlementRow(
  input: ObservedSettlementConfirm,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(CONFIRM_SETTLEMENT_OBSERVED_SQL, [
    input.txHash,
    input.intentId,
    input.agentId,
    input.usdValue,
    input.eurValue,
    input.windowSeconds,
  ])
  return result.rows.length > 0
}

/**
 * {@link confirmObservedSettlementRow} serialized per settlement hash.
 *
 * `pg_advisory_xact_lock` keyed on the lowercased hash closes the read-write
 * race the `NOT EXISTS` subquery cannot: two concurrent confirms naming the
 * same real transaction would otherwise both observe "no other row holds it"
 * and both commit. The lock is transaction-scoped, so it is released by the
 * COMMIT/ROLLBACK and never leaks. Chosen over a unique index because this
 * needs no migration and must not retroactively constrain historical rows.
 */
export async function confirmObservedSettlement(
  input: ObservedSettlementConfirm,
  db: Executor = pool,
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.txHash.toLowerCase()])
    return confirmObservedSettlementRow(input, tx)
  })
}
