/**
 * Data access for the x402 authorization flow over `payment_intents`
 * (#995, epic #980 M3). Extracted verbatim from `routes/x402.ts` and the
 * x402 rate-limit reads formerly in `lib/machine-payments.ts` (moved to
 * `modules/mpp/authorize.ts` by #997).
 *
 * The aggregate here is the x402 AUTHORIZATION LIFECYCLE, not a table of its
 * own: idempotent replay lookup, one-shot execute transitions, and the
 * erc7710 settle handoff — all x402-scoped statements
 * against `payment_intents` (`COALESCE(payment_rail, source) = 'x402'` guards)
 * plus the per-agent hourly cap read (#961).
 *
 * Convention — see `README.md` in this directory. Executor last, defaulting to
 * the pool; `agentId` tenant scope required; SQL in exported constants so
 * `scripts/db-schema-smoke.ts` can PREPARE it by import.
 *
 * **The SQL here is verbatim from the call sites.** Behaviour-preserving by
 * construction — in particular the #961 idempotency semantics: the lookup that
 * decides "resume the winner" keeps exactly its original predicate. (The
 * guarded stale-replay refresh that freed a stale key went with the legacy
 * rail — #2469 deleted its now-callerless exports.)
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
 *
 * Its only caller (`findActiveX402IntentByIdempotencyKey`) went with the
 * legacy rail (#2469); the narrower predicate is kept here and PREPAREd by
 * the schema smoke as the recorded #961 semantics.
 */

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
                to_address, amount_raw, token_address, machine_metadata
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
  /**
   * #2361: carries the #1355 verbatim `payment_required`, whose
   * `resource`/`extensions` the settle handoff echoes into the X-PAYMENT
   * envelope. `Record` when the driver parsed the JSONB, `string` on drivers
   * that hand it back raw, `null` for pre-#1355 intents.
   */
  machine_metadata: Record<string, unknown> | string | null
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
                  -- #2094: a twin that is DISTINGUISHABLE on-chain is not a
                  -- look-alike. All three conjuncts are required together:
                  --   $7  — the DelegationManager's own RedeemedDelegation log
                  --         named THIS intent's child in THIS transaction
                  --         (verifier check 8). Without it we are attributing
                  --         on transfer shape alone, which cannot tell twins
                  --         apart however different their children are.
                  --   BOTH hashes present — a twin whose child was never
                  --         recorded (a pre-#2092 row) is UNKNOWN, and unknown
                  --         is ambiguous, not different. IS DISTINCT FROM
                  --         would have called NULL "a different child" and
                  --         waved such a twin through; it is spelled out as
                  --         two NOT NULLs plus <> so it cannot.
                  --   twin.delegation_hash <> me.delegation_hash — the twin's
                  --         child really is a different child.
                  -- Two pre-#2094 intents share a byte-identical child and so
                  -- share a delegation_hash: they fail the last conjunct and
                  -- the guard still refuses, which is the in-flight case.
                  AND NOT (
                        $7::boolean
                    AND me.delegation_hash IS NOT NULL
                    AND twin.delegation_hash IS NOT NULL
                    AND twin.delegation_hash <> me.delegation_hash
                  )
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
 *   exists within `$6` seconds — the caller passes the span in which two
 *   settlement windows can actually OVERLAP, which is wider than one window's
 *   own forward reach (see `AMBIGUITY_WINDOW_SECONDS` in
 *   `modules/x402/settlement-observed.ts` for the arithmetic) — the confirm is
 *   refused and BOTH
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
  /**
   * The ambiguity guard's reach, in seconds: how far apart two intents'
   * `created_at` values can be and still have overlapping settlement windows.
   * NOT the same as one window's width — see `AMBIGUITY_WINDOW_SECONDS`.
   */
  windowSeconds: number
  /**
   * #2094: true only when the verifier read this intent's OWN settlement child
   * back out of the pinned DelegationManager's `RedeemedDelegation` log
   * (check 8). It is the sole licence to look past a look-alike twin, because
   * it is the only evidence that says WHICH payment this transaction settled
   * rather than what shape it had. Defaults to false — an unbound settlement
   * gets #2096's guard at full reach.
   */
  delegationBound?: boolean
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
    input.delegationBound ?? false,
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

// ── passive settlement sweep candidates (#2117) ──────────────────────────────

/**
 * The open erc7710 settlements the passive sweeper may look for on-chain.
 *
 * Scoped to exactly `isPendingErc7710Settlement`'s lifecycle, so nothing else
 * can ever enter the sweep, plus two bounds that exist for cost rather than for
 * safety (safety is the verifier's and the guarded UPDATE's job):
 *
 * - `$1` **minimum age.** A payment authorized seconds ago is almost always
 *   about to be completed by its own agent's evidence report. Waiting a beat
 *   keeps the sweep off the happy path entirely, so the RPC cost is paid only
 *   for payments that actually went unreported.
 * - `$2` **recovery horizon**, and this is the answer to "what happens after
 *   the settlement window closes?". The window (≤600s) bounds when the
 *   transaction can have been MINED — that is fixed on-chain forever by the
 *   child's `timestamp` caveat. It does not bound when Haven may LOOK. An RPC
 *   outage spanning a payment's window is the likeliest real failure, and if
 *   the sweep only ever considered live windows, those payments would be lost
 *   for good — the gap merely moved. So the horizon is deliberately much wider
 *   than the window: the candidate stays sweepable long after its window shut,
 *   and the scan reaches back to where its transaction actually is. Looking
 *   further back is not less safe, because check 7 still requires the block to
 *   fall inside the intent's own window; the horizon only decides how much
 *   history a tick is willing to pay for.
 *
 * `delegation_hash IS NOT NULL` is a hard requirement, not an optimisation: the
 * stored child hash IS the lookup key. A row without one cannot be found by the
 * only attribution path the sweeper has, and there is no second path by design.
 *
 * It is also, today, defence-in-depth over an EMPTY SET rather than a filter
 * that drops live rows (#2214, from @PhilipEriksson's observation on PR #2134).
 * The sole production writer of `settlement_scheme = 'erc7710'` —
 * `modules/x402/delegation-authorize.ts` — sets `delegation_hash` in the SAME
 * `insertMachineIntent` call, and has since #830 introduced the path; nothing
 * UPDATEs `machine_metadata` or nulls the hash later. So this conjunct removes
 * nothing that exists, which matters because it sits in SQL UPSTREAM of
 * `sweepOne` and anything it DID remove would be silently excluded from the
 * sweeper's `unresolved` counter and its "log the rest loudly" warn as well.
 * That invariant is what makes the silence harmless, so the invariant — not a
 * counter for a population that cannot occur — is what
 * `__tests__/erc7710-sweep-eligibility.test.ts` pins.
 *
 * Oldest first: the candidates nearest the horizon are the ones that lose their
 * last chance if a tick runs out of budget.
 */
export const FIND_SWEEPABLE_ERC7710_INTENTS_SQL = `SELECT id, agent_id, chain_id, safe_address,
                to_address, token_symbol, token_address, amount_raw, amount_human,
                status, tx_hash, delegation_hash, created_at,
                source, payment_rail, execution_rail, machine_metadata
           FROM payment_intents
          WHERE status = 'submitted'
            AND tx_hash IS NULL
            AND COALESCE(payment_rail, source) = 'x402'
            AND execution_rail = 'delegation'
            AND machine_metadata->>'settlement_scheme' = 'erc7710'
            AND delegation_hash IS NOT NULL
            AND created_at <= NOW() - ($1 * interval '1 second')
            AND created_at >= NOW() - ($2 * interval '1 second')
          ORDER BY created_at ASC
          LIMIT $3`

export interface SweepableSettlementRow {
  id: string
  agent_id: string
  chain_id: number
  safe_address: string
  to_address: string
  token_symbol: string
  token_address: string
  amount_raw: string
  amount_human: string
  status: string
  tx_hash: string | null
  delegation_hash: string | null
  created_at: string
  source: string | null
  payment_rail: string | null
  execution_rail: string | null
  machine_metadata: Record<string, unknown> | string | null
}

/**
 * The recovery half of the sweep (#2213): an erc7710 intent that IS confirmed
 * and has a hash, but that no `machine_payment_evidence` row references.
 *
 * This population exists because the two writes cannot be one transaction. The
 * evidence write structurally REQUIRES the confirm to have landed first —
 * `recordMachinePaymentEvidenceBase` refuses anything not already `confirmed`
 * with a `tx_hash` — so a confirm that succeeds followed by an evidence write
 * that fails leaves a payment that is settled, booked nowhere, and (before this
 * query) outside every AUTOMATED retry path: it had left
 * `FIND_SWEEPABLE_ERC7710_INTENTS_SQL`'s `status = 'submitted'`, and the Fortnox
 * backfill enumerates evidence ROWS, so an absent row is invisible to it too.
 * A manual agent re-report would still have completed it — the gap was that
 * nothing prompts one, least of all a tick that logged success.
 *
 * Deliberately NOT scoped to sweep-confirmed intents. The orphan condition is
 * the same fact however the confirm happened — an agent-reported settlement
 * whose evidence write threw lands here identically — and narrowing it would
 * make recovery depend on which path created the hole.
 *
 * Bounded by the same recovery horizon as the forward sweep, so a permanently
 * unwritable row (a missing `resource_url`) is retried for a day and logged,
 * not retried forever.
 */
export const FIND_EVIDENCE_ORPHANED_ERC7710_INTENTS_SQL = `SELECT id, agent_id, chain_id, safe_address,
                to_address, token_symbol, token_address, amount_raw, amount_human,
                status, tx_hash, delegation_hash, created_at,
                source, payment_rail, execution_rail, machine_metadata
           FROM payment_intents pi
          WHERE status = 'confirmed'
            AND tx_hash IS NOT NULL
            AND COALESCE(payment_rail, source) = 'x402'
            AND execution_rail = 'delegation'
            AND machine_metadata->>'settlement_scheme' = 'erc7710'
            AND created_at <= NOW() - ($1 * interval '1 second')
            AND created_at >= NOW() - ($2 * interval '1 second')
            AND NOT EXISTS (
                  SELECT 1 FROM machine_payment_evidence mpe
                   WHERE mpe.payment_intent_id = pi.id
                )
          ORDER BY created_at ASC
          LIMIT $3`

export async function findEvidenceOrphanedErc7710Intents(
  minAgeSeconds: number,
  recoveryHorizonSeconds: number,
  limit: number,
  db: Executor = pool,
): Promise<SweepableSettlementRow[]> {
  const result = await db.query<SweepableSettlementRow>(
    FIND_EVIDENCE_ORPHANED_ERC7710_INTENTS_SQL,
    [minAgeSeconds, recoveryHorizonSeconds, limit],
  )
  return result.rows
}

export async function findSweepableErc7710Intents(
  minAgeSeconds: number,
  recoveryHorizonSeconds: number,
  limit: number,
  db: Executor = pool,
): Promise<SweepableSettlementRow[]> {
  const result = await db.query<SweepableSettlementRow>(FIND_SWEEPABLE_ERC7710_INTENTS_SQL, [
    minAgeSeconds,
    recoveryHorizonSeconds,
    limit,
  ])
  return result.rows
}
