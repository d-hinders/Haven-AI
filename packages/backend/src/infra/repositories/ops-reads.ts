/**
 * Ops console data reads (#3512, epic #3507). Convention: `README.md` in this
 * directory — with one deliberate exception, stated here because the README's
 * rule is per-user scoping: these reads are CROSS-TENANT BY DESIGN. They
 * exist so a founder can look at any customer's account without signing in
 * as them.
 *
 * Three rules make that safe, and every function below keeps them:
 * - **The executor is a required argument, never defaulted to the main
 *   pool.** Callers pass the read-only ops role (#3510); a function with a
 *   `db = pool` default would silently read with full privileges.
 * - **Every statement is an explicit column projection** over columns the
 *   ops role is granted (`infra/ops-readonly-role.ts`), never `*`. A column
 *   the role cannot read fails the query rather than leaking.
 * - **Nothing here writes.** The `ops_access_log` row is written by the route
 *   through the main pool (`ops-access-log.ts`).
 *
 * Personal fields (`users.email`, `users.name`) are returned raw from here and
 * masked by `modules/ops` before any response; the unmasked value only ever
 * leaves through `POST /ops/reveal`.
 */
import type { Executor } from '../transaction.js'

/** Hits per key-type lookup in `/ops/search` (#3512). */
export const OPS_SEARCH_LIMIT = 20
/** Rows per list in `/ops/users/:id` (#3512). */
export const OPS_DETAIL_LIST_LIMIT = 50

// ── Overview ────────────────────────────────────────────────────────────

export const OPS_OVERVIEW_USERS_SQL = 'SELECT count(*)::int AS count FROM users'

/** Split by `account_type`, so retired `legacy_safe` rows (085) stay visible apart. */
export const OPS_OVERVIEW_SMART_ACCOUNTS_SQL = `SELECT chain_id, account_type, count(*)::int AS count
  FROM smart_accounts GROUP BY chain_id, account_type ORDER BY chain_id, account_type`

export const OPS_OVERVIEW_AGENTS_SQL = `SELECT status, count(*)::int AS count
  FROM agents GROUP BY status ORDER BY status`

export const OPS_OVERVIEW_ACTIVE_DELEGATIONS_SQL = `SELECT count(*)::int AS count
  FROM agent_delegations WHERE status = 'active'`

export const OPS_OVERVIEW_INTENTS_24H_SQL = `SELECT status, count(*)::int AS count
  FROM payment_intents WHERE created_at > NOW() - INTERVAL '24 hours'
  GROUP BY status ORDER BY status`

export const OPS_OVERVIEW_REFUSALS_24H_SQL = `SELECT reason, count(*)::int AS count
  FROM payment_refusals WHERE created_at > NOW() - INTERVAL '24 hours'
  GROUP BY reason ORDER BY reason`

export interface OpsOverviewRows {
  users: number
  smartAccounts: { chain_id: number; account_type: string; count: number }[]
  agentsByStatus: { status: string; count: number }[]
  activeDelegations: number
  paymentIntents24h: { status: string; count: number }[]
  paymentRefusals24h: { reason: string; count: number }[]
}

/** The overview counts, one statement after another on the given executor. */
export async function readOpsOverview(db: Executor): Promise<OpsOverviewRows> {
  const users = await db.query<{ count: number }>(OPS_OVERVIEW_USERS_SQL)
  const smartAccounts = await db.query<OpsOverviewRows['smartAccounts'][number]>(OPS_OVERVIEW_SMART_ACCOUNTS_SQL)
  const agents = await db.query<OpsOverviewRows['agentsByStatus'][number]>(OPS_OVERVIEW_AGENTS_SQL)
  const delegations = await db.query<{ count: number }>(OPS_OVERVIEW_ACTIVE_DELEGATIONS_SQL)
  const intents = await db.query<OpsOverviewRows['paymentIntents24h'][number]>(OPS_OVERVIEW_INTENTS_24H_SQL)
  const refusals = await db.query<OpsOverviewRows['paymentRefusals24h'][number]>(OPS_OVERVIEW_REFUSALS_24H_SQL)
  return {
    users: users.rows[0]?.count ?? 0,
    smartAccounts: smartAccounts.rows,
    agentsByStatus: agents.rows,
    activeDelegations: delegations.rows[0]?.count ?? 0,
    paymentIntents24h: intents.rows,
    paymentRefusals24h: refusals.rows,
  }
}

// ── Search ──────────────────────────────────────────────────────────────

/** Case-insensitive email PREFIX; `$1` is the escaped prefix (see `escapeLikePrefix`). */
export const OPS_SEARCH_USERS_BY_EMAIL_SQL = `SELECT id, email, created_at FROM users
  WHERE lower(email) LIKE $1 ESCAPE '\\' ORDER BY email LIMIT ${OPS_SEARCH_LIMIT}`

export const OPS_SEARCH_USER_BY_ID_SQL = `SELECT id, email, created_at FROM users WHERE id = $1 LIMIT ${OPS_SEARCH_LIMIT}`

export const OPS_SEARCH_AGENT_BY_ID_SQL = `SELECT id, user_id, status, delegate_address, created_at FROM agents
  WHERE id = $1 LIMIT ${OPS_SEARCH_LIMIT}`

export const OPS_SEARCH_INTENT_BY_ID_SQL = `SELECT id, user_id, agent_id, status, chain_id, created_at FROM payment_intents
  WHERE id = $1 LIMIT ${OPS_SEARCH_LIMIT}`

export const OPS_SEARCH_ACCOUNTS_BY_ADDRESS_SQL = `SELECT id, user_id, chain_id, account_address, account_type FROM smart_accounts
  WHERE lower(account_address) = $1 ORDER BY chain_id LIMIT ${OPS_SEARCH_LIMIT}`

export const OPS_SEARCH_AGENTS_BY_DELEGATE_SQL = `SELECT id, user_id, status, delegate_address, created_at FROM agents
  WHERE lower(delegate_address) = $1 ORDER BY created_at DESC LIMIT ${OPS_SEARCH_LIMIT}`

export const OPS_SEARCH_INTENTS_BY_TX_SQL = `SELECT id, user_id, agent_id, status, chain_id, created_at FROM payment_intents
  WHERE lower(tx_hash) = $1 ORDER BY created_at DESC LIMIT ${OPS_SEARCH_LIMIT}`

/** `outbound_txs` (061) has no user or agent column: a hit is a typed system transaction. */
export const OPS_SEARCH_SYSTEM_TXS_BY_TX_SQL = `SELECT id, chain_id, submitter, status, created_at FROM outbound_txs
  WHERE lower(tx_hash) = $1 ORDER BY created_at DESC LIMIT ${OPS_SEARCH_LIMIT}`

/** A lowercased LIKE prefix with `%`, `_` and `\` escaped, ending in `%`. */
export function escapeLikePrefix(prefix: string): string {
  return `${prefix.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

export interface OpsUserSearchRow {
  id: string
  email: string
  created_at: Date
}
export interface OpsAgentSearchRow {
  id: string
  user_id: string
  status: string
  delegate_address: string | null
  created_at: Date | null
}
export interface OpsIntentSearchRow {
  id: string
  user_id: string
  agent_id: string
  status: string
  chain_id: number
  created_at: Date | null
}
export interface OpsAccountSearchRow {
  id: string
  user_id: string
  chain_id: number
  account_address: string
  account_type: string
}
export interface OpsSystemTxSearchRow {
  id: string
  chain_id: number
  submitter: string
  status: string
  created_at: Date
}

export async function searchOpsUsersByEmail(db: Executor, prefix: string): Promise<OpsUserSearchRow[]> {
  return (await db.query<OpsUserSearchRow>(OPS_SEARCH_USERS_BY_EMAIL_SQL, [escapeLikePrefix(prefix)])).rows
}
export async function searchOpsUserById(db: Executor, id: string): Promise<OpsUserSearchRow[]> {
  return (await db.query<OpsUserSearchRow>(OPS_SEARCH_USER_BY_ID_SQL, [id])).rows
}
export async function searchOpsAgentById(db: Executor, id: string): Promise<OpsAgentSearchRow[]> {
  return (await db.query<OpsAgentSearchRow>(OPS_SEARCH_AGENT_BY_ID_SQL, [id])).rows
}
export async function searchOpsIntentById(db: Executor, id: string): Promise<OpsIntentSearchRow[]> {
  return (await db.query<OpsIntentSearchRow>(OPS_SEARCH_INTENT_BY_ID_SQL, [id])).rows
}
export async function searchOpsAccountsByAddress(db: Executor, address: string): Promise<OpsAccountSearchRow[]> {
  return (await db.query<OpsAccountSearchRow>(OPS_SEARCH_ACCOUNTS_BY_ADDRESS_SQL, [address.toLowerCase()])).rows
}
export async function searchOpsAgentsByDelegate(db: Executor, address: string): Promise<OpsAgentSearchRow[]> {
  return (await db.query<OpsAgentSearchRow>(OPS_SEARCH_AGENTS_BY_DELEGATE_SQL, [address.toLowerCase()])).rows
}
export async function searchOpsIntentsByTx(db: Executor, txHash: string): Promise<OpsIntentSearchRow[]> {
  return (await db.query<OpsIntentSearchRow>(OPS_SEARCH_INTENTS_BY_TX_SQL, [txHash.toLowerCase()])).rows
}
export async function searchOpsSystemTxsByTx(db: Executor, txHash: string): Promise<OpsSystemTxSearchRow[]> {
  return (await db.query<OpsSystemTxSearchRow>(OPS_SEARCH_SYSTEM_TXS_BY_TX_SQL, [txHash.toLowerCase()])).rows
}

// ── Customer detail ─────────────────────────────────────────────────────

export const OPS_USER_SQL = 'SELECT id, email, name, created_at FROM users WHERE id = $1'

export const OPS_USER_ACCOUNTS_SQL = `SELECT id, chain_id, account_address, account_type, execution_rail, name, created_at
  FROM smart_accounts WHERE user_id = $1 ORDER BY chain_id, created_at`

export const OPS_USER_AGENTS_SQL = `SELECT id, account_id, name, status, delegate_address, created_at, archived_at
  FROM agents WHERE user_id = $1 ORDER BY created_at DESC`

/** Active delegations of the user's agents: budget shape, recipient pin, window. */
export const OPS_USER_DELEGATIONS_SQL = `SELECT d.id, d.agent_id, d.chain_id, d.token_address, d.recipient_address,
    d.merchant_id, d.budget_atomic, d.period_seconds, d.start_date, d.expires_at
  FROM agent_delegations d JOIN agents a ON a.id = d.agent_id
  WHERE a.user_id = $1 AND d.status = 'active' ORDER BY d.expires_at`

export const OPS_USER_INTENTS_SQL = `SELECT id, agent_id, status, chain_id, token_symbol, amount_human, to_address,
    error_message, created_at
  FROM payment_intents WHERE user_id = $1 ORDER BY created_at DESC NULLS LAST LIMIT ${OPS_DETAIL_LIST_LIMIT}`

export const OPS_USER_REFUSALS_SQL = `SELECT id, agent_id, chain_id, token_symbol, amount_atomic, reason, source, created_at
  FROM payment_refusals WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${OPS_DETAIL_LIST_LIMIT}`

export interface OpsUserDetailRows {
  user: { id: string; email: string; name: string | null; created_at: Date | null }
  accounts: {
    id: string
    chain_id: number
    account_address: string
    account_type: string
    execution_rail: string
    name: string
    created_at: Date | null
  }[]
  agents: {
    id: string
    account_id: string | null
    name: string
    status: string
    delegate_address: string | null
    created_at: Date | null
    archived_at: Date | null
  }[]
  delegations: {
    id: string
    agent_id: string
    chain_id: number
    token_address: string
    recipient_address: string | null
    merchant_id: string | null
    budget_atomic: string
    period_seconds: number
    start_date: string
    expires_at: string
  }[]
  intents: {
    id: string
    agent_id: string
    status: string
    chain_id: number
    token_symbol: string
    amount_human: string
    to_address: string
    error_message: string | null
    created_at: Date | null
  }[]
  refusals: {
    id: string
    agent_id: string
    chain_id: number
    token_symbol: string
    amount_atomic: string
    reason: string
    source: string
    created_at: Date
  }[]
}

/** One customer's record, or `null` when no user has that id. */
export async function readOpsUserDetail(db: Executor, userId: string): Promise<OpsUserDetailRows | null> {
  const user = await db.query<OpsUserDetailRows['user']>(OPS_USER_SQL, [userId])
  if (!user.rows[0]) return null
  const accounts = await db.query<OpsUserDetailRows['accounts'][number]>(OPS_USER_ACCOUNTS_SQL, [userId])
  const agents = await db.query<OpsUserDetailRows['agents'][number]>(OPS_USER_AGENTS_SQL, [userId])
  const delegations = await db.query<OpsUserDetailRows['delegations'][number]>(OPS_USER_DELEGATIONS_SQL, [userId])
  const intents = await db.query<OpsUserDetailRows['intents'][number]>(OPS_USER_INTENTS_SQL, [userId])
  const refusals = await db.query<OpsUserDetailRows['refusals'][number]>(OPS_USER_REFUSALS_SQL, [userId])
  return {
    user: user.rows[0],
    accounts: accounts.rows,
    agents: agents.rows,
    delegations: delegations.rows,
    intents: intents.rows,
    refusals: refusals.rows,
  }
}
