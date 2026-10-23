/**
 * Storage for task budgets (#3329): short-lived, self-delegated CHILDREN of
 * an agent's budget delegation, scoped to one task. Every statement is
 * scoped by `agent_id` (and, for the owner-facing list, by the owning
 * `user_id` via a join) — a task budget belongs to exactly one agent, the
 * same discipline `agent_delegations` already keeps.
 *
 * "Expired" is derived (`expires_at <= now`), never a stored status — see the
 * migration header. Callers that need the wire shape's `is_expired` compute
 * it themselves from `expires_at`; this file only ever compares against
 * `nowSec` for the queries that must (open/closing selection, remainder sum).
 *
 * The module owns the TWO named liveness predicates every reader of
 * `agent_task_budgets` uses (#3919 S-B): {@link openTaskBudgetSql} — an
 * `open` row inside its spend window, the open list, the reserved sum — and
 * {@link liveTaskBudgetSql} — every row an agent can still act on (#3518),
 * the `status=live` list. No reader spells the window inline. Unlike the
 * delegation predicates (slice A), BOTH take the app clock as a `$n`
 * parameter placeholder rather than `NOW()`: the payment-time decision lives
 * in TypeScript (`modules/task-budgets/task-budget-service.ts`) against the
 * same `nowSec` the callers already hold, and the real-DB pin test passes
 * the identical value to both sides — one clock per table, and it is the
 * app's.
 */

import pool from '../../db.js'
import { type Executor } from '../transaction.js'

export interface TaskBudgetRow {
  id: string
  agent_id: string
  chain_id: number
  token_address: string
  recipient_address: string | null
  parent_delegation_hash: string
  delegation_hash: string
  delegation_json: string
  label: string | null
  max_atomic: string
  status: 'pending' | 'open' | 'closing' | 'closed'
  expires_at: string
  prepared_user_op: string | null
  close_tx_hash: string | null
  created_at: string
  updated_at: string
  opened_at: string | null
  closed_at: string | null
}

const SELECT_COLUMNS = `id, agent_id, chain_id, token_address, recipient_address,
       parent_delegation_hash, delegation_hash, delegation_json, label, max_atomic,
       status, expires_at, prepared_user_op, close_tx_hash,
       created_at, updated_at, opened_at, closed_at`

export interface InsertPendingTaskBudgetInput {
  /**
   * #3329 review finding B: the caller MINTS this id before building the
   * child, because `taskBudgetSalt(id)` has to be derived from the row's
   * real identity — a throwaway id would make `haven-task-budget:<id>` a
   * salt for a row that does not exist. Explicit `id` column, not the
   * table's `gen_random_uuid()` default, so the two are always the same value.
   */
  id: string
  agentId: string
  chainId: number
  tokenAddress: string
  recipientAddress: string | null
  parentDelegationHash: string
  delegationHash: string
  delegationJson: string
  label: string | null
  maxAtomic: string
  expiresAt: number
}

export const INSERT_PENDING_TASK_BUDGET_SQL = `INSERT INTO agent_task_budgets
       (id, agent_id, chain_id, token_address, recipient_address, parent_delegation_hash,
        delegation_hash, delegation_json, label, max_atomic, status, expires_at)
     VALUES ($1, $2, $3, LOWER($4), $5, $6, $7, $8, $9, $10, 'pending', $11)
     RETURNING ${SELECT_COLUMNS}`

export async function insertPendingTaskBudget(
  input: InsertPendingTaskBudgetInput,
  executor: Executor = pool,
): Promise<TaskBudgetRow> {
  const result = await executor.query<TaskBudgetRow>(
    INSERT_PENDING_TASK_BUDGET_SQL,
    [
      input.id,
      input.agentId,
      input.chainId,
      input.tokenAddress,
      input.recipientAddress ? input.recipientAddress.toLowerCase() : null,
      input.parentDelegationHash,
      input.delegationHash,
      input.delegationJson,
      input.label,
      input.maxAtomic,
      input.expiresAt,
    ],
  )
  return result.rows[0]
}

export const FIND_TASK_BUDGET_FOR_AGENT_SQL = `SELECT ${SELECT_COLUMNS} FROM agent_task_budgets WHERE id = $1 AND agent_id = $2`

export async function findForAgent(
  id: string,
  agentId: string,
  executor: Executor = pool,
): Promise<TaskBudgetRow | null> {
  const result = await executor.query<TaskBudgetRow>(FIND_TASK_BUDGET_FOR_AGENT_SQL, [id, agentId])
  return result.rows[0] ?? null
}

/**
 * The ONE open predicate for `agent_task_budgets` (#3919 S-B): an `open`
 * row inside its spend window — what a payment may redeem against, what the
 * owner-facing remainder counts as reserved, what the agent's own open list
 * returns. `nowParam` is a `$n` placeholder the CALLER indexes (the app
 * clock — see the module header), not a value.
 *
 * Unqualified on purpose — every interpolating query here filters
 * `agent_task_budgets` alone; a join that reuses it passes the alias.
 */
export function openTaskBudgetSql(tableAlias: string | undefined, nowParam: string): string {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  return `${prefix}status = 'open' AND ${prefix}expires_at > ${nowParam}`
}

/**
 * Every row an agent can still ACT on (#3518): `pending`, `open` and
 * `closing` rows while not expired. An expired closing row stays out
 * (#3773): `prepareTaskBudgetClose` treats an expired open/closing row as a
 * trivial close (#3329 finding N2(c)) — no close signature can be owed on
 * it, so it is dead work, not live work. Closed rows and expired rows —
 * which nothing ever moves out of 'open' — stay out too, so the read is
 * bounded by live work, not history. `nowParam` is the caller's `$n`
 * placeholder, the same app clock as {@link openTaskBudgetSql}.
 */
export function liveTaskBudgetSql(tableAlias: string | undefined, nowParam: string): string {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  return `${prefix}status IN ('pending', 'open', 'closing') AND ${prefix}expires_at > ${nowParam}`
}

/**
 * The wire `is_live` flag (#3922): {@link liveTaskBudgetSql} evaluated in JS
 * for rows the route already holds (RETURNING rows, enriched reads), against
 * the same app-clock `nowSec` the route uses for `is_expired`. A real-DB test
 * pins JS == SQL on seeded rows, so the two cannot drift.
 */
export function isLiveTaskBudget(
  row: { status: string; expires_at: string | number },
  nowSec: number,
): boolean {
  return (
    (row.status === 'pending' || row.status === 'open' || row.status === 'closing') &&
    Number(row.expires_at) > nowSec
  )
}

export interface ListForAgentOptions {
  /**
   * 'open' = {@link openTaskBudgetSql} (the default the routes use).
   * 'live' (#3518) = {@link liveTaskBudgetSql}.
   */
  status?: 'open' | 'live' | 'all'
  nowSec?: number
}

export async function listForAgent(
  agentId: string,
  options: ListForAgentOptions = {},
  executor: Executor = pool,
): Promise<TaskBudgetRow[]> {
  if (options.status === 'open') {
    const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000)
    const result = await executor.query<TaskBudgetRow>(
      `SELECT ${SELECT_COLUMNS} FROM agent_task_budgets
       WHERE agent_id = $1 AND ${openTaskBudgetSql(undefined, '$2')}
       ORDER BY created_at DESC`,
      [agentId, nowSec],
    )
    return result.rows
  }
  if (options.status === 'live') {
    const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000)
    const result = await executor.query<TaskBudgetRow>(
      `SELECT ${SELECT_COLUMNS} FROM agent_task_budgets
       WHERE agent_id = $1
         AND ${liveTaskBudgetSql(undefined, '$2')}
       ORDER BY created_at DESC`,
      [agentId, nowSec],
    )
    return result.rows
  }
  const result = await executor.query<TaskBudgetRow>(
    `SELECT ${SELECT_COLUMNS} FROM agent_task_budgets WHERE agent_id = $1 ORDER BY created_at DESC`,
    [agentId],
  )
  return result.rows
}

/** Owner-facing read (#3329 §3): joins through `agents.user_id`, scoped both ways. */
export async function listForOwner(
  agentId: string,
  userId: string,
  executor: Executor = pool,
): Promise<TaskBudgetRow[]> {
  const result = await executor.query<TaskBudgetRow>(
    `SELECT tb.id, tb.agent_id, tb.chain_id, tb.token_address, tb.recipient_address,
            tb.parent_delegation_hash, tb.delegation_hash, tb.delegation_json, tb.label,
            tb.max_atomic, tb.status, tb.expires_at, tb.prepared_user_op, tb.close_tx_hash,
            tb.created_at, tb.updated_at, tb.opened_at, tb.closed_at
     FROM agent_task_budgets tb
     JOIN agents a ON a.id = tb.agent_id
     WHERE tb.agent_id = $1 AND a.user_id = $2
     ORDER BY tb.created_at DESC`,
    [agentId, userId],
  )
  return result.rows
}

/**
 * The sum of `max_atomic` across this agent's OPEN, unexpired task budgets
 * carved from ONE parent delegation (owner decision #3329-3: the parent
 * budget's remainder is shown unchanged plus this separate "reserved"
 * figure). `pending` and `closed`/`closing` rows are excluded — a pending
 * child is unsigned and reserves nothing on-chain yet, and a closing/closed
 * child has already given its reservation back.
 */
export const SUM_OPEN_RESERVED_ATOMIC_SQL = `SELECT COALESCE(SUM(max_atomic::numeric), 0)::text AS total
     FROM agent_task_budgets
     WHERE agent_id = $1 AND parent_delegation_hash = $2 AND ${openTaskBudgetSql(undefined, '$3')}`

export async function sumOpenReservedAtomic(
  agentId: string,
  parentDelegationHash: string,
  nowSec: number,
  executor: Executor = pool,
): Promise<bigint> {
  const result = await executor.query<{ total: string | null }>(SUM_OPEN_RESERVED_ATOMIC_SQL, [
    agentId,
    parentDelegationHash,
    nowSec,
  ])
  return BigInt(result.rows[0]?.total ?? '0')
}

export const MARK_TASK_BUDGET_OPEN_SQL = `UPDATE agent_task_budgets
     SET status = 'open', delegation_json = $1, opened_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND agent_id = $3 AND status = 'pending'
     RETURNING ${SELECT_COLUMNS}`

/** Only from 'pending' — the first signature (opening the child) lands here. */
export async function markOpen(
  id: string,
  agentId: string,
  signedDelegationJson: string,
  executor: Executor = pool,
): Promise<TaskBudgetRow | null> {
  const result = await executor.query<TaskBudgetRow>(MARK_TASK_BUDGET_OPEN_SQL, [
    signedDelegationJson,
    id,
    agentId,
  ])
  return result.rows[0] ?? null
}

export const MARK_TASK_BUDGET_CLOSING_SQL = `UPDATE agent_task_budgets
     SET status = 'closing', prepared_user_op = $1, updated_at = NOW()
     WHERE id = $2 AND agent_id = $3 AND status IN ('open', 'closing')
     RETURNING ${SELECT_COLUMNS}`

/**
 * From 'open' (the first prepare) OR 'closing' (#3329 review finding A: a
 * re-prepare that OVERWRITES the stale stored UserOp with a fresh one —
 * the row's own nonce/sponsorship window moved on, so replaying the old
 * bytes is a dead end that `/submit` can only 502 on forever). Either way
 * the row lands 'closing' with the JUST-prepared op as the only stored one.
 */
export async function markClosing(
  id: string,
  agentId: string,
  preparedUserOpJson: string,
  executor: Executor = pool,
): Promise<TaskBudgetRow | null> {
  const result = await executor.query<TaskBudgetRow>(MARK_TASK_BUDGET_CLOSING_SQL, [
    preparedUserOpJson,
    id,
    agentId,
  ])
  return result.rows[0] ?? null
}

export const MARK_TASK_BUDGET_CLOSED_SQL = `UPDATE agent_task_budgets
     SET status = 'closed', close_tx_hash = $1, closed_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND agent_id = $3 AND status IN ('open', 'closing', 'pending')
     RETURNING ${SELECT_COLUMNS}`

/**
 * From 'open' (never signed — early close of a live child), 'closing' (the
 * signed revoke UserOp landed) or 'pending' (never signed at all, nothing
 * on-chain to close — the trivial case). `closeTxHash` is null for the
 * pending/open-without-a-tx paths.
 */
export async function markClosed(
  id: string,
  agentId: string,
  closeTxHash: string | null,
  executor: Executor = pool,
): Promise<TaskBudgetRow | null> {
  const result = await executor.query<TaskBudgetRow>(MARK_TASK_BUDGET_CLOSED_SQL, [
    closeTxHash,
    id,
    agentId,
  ])
  return result.rows[0] ?? null
}

/*
 * The former payment-time storage selector (#3329) is deleted (#3919 S-B):
 * it had NO production caller — the live payment-time decision is
 * `checkTaskBudgetForPayment` (`modules/task-budgets/task-budget-service.ts`),
 * whose liveness half is pinned to {@link openTaskBudgetSql} by a real-DB
 * matrix test. Keeping a second storage-scoped spelling of "open" beside the
 * named predicate is exactly the drift slice B exists to remove.
 */
