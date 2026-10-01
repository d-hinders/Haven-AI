/**
 * Read side of the delegation budget view (#1090): the ACTIVE
 * `agent_delegations` rows a delegation-rail agent's displayed budget is
 * derived from. Storage access only — the shaping lives in
 * `lib/delegation-budget-view.ts`.
 */

import pool from '../../db.js'
import { withTransaction, type Executor } from '../transaction.js'

export interface ActiveDelegationRow {
  id: string
  agent_id: string
  chain_id: number
  token_address: string
  budget_atomic: string
  period_seconds: number
  /**
   * #3518: the row's own identity and scope, so every consumer can tell
   * WHICH budget it is looking at and who it is pinned to — the selection
   * rule a payment runs (`SELECT_DELEGATION_FOR_PAYMENT_SQL`) is per-hash
   * and recipient-scoped, so a per-token first-match report can describe a
   * budget that did not pay. `recipient_address` is the pin (null = open),
   * `merchant_id` the #3331 merchant lock (never set without a pin).
   */
  delegation_hash: string
  recipient_address: string | null
  merchant_id: string | null
  /** Unix-second BIGINTs (node-postgres decodes them as strings) — the #1698 live window the payment selection filters on. */
  start_date: string
  expires_at: string
  /** Row creation (node-postgres decodes timestamptz to Date) — the payment rule's FINAL tie-break (`created_at DESC`). */
  created_at: Date
}

/**
 * The signed delegations for a set of delegation ids (#1145).
 *
 * Deliberately NOT folded into `listActiveDelegations` or the derived budget
 * view: a signed delegation is a capability, and those rows are spread
 * straight into JSON responses — carrying it there would put a redeemable
 * grant one careless spread away from the wire. Callers that genuinely need
 * it (the on-chain remaining-budget read) ask for it explicitly.
 */
export const LIST_DELEGATION_JSON_BY_IDS_SQL = `SELECT id, delegation_json
     FROM agent_delegations
     WHERE id = ANY($1)`

export async function listDelegationJsonByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const result = await pool.query<{ id: string; delegation_json: string }>(
    LIST_DELEGATION_JSON_BY_IDS_SQL,
    [ids],
  )
  return new Map(result.rows.map((r) => [r.id, r.delegation_json]))
}

export async function listActiveDelegations(
  agentIds: string[],
): Promise<ActiveDelegationRow[]> {
  if (agentIds.length === 0) return []
  // #3518: `delegation_hash` / `recipient_address` / `merchant_id` join the
  // select — the derived budget view carries each budget's identity and
  // scope (recipient pin, merchant lock) beside its amount, so every reader
  // can tell WHICH budget a row describes. The dashboard-facing narrow
  // projection (`deriveDelegationAllowances`) still strips to its frozen
  // six fields, so nothing leaks onto that wire.
  const result = await pool.query<ActiveDelegationRow>(
    `SELECT id, agent_id, chain_id, token_address, budget_atomic, period_seconds,
            delegation_hash, recipient_address, merchant_id, start_date, expires_at, created_at
     FROM agent_delegations
     WHERE agent_id = ANY($1) AND status = 'active'
     ORDER BY created_at ASC`,
    [agentIds],
  )
  return result.rows
}

/**
 * The still-pending build of a slot, when there is one (#2539).
 *
 * `build` used to be write-only: every call minted a fresh version and
 * inserted a fresh pending row, so the dashboard form's own rebuild of the
 * grant it was already showing left the older pending row behind forever. For
 * the dashboard that was invisible (it signs whatever build just returned);
 * for #2539's CLI it is fatal — the CLI prints a link to a pending row's hash
 * and then polls `GET /agents/:id/delegations` for THAT hash to go active,
 * which never converges if a second build bumped the version.
 *
 * So the same `(agent, token, recipient|open, budget, period, merchant)` slot with a
 * still-pending, unexpired row now RETURNS that row instead of building a
 * competitor to it: same hash, same version, 201 shape unchanged. The
 * parameters must match exactly — budget included, so "raise my budget" builds
 * a NEW version rather than silently re-handing the old amount — and the row
 * must still be pending (an already-signed slot is a replacement, #827's fresh
 * identity) and unexpired (an expired offer is dead; reuse would print a link
 * whose signature the chain refuses at the timestamp caveat).
 *
 * `budget_atomic` is a decimal string (VARCHAR(78)) because amounts must
 * survive above Number.MAX_SAFE_INTEGER; the comparison casts both sides to
 * numeric, so '5000000' and '05000000' match and '5000001' does not.
 */
// #3386: excludes `rekey_id IS NOT NULL` — a re-key's own pending rows are
// never a build-reuse candidate. Without this, carrying `merchant_id` onto a
// re-key's replacement pieces (#3386) would make an ABANDONED re-key's inert
// pending rows (dead: completion requires `stage = 'issued'`, and `abandoned`
// is terminal) eligible for merchant-scoped reuse here — handing a later
// ordinary build a row it never signed for. A live re-key's own pending rows
// must not be reused either: they exist to be activated by ITS OWN
// completion, not handed out as someone else's build result.
export const FIND_REUSABLE_PENDING_DELEGATION_SQL = `SELECT id, delegation_hash, version, delegation_json
     FROM agent_delegations
     WHERE agent_id = $1
       AND token_address = LOWER($2)
       AND recipient_address IS NOT DISTINCT FROM LOWER($3)
       AND status = 'pending'
       AND budget_atomic::numeric = $4::numeric
       AND period_seconds = $5
       AND expires_at >= $6
       AND merchant_id IS NOT DISTINCT FROM $7
       AND rekey_id IS NULL
     ORDER BY created_at ASC`

export interface ReusablePendingDelegationRow {
  id: string
  delegation_hash: string
  version: number
  delegation_json: string
}

export async function findReusablePendingDelegation(
  agentId: string,
  tokenAddress: string,
  recipientAddress: string | null,
  budgetAtomic: string,
  periodSeconds: number,
  expiresAt: number,
  db: Executor = pool,
  /**
   * #3331: the merchant a merchant-locked build is FOR (null for every other
   * build). Part of the match so a merchant build never re-hands a plain
   * pinned row with the same recipient — that row carries no merchant, and
   * the merchant page would never find the budget the owner just signed.
   */
  merchantId: string | null = null,
): Promise<ReusablePendingDelegationRow | null> {
  const result = await db.query<ReusablePendingDelegationRow>(
    FIND_REUSABLE_PENDING_DELEGATION_SQL,
    [agentId, tokenAddress, recipientAddress, budgetAtomic, periodSeconds, expiresAt, merchantId],
  )
  return result.rows[0] ?? null
}

/**
 * The slot key the build path serializes on (#2613).
 *
 * A slot is `(agent, token, recipient|open)` — the same tuple the version
 * counter is per, and the same one `findReusablePendingDelegation` matches
 * within. Budget and period are deliberately NOT in the key: two builds that
 * differ only in budget are a replacement pair whose version numbers must not
 * be computed concurrently either.
 */
export function delegationBuildSlotKey(
  agentId: string,
  tokenAddress: string,
  recipientAddress: string | null,
): string {
  return `delegation-build:${agentId}:${tokenAddress.toLowerCase()}:${recipientAddress?.toLowerCase() ?? 'open'}`
}

/**
 * Serialize the read-decide-insert of one build slot (#2613).
 *
 * `build`'s reuse read, its `MAX(version) + 1` read and its insert were three
 * unsynchronized statements. Two concurrent identical builds could each miss
 * the reuse read (neither had committed), each compute the same version, and
 * then insert SEPARATELY — because `startDate` is `nowSec - 60`, so a request
 * pair straddling a second boundary produces two different `delegation_hash`
 * values and the `ON CONFLICT (delegation_hash) DO NOTHING` never fires. The
 * result was two pending version-1 rows for one slot, both unsigned, and a
 * human left to guess which link to sign.
 *
 * `pg_advisory_xact_lock` on the slot key closes it: the second caller's reuse
 * read now runs after the first has committed, finds the row, and returns it —
 * which is the behaviour #2539 wanted in the first place, reached under
 * concurrency instead of only in the sequential case.
 *
 * The lock is transaction-scoped, so it releases on COMMIT or ROLLBACK with no
 * unlock path to forget. Keep RPC work OUT of `fn`: the caller derives the
 * delegate account address before taking the lock, because holding a database
 * lock across a chain round trip makes a slow node into a stalled slot.
 *
 * `fn` receives a QUERY-ONLY view of the transaction (`joined`, below). This
 * predates #3450: at the time this was written, `withTransaction` decided
 * whether to open a transaction by asking whether its executor has a
 * `connect` method — and the pg client it hands out has one, so passing the
 * raw client to a repository that wraps itself in `withTransaction`
 * (`insertPendingDelegationForOwnedNonRevokedAgent` does) made that
 * repository try to reconnect an already-connected client and throw. A plain
 * `{ query }` view has neither `connect` nor `release`, so the nested
 * `withTransaction` degraded to a direct call — the same effect #3450 later
 * gave `withTransaction` itself, by checking `release` instead of `connect`
 * (a real `pg.PoolClient` has both, which is what made `connect` alone the
 * wrong discriminator; see `infra/transaction.ts`). A checked-out `PoolClient`
 * now runs inline whether or not it is wrapped in a query-only view first, so
 * this view is redundant for that purpose today — but harmless, and kept
 * rather than unwound as a change this function does not need to make.
 */
export async function withDelegationBuildSlotLock<T>(
  agentId: string,
  tokenAddress: string,
  recipientAddress: string | null,
  fn: (tx: Executor) => Promise<T>,
  db: Executor = pool,
): Promise<T> {
  return withTransaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      delegationBuildSlotKey(agentId, tokenAddress, recipientAddress),
    ])
    const joined: Executor = { query: (sql, values) => tx.query(sql, values) }
    return fn(joined)
  })
}

// ── Payment authorization selection (moved from rails/delegation-authorization.ts, #999)

/**
 * The delegation that authorizes a payment: the ACTIVE row for (agent, token)
 * whose recipient matches, else the agent's ACTIVE open-budget row for that
 * token. A pinned delegation always wins over the open one — the tighter
 * grant is the one the owner meant for that recipient (#829).
 *
 * ## The time window (#1698, found by review)
 *
 * `status` used to be the only filter, and `created_at DESC` the only tie
 * break. That selected grants the chain would refuse: an ACTIVE row whose
 * `start_date` is still in the future (the period enforcer reverts before its
 * first period opens) or one already past `expires_at` (the timestamp caveat
 * refuses it). Both were unreachable while every grant anchored ~60 s in the
 * past — and #1698's carry makes the first one routine, because the "steady"
 * half of a carried budget is deliberately dormant until the old period
 * boundary and sits in the same (token, recipient) slot as the live "carry"
 * half. Under the old ordering the dormant grant, being newest, won every
 * payment for exactly the window the carry exists to cover.
 *
 * So the window is now part of the predicate. This can only ever narrow the
 * result to grants the chain would honour — it never admits a delegation that
 * was previously excluded, and never raises anyone's budget.
 *
 * ## Why soonest-expiring wins
 *
 * Among live grants, `expires_at ASC` prefers the one that dies first. For a
 * carried budget that is the carry grant, which is correct twice over: it is
 * the one holding the frozen remainder, and it is the one that becomes
 * worthless at the boundary. Spending the perishable grant before the
 * perpetual one is the same reasoning anywhere else. `created_at DESC` stays
 * as the final tie break so behaviour is unchanged for the ordinary case of
 * several grants sharing an expiry.
 *
 * `EXTRACT(EPOCH FROM NOW())` compares against the DATABASE clock rather than
 * the app's — the same choice the intent-expiry queries make, and for the
 * same reason: two app instances disagreeing about "now" must not disagree
 * about which grant authorizes a payment.
 */
export const SELECT_DELEGATION_FOR_PAYMENT_SQL = `SELECT delegation_hash, delegation_json, recipient_address, budget_atomic
     FROM agent_delegations
     WHERE agent_id = $1
       AND token_address = LOWER($2)
       AND status = 'active'
       AND (recipient_address = LOWER($3) OR recipient_address IS NULL)
       AND start_date <= EXTRACT(EPOCH FROM NOW())
       AND expires_at > EXTRACT(EPOCH FROM NOW())
     ORDER BY (recipient_address IS NULL), expires_at ASC, created_at DESC`

export interface DelegationForPaymentRow {
  delegation_hash: string
  delegation_json: string
  recipient_address: string | null
  /**
   * #3329 review finding D: the period budget as GRANTED — the fallback a
   * caller reads `readRemainingBudget` against on a failed on-chain read.
   * Distinct from any REQUESTED amount a caller is checking against it.
   */
  budget_atomic: string
}

/** `agentId` is the scope: delegations belong to exactly one agent. */
export async function selectDelegationForPayment(
  agentId: string,
  tokenAddress: string,
  toAddress: string,
): Promise<DelegationForPaymentRow | null> {
  const result = await pool.query<DelegationForPaymentRow>(SELECT_DELEGATION_FOR_PAYMENT_SQL, [
    agentId,
    tokenAddress,
    toAddress,
  ])
  return result.rows[0] ?? null
}

// ── Budget REPORT selection (#3518) ──────────────────────────────────────────

/**
 * #3518: the SAME selection a payment runs (`SELECT_DELEGATION_FOR_PAYMENT_SQL`
 * above), as a REPORT-side lookup: it takes the LIST of budgets the derived
 * view already read (never a second DB round trip) and answers which one pays
 * the `toAddress` — a recipient-pinned budget for that recipient wins, a pin
 * to a different recipient is excluded, and among the remaining (the pinned
 * match plus the open budget) the soonest-expiring active row wins, exactly
 * the payment rule's `ORDER BY (recipient_address IS NULL), expires_at ASC,
 * created_at DESC`.
 *
 * Deliberately NOT a re-derivation of the window: the DB-side predicate sees
 * the DATABASE clock, while this function compares against a `nowSec` the
 * CALLER passes — and callers that already hold live budgets can pass their
 * own clock. A row whose window has moved since the view read it can be
 * picked by the payment path seconds later anyway; the report names the row
 * by `delegation_hash`, so a consumer can always re-derive its liveness
 * exactly. The compare inputs that matter (remaining, sufficiency) always
 * describe the row this function returns.
 *
 * `toAddress: null` is the NO-MERCHANT-TO fallback (#3518's stated answer):
 * the quote did not name a payee, so only the OPEN budget is eligible — the
 * recipient-pinned rows are for specific recipients and a pinless quote
 * cannot claim one. That mirrors the payment rule (a pin to anyone wins over
 * the open row only when the recipient matches) with the pin side removed.
 */
export function selectBudgetForPaymentReport<
  T extends {
    id: string
    recipient_address: string | null
  },
>(
  budgets: T[],
  toAddress: string | null,
  nowSec: number,
  expiresAtOf: (b: T) => number,
  startAtOf: (b: T) => number,
  createdAtOf?: (b: T) => number | string,
): T | null {
  const now = BigInt(nowSec)
  const pinned = toAddress
    ? budgets.filter(
        (b) => b.recipient_address != null && b.recipient_address.toLowerCase() === toAddress.toLowerCase(),
      )
    : []
  const open = budgets.filter((b) => b.recipient_address == null)
  const candidates = [...pinned, ...open].filter((b) => expiresAtOf(b) > now && startAtOf(b) <= now)
  if (candidates.length === 0) return null
  // A pinned match ALWAYS sorts before an open budget; ties inside each
  // group resolve soonest-expiry first, then NEWEST-created first — the
  // payment rule's `created_at DESC` (the last ORDER BY key). The sort is
  // explicit on `createdAtOf`, NOT an accidental byproduct of input order:
  // a caller feeding rows in `created_at ASC` order would otherwise win the
  // tie for the OLDER row (a stable sort keeps the earlier one first), which
  // is the opposite of the rule this mirror exists to copy. Callers that
  // cannot supply a creation timestamp pass the default (a constant), which
  // makes the tie-break neutral — acceptable only where no two rows of one
  // group can share an expiry.
  return (
    candidates
      .map((b) => ({
        b,
        pinned: b.recipient_address != null ? 0 : 1,
        exp: expiresAtOf(b),
        created: Number(createdAtOf?.(b) ?? 0) || 0,
      }))
      .sort((a, z) => {
        if (a.pinned !== z.pinned) return a.pinned - z.pinned
        if (a.exp !== z.exp) return a.exp < z.exp ? -1 : 1
        return z.created - a.created
      })
      .map((entry) => entry.b)[0] ?? null
  )
}

/**
 * #3329 review finding E: the delegation a TASK BUDGET names as its parent
 * (`agent_task_budgets.parent_delegation_hash`), by its OWN identity — never
 * re-derived by (token, to). An agent holding both an open and a pinned
 * grant for the same token can have a task budget carved from the open one
 * while the payment's `to` also matches the pinned grant's recipient;
 * `selectDelegationForPayment`'s (token, to) selection would then pick the
 * PINNED grant — a different row than the task child's `authority` names —
 * and the redemption reverts. Selecting by hash cannot make that mistake:
 * it names the exact row, or none.
 */
// #3329 review finding N5: the SAME validity window `SELECT_DELEGATION_FOR_
// PAYMENT_SQL` enforces (#1698) — a not-yet-started or already-expired row
// is "active" only in Haven's bookkeeping; the on-chain TimestampEnforcer
// would revert redeeming it regardless. Excluding it here means a task
// budget whose parent fell outside its window answers a clean 409 at THIS
// lookup, not a gas-estimation revert three calls later. Owner decision
// #3329 review N5: both "not found/not active" and "active but out of
// window" collapse to the SAME null return and the SAME caller-side
// `task_budget_parent_mismatch` refusal — the agent's fix is identical in
// both cases (the referenced parent cannot currently authorize this task
// budget), so a second error code would distinguish without changing what
// anyone does about it.
export const SELECT_ACTIVE_DELEGATION_BY_HASH_SQL = `SELECT delegation_hash, delegation_json, recipient_address, budget_atomic
     FROM agent_delegations
     WHERE agent_id = $1 AND delegation_hash = $2 AND status = 'active'
       AND start_date <= EXTRACT(EPOCH FROM NOW())
       AND expires_at > EXTRACT(EPOCH FROM NOW())`

export async function selectActiveDelegationByHash(
  agentId: string,
  delegationHash: string,
): Promise<DelegationForPaymentRow | null> {
  const result = await pool.query<DelegationForPaymentRow>(SELECT_ACTIVE_DELEGATION_BY_HASH_SQL, [
    agentId,
    delegationHash,
  ])
  return result.rows[0] ?? null
}

/**
 * THE definition of a "live" delegation: every status the chain has not
 * confirmed dead (#3542). One SQL tuple, shared by the revoke-all target list
 * below, the `live_delegation_count` read on GET /agents, the archive guard and
 * the account-delete guard — so the four cannot drift apart. A guard that
 * ignored `replaced` would let an agent be archived, or its account deleted,
 * while an old key's delegation was still enabled on-chain.
 */
export const LIVE_DELEGATION_STATUSES_SQL = `('pending', 'active', 'replaced')`

/**
 * #1400: everything the batch revocation must kill — pending AND active
 * (a pending grant is still a signed delegation that could activate).
 *
 * #3343: `replaced` rows are in this list deliberately. The edit flow leaves
 * a row `replaced` in the DB while its delegation is still enabled on-chain
 * (the slot sweep marks the old grant replaced, and it is disabled only when
 * the owner's Stop userop lands). A re-key or revoke-all that skipped those
 * rows would complete while the OLD key's delegation stayed live — so
 * "still enabled" here means every status the chain has not confirmed dead.
 * The per-hash path and the payment paths do NOT read this list.
 */
export const LIST_NON_REVOKED_DELEGATIONS_FOR_AGENT_SQL = `SELECT delegation_hash, delegation_json, status
       FROM agent_delegations
       WHERE agent_id = $1 AND status IN ${LIVE_DELEGATION_STATUSES_SQL}
       ORDER BY created_at ASC`

export async function listNonRevokedDelegationsForAgent(
  agentId: string,
): Promise<Array<{ delegation_hash: string; delegation_json: string; status: string }>> {
  const result = await pool.query<{ delegation_hash: string; delegation_json: string; status: string }>(
    LIST_NON_REVOKED_DELEGATIONS_FOR_AGENT_SQL,
    [agentId],
  )
  return result.rows
}

/**
 * The row a per-hash revocation targets — the same read its prepare makes,
 * and since #3343 the submit makes too (it must resolve the row it would
 * mark, 404 on a missing one, before anything is submitted).
 */
export const SELECT_DELEGATION_ROW_FOR_AGENT_BY_HASH_SQL = `SELECT delegation_json, status
       FROM agent_delegations
       WHERE agent_id = $1 AND delegation_hash = $2`

export async function selectDelegationRowForAgentByHash(
  agentId: string,
  delegationHash: string,
): Promise<{ delegation_json: string; status: string } | null> {
  const result = await pool.query<{ delegation_json: string; status: string }>(
    SELECT_DELEGATION_ROW_FOR_AGENT_BY_HASH_SQL,
    [agentId, delegationHash],
  )
  return result.rows[0] ?? null
}

/**
 * Activate exactly the pending grant that the caller just authenticated.
 * The conditional update is intentionally kept in the repository so the
 * lifecycle route cannot add another inline write while preserving the
 * transaction executor supplied by its dedicated client.
 */
// #3439: `AND rekey_id IS NULL` is a backstop, not the primary guard — the
// primary refusal is in the route, before the slot sweep runs (a filter here
// alone would surface as the misleading "Delegation is no longer pending"
// after the sweep already ran and had to be rolled back). Re-key rows are
// activated only through `ACTIVATE_REKEY_DELEGATION_SQL` inside
// `completeRekey`, which this statement must never touch.
export const ACTIVATE_PENDING_DELEGATION_SQL = `UPDATE agent_delegations
       SET status = 'active', delegation_json = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'pending' AND rekey_id IS NULL
       RETURNING id`

export async function activatePendingDelegation(
  delegationId: string,
  signedDelegationJson: string,
  executor: Executor = pool,
): Promise<boolean> {
  const result = await executor.query<{ id: string }>(ACTIVATE_PENDING_DELEGATION_SQL, [
    signedDelegationJson,
    delegationId,
  ])
  return result.rows.length === 1
}

/**
 * Retire every OTHER active grant in the (agent, token, recipient) slot the
 * new grant is about to occupy (#2411). The on-chain kill of the old grant is
 * the revoke flow; this only stops Haven selecting it for payments.
 *
 * `AND id <> $4` is the load-bearing clause. #2331 reordered the activation
 * transaction so this sweep ran AFTER `activatePendingDelegation`, and the
 * sweep — then inlined in the route without an exclusion — flipped the row it
 * had just activated: every activation committed with ZERO active rows in
 * the slot and the first payment 403ed (qa-failure #2411, reproduced on real
 * Postgres). Excluding the row being activated by id makes the sweep correct
 * in EITHER order, so a future reorder cannot reintroduce the defect; the
 * order is restored as well, in `activatePendingDelegationInSlot`, because
 * both halves are cheap and the real-DB test proves each one separately.
 *
 * `recipient_address IS NOT DISTINCT FROM $3`: an open grant (NULL recipient)
 * and a recipient-pinned grant are different slots — a pinned grant never
 * retires the open one and vice versa (#829's selection order relies on both
 * coexisting). Returns the retired ids so a caller can report honestly.
 *
 * The executor defaults to the pool per this directory's convention, but a
 * sweep is only ever meaningful paired with an activation — call it through
 * `activatePendingDelegationInSlot` on the caller's transaction client, not
 * directly, or a failure after it leaves the slot with no active grant (the
 * #1053 finding 4 outage) with nothing to roll back (haven-reviewer, #2411).
 */
export const REPLACE_OTHER_ACTIVE_DELEGATIONS_IN_SLOT_SQL = `UPDATE agent_delegations
       SET status = 'replaced', updated_at = NOW()
       WHERE agent_id = $1
         AND token_address = $2
         AND recipient_address IS NOT DISTINCT FROM $3
         AND status = 'active'
         AND id <> $4
       RETURNING id`

export async function replaceOtherActiveDelegationsInSlot(
  agentId: string,
  tokenAddress: string,
  recipientAddress: string | null,
  exceptDelegationId: string,
  executor: Executor = pool,
): Promise<string[]> {
  const result = await executor.query<{ id: string }>(
    REPLACE_OTHER_ACTIVE_DELEGATIONS_IN_SLOT_SQL,
    [agentId, tokenAddress, recipientAddress, exceptDelegationId],
  )
  return result.rows.map((row) => row.id)
}

export interface ActivateDelegationInSlotInput {
  agentId: string
  /** The `agent_delegations.id` of the PENDING row being activated. */
  delegationId: string
  tokenAddress: string
  recipientAddress: string | null
  signedDelegationJson: string
}

/**
 * The activation sequence as ONE repository call (#2411): retire the slot's
 * other active grants FIRST, then flip exactly the pending row to active.
 * Owning the order here — rather than as two calls a route makes in whatever
 * order it happens to be edited into — is what lets the real-DB test in
 * `__tests__/delegation-budgets.test.ts` pin it: the test runs this function
 * and asserts the slot ends with exactly one active row, the new one.
 *
 * Returns `false` when the row is no longer pending (a concurrent revoke or a
 * repeated activate). MUST run on the caller's transaction client: the sweep
 * has already run by then, and only the caller's ROLLBACK undoes it — the
 * route (#1053 finding 4) rolls back and answers 409. It does not open its
 * own transaction because the route also locks the agent row and flips the
 * agent to active inside the same one.
 */
export async function activatePendingDelegationInSlot(
  input: ActivateDelegationInSlotInput,
  executor: Executor,
): Promise<boolean> {
  await replaceOtherActiveDelegationsInSlot(
    input.agentId,
    input.tokenAddress,
    input.recipientAddress,
    input.delegationId,
    executor,
  )
  return activatePendingDelegation(input.delegationId, input.signedDelegationJson, executor)
}

/**
 * #1400: ONE statement marks exactly the submitted batch revoked. Scoped by
 * agent_id so a stray hash from another agent flips nothing, and predicated
 * on status so an already-revoked row is not churned. Returns the hashes
 * actually flipped so the caller can report honestly.
 */
export const REVOKE_DELEGATIONS_BY_HASHES_SQL = `UPDATE agent_delegations
       SET status = 'revoked', updated_at = NOW()
       WHERE agent_id = $1 AND delegation_hash = ANY($2) AND status != 'revoked'
       RETURNING delegation_hash`

export async function revokeDelegationsByHashes(
  agentId: string,
  hashes: string[],
): Promise<string[]> {
  const result = await pool.query<{ delegation_hash: string }>(REVOKE_DELEGATIONS_BY_HASHES_SQL, [
    agentId,
    hashes,
  ])
  return result.rows.map((row) => row.delegation_hash)
}

/**
 * The owner's ACTIVE, unexpired merchant-locked budgets for one merchant
 * (#3331), with the agent's name — the merchant page's "remaining this period" list. Only
 * agents that are not revoked; `delegation_json` stays out of the row for
 * the reason `listDelegationJsonByIds` gives, and the caller asks for it
 * explicitly when it reads the enforcer.
 */
export const LIST_ACTIVE_MERCHANT_BUDGETS_FOR_USER_SQL = `SELECT d.id, d.agent_id, a.name AS agent_name,
            d.chain_id, d.token_address, d.recipient_address, d.delegation_hash,
            d.budget_atomic, d.period_seconds, d.expires_at
     FROM agent_delegations d
     JOIN agents a ON a.id = d.agent_id
     WHERE a.user_id = $1
       AND a.status <> 'revoked'
       AND d.merchant_id = $2
       AND d.status = 'active'
       AND d.expires_at > EXTRACT(EPOCH FROM now())
     ORDER BY a.name ASC, d.created_at ASC`

export interface MerchantBudgetRow {
  id: string
  agent_id: string
  agent_name: string
  chain_id: number
  token_address: string
  recipient_address: string
  delegation_hash: string
  budget_atomic: string
  period_seconds: number
  expires_at: string | number
}

export async function listActiveMerchantBudgetsForUser(
  userId: string,
  merchantId: string,
  db: Executor = pool,
): Promise<MerchantBudgetRow[]> {
  const result = await db.query<MerchantBudgetRow>(LIST_ACTIVE_MERCHANT_BUDGETS_FOR_USER_SQL, [userId, merchantId])
  return result.rows
}
