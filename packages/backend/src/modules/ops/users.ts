/**
 * `GET /ops/users/:id` (#3512, epic #3507): one customer's record, as the
 * founders need it for support. The user's email and name are masked; the
 * unmasked values leave only through `POST /ops/reveal`.
 *
 * Deliberately NOT returned in v1: `owner_company_details` (the ops role is
 * not granted it), `payment_intents.machine_metadata` (it can carry resource
 * URLs and challenge payloads), and every hash, signature and delegation body.
 * `payment_intents.error_message` is returned: it is written through
 * `redactVendorSecrets` (`routes/payments.ts`). Guardrail refusals (budget,
 * recipient pin, expiry, relayer budget, on-chain revert) are
 * `payment_refusals` rows, listed separately.
 */
import type { Executor } from '../../infra/transaction.js'
import { readOpsUserDetail } from '../../infra/repositories/ops-reads.js'
import { maskEmail, maskName } from './masking.js'

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null)

export interface OpsUserDetail {
  user: { id: string; email: string; name: string | null; created_at: string | null }
  smart_accounts: {
    id: string
    chain_id: number
    account_address: string
    account_type: string
    execution_rail: string
    name: string
    created_at: string | null
  }[]
  agents: {
    id: string
    account_id: string | null
    name: string
    status: string
    delegate_address: string | null
    created_at: string | null
    archived_at: string | null
  }[]
  active_delegations: {
    id: string
    agent_id: string
    chain_id: number
    token_address: string
    recipient_address: string | null
    merchant_id: string | null
    budget_atomic: string
    period_seconds: number
    start_date: number
    expires_at: number
  }[]
  payment_intents: {
    id: string
    agent_id: string
    status: string
    chain_id: number
    token_symbol: string
    amount_human: string
    to_address: string
    error_message: string | null
    created_at: string | null
  }[]
  payment_refusals: {
    id: string
    agent_id: string
    chain_id: number
    token_symbol: string
    amount_atomic: string
    reason: string
    source: string
    created_at: string | null
  }[]
}

/** The masked customer record, or `null` when no user has that id. */
export async function buildOpsUserDetail(db: Executor, userId: string): Promise<OpsUserDetail | null> {
  const rows = await readOpsUserDetail(db, userId)
  if (!rows) return null
  return {
    user: {
      id: rows.user.id,
      email: maskEmail(rows.user.email),
      name: rows.user.name === null ? null : maskName(rows.user.name),
      created_at: iso(rows.user.created_at),
    },
    smart_accounts: rows.accounts.map((a) => ({ ...a, created_at: iso(a.created_at) })),
    agents: rows.agents.map((a) => ({ ...a, created_at: iso(a.created_at), archived_at: iso(a.archived_at) })),
    active_delegations: rows.delegations.map((d) => ({
      ...d,
      start_date: Number(d.start_date),
      expires_at: Number(d.expires_at),
    })),
    payment_intents: rows.intents.map((p) => ({ ...p, created_at: iso(p.created_at) })),
    payment_refusals: rows.refusals.map((r) => ({ ...r, created_at: iso(r.created_at) })),
  }
}
