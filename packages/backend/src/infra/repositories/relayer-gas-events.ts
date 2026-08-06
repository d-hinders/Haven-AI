/**
 * Storage access for `relayer_gas_events` (#717) — the window counts and
 * writes behind the relayer spend guard. Storage only: the budget rules,
 * caps, and failure-direction policy live in `lib/relayer-spend-guard.ts`.
 */

import pool from '../../db.js'

export type RelayerIdentityColumn = 'user_id' | 'agent_id'

/** Rows for one identity + operation inside a trailing window (the cap count). */
export async function countRecentEvents(
  identity: RelayerIdentityColumn,
  identityValue: string,
  operation: string,
  windowMinutes: number,
): Promise<number> {
  // `identity` is a two-value union, never caller input — safe to interpolate.
  const column = identity === 'agent_id' ? 'agent_id' : 'user_id'
  const res = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM relayer_gas_events
     WHERE ${column} = $1 AND operation = $2
       AND created_at > NOW() - ($3 || ' minutes')::interval`,
    [identityValue, operation, String(windowMinutes)],
  )
  return Number(res.rows[0]?.cnt ?? '0')
}

export interface InsertEventInput {
  chainId: number
  operation: string
  agentId?: string | null
  userId?: string | null
  txHash?: string | null
  gasUsed?: string | null
  effectiveGasPrice?: string | null
  costWei?: string | null
}

export async function insertEvent(input: InsertEventInput): Promise<string | null> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO relayer_gas_events
      (chain_id, operation, agent_id, user_id, tx_hash, gas_used, effective_gas_price, cost_wei)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.chainId,
      input.operation,
      input.agentId ?? null,
      input.userId ?? null,
      input.txHash ?? null,
      input.gasUsed ?? null,
      input.effectiveGasPrice ?? null,
      input.costWei ?? null,
    ],
  )
  return res.rows[0]?.id ?? null
}

export async function updateEvent(
  id: string,
  fields: { txHash?: string | null; gasUsed?: string | null; effectiveGasPrice?: string | null; costWei?: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE relayer_gas_events
     SET tx_hash = COALESCE($2, tx_hash),
         gas_used = COALESCE($3, gas_used),
         effective_gas_price = COALESCE($4, effective_gas_price),
         cost_wei = COALESCE($5, cost_wei)
     WHERE id = $1`,
    [id, fields.txHash ?? null, fields.gasUsed ?? null, fields.effectiveGasPrice ?? null, fields.costWei ?? null],
  )
}

export interface SpendSummaryRow {
  chain_id: number
  operation: string
  ops: number
  total_cost_wei: string | null
}

/** Per-chain, per-operation spend over a trailing window — the ops rollup. */
export async function spendSummary(hours: number): Promise<SpendSummaryRow[]> {
  const res = await pool.query<{ chain_id: number; operation: string; ops: string; total_cost_wei: string | null }>(
    `SELECT chain_id, operation, COUNT(*)::text AS ops, SUM(cost_wei)::text AS total_cost_wei
     FROM relayer_gas_events
     WHERE created_at > NOW() - ($1 || ' hours')::interval
     GROUP BY chain_id, operation
     ORDER BY chain_id, operation`,
    [String(hours)],
  )
  return res.rows.map((r) => ({ ...r, ops: Number(r.ops) }))
}
