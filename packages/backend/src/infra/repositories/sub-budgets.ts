/**
 * Storage for sub-budgets (#3330): the CHILDREN an agent re-delegates to
 * another agent in the same account, as ERC-7710 children of the
 * delegating agent's OWN budget delegation. Every statement is scoped by
 * `agent_id` (and, for the owner-facing list, by the owning `user_id` via a
 * join) — a sub-budget belongs to exactly one agent, the same discipline
 * `agent_task_budgets` (#3329) and `agent_delegations` already keep.
 *
 * See migration 100 for the two-rows-per-tree shape: the delegating agent's
 * self-delegated parent-child row (`parent_sub_budget_id IS NULL`) and the
 * sub-agent's grant row (`parent_sub_budget_id` names it).
 *
 * "Expired" is derived (`expires_at <= now`), never a stored status — see
 * the migration header. Callers needing the wire shape's `is_expired`
 * compute it themselves from `expires_at`.
 */

import pool from '../../db.js'
import { type Executor } from '../transaction.js'

export interface SubBudgetRow {
  id: string
  agent_id: string
  parent_agent_id: string
  parent_sub_budget_id: string | null
  chain_id: number
  token_address: string
  recipient_address: string | null
  parent_delegation_hash: string
  delegation_hash: string
  delegation_json: string
  label: string | null
  period_amount_atomic: string
  status: 'pending' | 'open' | 'closing' | 'closed'
  expires_at: string
  prepared_user_op: string | null
  close_tx_hash: string | null
  created_at: string
  updated_at: string
  opened_at: string | null
  closed_at: string | null
}

const SELECT_COLUMNS = `id, agent_id, parent_agent_id, parent_sub_budget_id, chain_id,
       token_address, recipient_address, parent_delegation_hash, delegation_hash,
       delegation_json, label, period_amount_atomic, status, expires_at, prepared_user_op,
       close_tx_hash, created_at, updated_at, opened_at, closed_at`

export interface InsertPendingSubBudgetInput {
  /**
   * #3329 review finding B's rule carried over: the caller MINTS this id
   * before building the child, because `subBudgetSalt(id)` has to derive
   * from the row's real identity. Explicit `id` column, not the table
   * default.
   */
  id: string
  agentId: string
  parentAgentId: string
  parentSubBudgetId: string | null
  chainId: number
  tokenAddress: string
  recipientAddress: string | null
  parentDelegationHash: string
  delegationHash: string
  delegationJson: string
  label: string | null
  periodAmountAtomic: string
  expiresAt: number
}

export const INSERT_PENDING_SUB_BUDGET_SQL = `INSERT INTO agent_sub_budgets
       (id, agent_id, parent_agent_id, parent_sub_budget_id, chain_id, token_address,
        recipient_address, parent_delegation_hash, delegation_hash, delegation_json,
        label, period_amount_atomic, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, LOWER($6), $7, $8, $9, $10, $11, $12, 'pending', $13)
     RETURNING ${SELECT_COLUMNS}`

export async function insertPendingSubBudget(
  input: InsertPendingSubBudgetInput,
  executor: Executor = pool,
): Promise<SubBudgetRow> {
  const result = await executor.query<SubBudgetRow>(
    INSERT_PENDING_SUB_BUDGET_SQL,
    [
      input.id,
      input.agentId,
      input.parentAgentId,
      input.parentSubBudgetId,
      input.chainId,
      input.tokenAddress,
      input.recipientAddress ? input.recipientAddress.toLowerCase() : null,
      input.parentDelegationHash,
      input.delegationHash,
      input.delegationJson,
      input.label,
      input.periodAmountAtomic,
      input.expiresAt,
    ],
  )
  return result.rows[0]
}

export const FIND_SUB_BUDGET_FOR_AGENT_SQL = `SELECT ${SELECT_COLUMNS} FROM agent_sub_budgets WHERE id = $1 AND agent_id = $2`

export async function findForAgent(
  id: string,
  agentId: string,
  executor: Executor = pool,
): Promise<SubBudgetRow | null> {
  const result = await executor.query<SubBudgetRow>(FIND_SUB_BUDGET_FOR_AGENT_SQL, [id, agentId])
  return result.rows[0] ?? null
}

/**
 * A row the DELEGATING agent (A) is responsible for: its own parent-child
 * row (agent_id = parent_agent_id = A) or a grant it issued to a sub-agent
 * (parent_agent_id = A). A signs and closes BOTH — it is the delegator of
 * every child in its trees — while a sub-agent B can only ever read its own
 * grant row. The submit/close routes scope through THIS, and their
 * signature/prepare steps verify the delegator account, so B cannot sign or
 * close a grant it merely holds.
 */
export const FIND_SUB_BUDGET_FOR_DELEGATING_AGENT_SQL = `SELECT ${SELECT_COLUMNS} FROM agent_sub_budgets
     WHERE id = $1 AND parent_agent_id = $2`

export async function findForDelegatingAgent(
  id: string,
  parentAgentId: string,
  executor: Executor = pool,
): Promise<SubBudgetRow | null> {
  const result = await executor.query<SubBudgetRow>(FIND_SUB_BUDGET_FOR_DELEGATING_AGENT_SQL, [
    id,
    parentAgentId,
  ])
  return result.rows[0] ?? null
}

/** Single row related to this agent in EITHER direction (holder or delegator). */
export const FIND_RELATED_SUB_BUDGET_SQL = `SELECT ${SELECT_COLUMNS} FROM agent_sub_budgets
     WHERE id = $1 AND (agent_id = $2 OR parent_agent_id = $2)`

export async function findRelatedForAgent(
  id: string,
  agentId: string,
  executor: Executor = pool,
): Promise<SubBudgetRow | null> {
  const result = await executor.query<SubBudgetRow>(FIND_RELATED_SUB_BUDGET_SQL, [id, agentId])
  return result.rows[0] ?? null
}

/**
 * Rows related to this agent in either direction: its own children
 * (agent_id = me) plus the grants it delegated (parent_agent_id = me). One
 * list, self-describing rows — `agent_id === parent_agent_id` marks a
 * parent-child row.
 */
export const LIST_RELATED_FOR_AGENT_SQL = `SELECT ${SELECT_COLUMNS} FROM agent_sub_budgets
     WHERE agent_id = $1 OR parent_agent_id = $1
     ORDER BY created_at DESC`

export async function listRelatedForAgent(
  agentId: string,
  executor: Executor = pool,
): Promise<SubBudgetRow[]> {
  const result = await executor.query<SubBudgetRow>(LIST_RELATED_FOR_AGENT_SQL, [agentId])
  return result.rows
}

export interface ListForAgentOptions {
  /** 'open' = status open AND not expired (the default the routes use). */
  status?: 'open' | 'all'
  nowSec?: number
}

export async function listForAgent(
  agentId: string,
  options: ListForAgentOptions = {},
  executor: Executor = pool,
): Promise<SubBudgetRow[]> {
  if (options.status === 'open') {
    const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000)
    const result = await executor.query<SubBudgetRow>(
      `SELECT ${SELECT_COLUMNS} FROM agent_sub_budgets
       WHERE agent_id = $1 AND status = 'open' AND expires_at > $2
       ORDER BY created_at DESC`,
      [agentId, nowSec],
    )
    return result.rows
  }
  const result = await executor.query<SubBudgetRow>(
    `SELECT ${SELECT_COLUMNS} FROM agent_sub_budgets WHERE agent_id = $1 ORDER BY created_at DESC`,
    [agentId],
  )
  return result.rows
}

/** Owner-facing read (#3330): joins through `agents.user_id`, scoped both ways. */
export async function listForOwner(
  agentId: string,
  userId: string,
  executor: Executor = pool,
): Promise<SubBudgetRow[]> {
  const result = await executor.query<SubBudgetRow>(
    `SELECT sb.id, sb.agent_id, sb.parent_agent_id, sb.parent_sub_budget_id, sb.chain_id,
            sb.token_address, sb.recipient_address, sb.parent_delegation_hash,
            sb.delegation_hash, sb.delegation_json, sb.label, sb.period_amount_atomic, sb.status,
            sb.expires_at, sb.prepared_user_op, sb.close_tx_hash,
            sb.created_at, sb.updated_at, sb.opened_at, sb.closed_at
     FROM agent_sub_budgets sb
     JOIN agents a ON a.id = sb.agent_id
     WHERE sb.agent_id = $1 AND a.user_id = $2
     ORDER BY sb.created_at DESC`,
    [agentId, userId],
  )
  return result.rows
}

/**
 * The tree an owner reads for one delegating agent (#3330: "the dashboard
 * shows the parent→child tree"): A's own parent-child rows PLUS every
 * sub-agent grant whose `parent_sub_budget_id` points at one of them —
 * one round trip, both scoped through `agents.user_id`.
 */
export async function listTreeForOwner(
  agentId: string,
  userId: string,
  executor: Executor = pool,
): Promise<SubBudgetRow[]> {
  const result = await executor.query<SubBudgetRow>(
    `SELECT sb.id, sb.agent_id, sb.parent_agent_id, sb.parent_sub_budget_id, sb.chain_id,
            sb.token_address, sb.recipient_address, sb.parent_delegation_hash,
            sb.delegation_hash, sb.delegation_json, sb.label, sb.period_amount_atomic, sb.status,
            sb.expires_at, sb.prepared_user_op, sb.close_tx_hash,
            sb.created_at, sb.updated_at, sb.opened_at, sb.closed_at
     FROM agent_sub_budgets sb
     JOIN agents issuer ON issuer.id = sb.agent_id
     JOIN agents parent ON parent.id = sb.parent_agent_id
     WHERE issuer.user_id = $2
       AND (sb.agent_id = $1
            OR sb.parent_sub_budget_id IN (
              SELECT child.id FROM agent_sub_budgets child
              WHERE child.agent_id = $1 AND child.parent_sub_budget_id IS NULL
            ))
     ORDER BY sb.created_at DESC`,
    [agentId, userId],
  )
  return result.rows
}

export const MARK_SUB_BUDGET_OPEN_SQL = `UPDATE agent_sub_budgets
     SET status = 'open', delegation_json = $1, opened_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND parent_agent_id = $3 AND status = 'pending'
     RETURNING ${SELECT_COLUMNS}`

/**
 * Only from 'pending' — the DELEGATING agent's signature (opening the child)
 * lands here. Delegator scope (`parent_agent_id`), not holder scope: A signs
 * and opens BOTH rows of its tree, including the grant whose holder is B —
 * the grant is authority A gives, and only A's delegate key may open it.
 */
export async function markOpen(
  id: string,
  agentId: string,
  signedDelegationJson: string,
  executor: Executor = pool,
): Promise<SubBudgetRow | null> {
  const result = await executor.query<SubBudgetRow>(MARK_SUB_BUDGET_OPEN_SQL, [
    signedDelegationJson,
    id,
    agentId,
  ])
  return result.rows[0] ?? null
}

export const MARK_SUB_BUDGET_CLOSING_SQL = `UPDATE agent_sub_budgets
     SET status = 'closing', prepared_user_op = $1, updated_at = NOW()
     WHERE id = $2 AND parent_agent_id = $3 AND status IN ('open', 'closing')
     RETURNING ${SELECT_COLUMNS}`

/**
 * From 'open' (the first prepare) OR 'closing' (re-prepare overwriting a
 * stale stored UserOp — #3329 review finding A's rule: idempotent in
 * EFFECT, never in bytes). Either way the row lands 'closing' with the
 * JUST-prepared op as the only stored one. Delegator scope — only A can
 * start closing any row of its tree.
 */
export async function markClosing(
  id: string,
  agentId: string,
  preparedUserOpJson: string,
  executor: Executor = pool,
): Promise<SubBudgetRow | null> {
  const result = await executor.query<SubBudgetRow>(MARK_SUB_BUDGET_CLOSING_SQL, [
    preparedUserOpJson,
    id,
    agentId,
  ])
  return result.rows[0] ?? null
}

export const MARK_SUB_BUDGET_CLOSED_SQL = `UPDATE agent_sub_budgets
     SET status = 'closed', close_tx_hash = $1, closed_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND parent_agent_id = $3 AND status IN ('open', 'closing', 'pending')
     RETURNING ${SELECT_COLUMNS}`

/**
 * From 'open' (never signed — early close of a live child), 'closing' (the
 * signed revoke UserOp landed) or 'pending' (never signed at all, nothing
 * on-chain to close — the trivial case). `closeTxHash` is null for the
 * pending/open-without-a-tx paths. Delegator scope — only A closes any row
 * of its tree.
 */
export async function markClosed(
  id: string,
  agentId: string,
  closeTxHash: string | null,
  executor: Executor = pool,
): Promise<SubBudgetRow | null> {
  const result = await executor.query<SubBudgetRow>(MARK_SUB_BUDGET_CLOSED_SQL, [
    closeTxHash,
    id,
    agentId,
  ])
  return result.rows[0] ?? null
}

export const SELECT_OPEN_SUB_BUDGET_FOR_PAYMENT_SQL = `SELECT ${SELECT_COLUMNS} FROM agent_sub_budgets
     WHERE id = $1 AND agent_id = $2 AND token_address = LOWER($3)
       AND status = 'open' AND expires_at > $4`

/**
 * The grant row a payment may redeem against: OPEN, unexpired, and matching
 * the token being spent. Recipient pin and parent-status checks are the
 * caller's (`modules/sub-budgets/sub-budget-service.ts`) — this is the
 * storage-scoped read only.
 */
export async function selectOpenForPayment(
  id: string,
  agentId: string,
  tokenAddress: string,
  nowSec: number,
  executor: Executor = pool,
): Promise<SubBudgetRow | null> {
  const result = await executor.query<SubBudgetRow>(SELECT_OPEN_SUB_BUDGET_FOR_PAYMENT_SQL, [
    id,
    agentId,
    tokenAddress,
    nowSec,
  ])
  return result.rows[0] ?? null
}

/**
 * The OPEN, unexpired parent-child row a grant names — read at payment time
 * to prove the chain's middle link is still live (#3330: revoking A's
 * budget delegation — or A's own parent-child row being closed — makes B's
 * child unredeemable; this read is the storage half, the chain half is the
 * enforcers).
 */
export const SELECT_OPEN_PARENT_CHILD_SQL = `SELECT ${SELECT_COLUMNS} FROM agent_sub_budgets
     WHERE delegation_hash = $1 AND parent_sub_budget_id IS NULL
       AND status = 'open' AND expires_at > $2`

export async function findOpenParentChildByHash(
  delegationHash: string,
  nowSec: number,
  executor: Executor = pool,
): Promise<SubBudgetRow | null> {
  const result = await executor.query<SubBudgetRow>(SELECT_OPEN_PARENT_CHILD_SQL, [
    delegationHash,
    nowSec,
  ])
  return result.rows[0] ?? null
}

/**
 * The effective spend a sub-agent's OPEN grants reserve from the
 * delegating parent-child: the sum of `period_amount_atomic` across B's rows carved
 * from ONE parent-child delegation. Mirrors
 * `sumOpenReservedAtomic` (#3329) one level down the tree — the owner
 * route uses it for the pre-sign refusal when the narrowed children would
 * over-commit A's budget slice.
 */
export const SUM_OPEN_RESERVED_FOR_PARENT_SQL = `SELECT COALESCE(SUM(grant_.period_amount_atomic::numeric), 0)::text AS total
     FROM agent_sub_budgets grant_
     JOIN agent_sub_budgets parent_child
       ON parent_child.id = grant_.parent_sub_budget_id
     WHERE parent_child.agent_id = $1
       AND parent_child.parent_sub_budget_id IS NULL
       AND parent_child.delegation_hash = $2
       AND grant_.status = 'open' AND grant_.expires_at > $3`

export async function sumOpenReservedForParent(
  parentAgentId: string,
  parentChildDelegationHash: string,
  nowSec: number,
  executor: Executor = pool,
): Promise<bigint> {
  const result = await executor.query<{ total: string | null }>(SUM_OPEN_RESERVED_FOR_PARENT_SQL, [
    parentAgentId,
    parentChildDelegationHash,
    nowSec,
  ])
  return BigInt(result.rows[0]?.total ?? '0')
}
