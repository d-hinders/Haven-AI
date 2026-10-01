/**
 * `GET /ops/overview` (#3512, epic #3507): platform-wide counts. Counts only,
 * so nothing here is personal data. Smart accounts are split by
 * `account_type`, so retired `legacy_safe` rows (085) stay visible apart from
 * live `delegator_hybrid` ones.
 */
import type { Executor } from '../../infra/transaction.js'
import { readOpsOverview } from '../../infra/repositories/ops-reads.js'

export interface OpsOverview {
  users: number
  smart_accounts: { chain_id: number; account_type: string; count: number }[]
  agents_by_status: { status: string; count: number }[]
  active_delegations: number
  payment_intents_24h: { status: string; count: number }[]
  payment_refusals_24h: { reason: string; count: number }[]
  generated_at: string
}

export async function buildOpsOverview(db: Executor, now: () => number = Date.now): Promise<OpsOverview> {
  const rows = await readOpsOverview(db)
  return {
    users: rows.users,
    smart_accounts: rows.smartAccounts,
    agents_by_status: rows.agentsByStatus,
    active_delegations: rows.activeDelegations,
    payment_intents_24h: rows.paymentIntents24h,
    payment_refusals_24h: rows.paymentRefusals24h,
    generated_at: new Date(now()).toISOString(),
  }
}
