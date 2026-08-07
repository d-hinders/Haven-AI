/**
 * Data access for the delegate balance monitor (#714, moved behind the
 * repository boundary by #999).
 *
 * Both reads are deliberately NOT tenant-scoped: the monitor is a READ-ONLY
 * platform sweep across every active agent's hot delegate EOA — the x402
 * flow's in-flight window sits outside every policy layer until the merchant
 * settles or the sweep recovers it, and this is the DETECT mitigation.
 * Convention otherwise: `README.md` in this directory.
 *
 * These queries live here rather than in `agents.ts` / `payment-intents.ts`
 * on purpose: a guard test pins every `user_safes` JOIN in `agents.ts` to
 * select `account_type` because that file's queries feed agent API payloads
 * (#1069/#1071); the monitor returns no payload and would trip the pin.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export const LIST_MONITORED_DELEGATES_SQL = `SELECT a.id AS agent_id, a.name AS agent_name,
            a.delegate_address, us.chain_id
     FROM agents a
     JOIN user_safes us ON us.id = a.safe_id
     WHERE a.status = 'active' AND a.delegate_address IS NOT NULL`

export interface MonitoredDelegateRow {
  agent_id: string
  agent_name: string
  delegate_address: string
  chain_id: number
}

/** Active agents with a delegate, joined to their Safe's chain. */
export async function listMonitoredDelegates(db: Executor = pool): Promise<MonitoredDelegateRow[]> {
  const result = await db.query<MonitoredDelegateRow>(LIST_MONITORED_DELEGATES_SQL)
  return result.rows
}

export const LIST_AGENTS_WITH_FRESH_PENDING_INTENTS_SQL = `SELECT DISTINCT agent_id FROM payment_intents
     WHERE agent_id = ANY($1)
       AND status IN ('pending_signature', 'submitted')
       AND created_at > NOW() - ($2 || ' minutes')::interval`

/**
 * Agent ids (from the caller-provided candidate set) with a payment intent
 * fresh enough to explain a funded delegate.
 */
export async function listAgentIdsWithFreshPendingIntents(
  agentIds: string[],
  windowMinutes: string,
  db: Executor = pool,
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set()
  const result = await db.query<{ agent_id: string }>(LIST_AGENTS_WITH_FRESH_PENDING_INTENTS_SQL, [
    agentIds,
    windowMinutes,
  ])
  return new Set(result.rows.map((r) => r.agent_id))
}
