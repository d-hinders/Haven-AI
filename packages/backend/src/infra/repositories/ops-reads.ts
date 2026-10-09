/**
 * Ops console data reads (#3512, epic #3507). Convention: `README.md` in this
 * directory — with two deliberate exceptions. These reads are CROSS-TENANT
 * BY DESIGN (the README's rule is per-user scoping): they exist so a founder
 * can look at any customer's account without signing in as them. And the
 * executor is a required argument rather than defaulting to `pool` (the
 * README's rule 2; see the first bullet below).
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
import { delegationLiveWindowSql } from './delegation-budgets.js'

/** Hits per key-type lookup in `/ops/search` (#3512). */
export const OPS_SEARCH_LIMIT = 20
/** Rows per list in `/ops/users/:id` (#3512). */
export const OPS_DETAIL_LIST_LIMIT = 50
/**
 * Rows per page of `/ops/feedback` (#3602). Fits the ops read role's 5 s
 * `statement_timeout` (#3510): one indexed scan of `idx_feedback_user_created_at`
 * with a LIMIT this small answers well inside it.
 */
export const OPS_FEEDBACK_LIST_LIMIT = 50

// ── Feedback (#3602) ─────────────────────────────────────────────────────

/**
 * The last 7 days of `haven feedback submit` rows (#3597), newest first.
 * Every read of the feedback table filters `expires_at > NOW()` (migration
 * 106's discipline), so the page shows only live rows. Explicit projection —
 * the ops role reads exactly the granted columns; masking of `text` and
 * `email` happens in `modules/ops` before any response.
 */
export const OPS_FEEDBACK_LIST_SQL = `SELECT f.id, f.user_id, u.email, f.text, f.created_at, f.expires_at
  FROM feedback f JOIN users u ON u.id = f.user_id
  WHERE f.expires_at > NOW()
  ORDER BY f.created_at DESC
  LIMIT ${OPS_FEEDBACK_LIST_LIMIT}`

export interface OpsFeedbackListRow {
  id: string
  user_id: string
  email: string
  text: string
  created_at: Date
  expires_at: Date
}

export async function readOpsFeedbackList(db: Executor): Promise<OpsFeedbackListRow[]> {
  return (await db.query<OpsFeedbackListRow>(OPS_FEEDBACK_LIST_SQL, [])).rows
}

// ── Overview ────────────────────────────────────────────────────────────

export const OPS_OVERVIEW_USERS_SQL = 'SELECT count(*)::int AS count FROM users'

/** Split by `account_type`, so retired `legacy_safe` rows (085) stay visible apart. */
export const OPS_OVERVIEW_SMART_ACCOUNTS_SQL = `SELECT chain_id, account_type, count(*)::int AS count
  FROM smart_accounts GROUP BY chain_id, account_type ORDER BY chain_id, account_type`

export const OPS_OVERVIEW_AGENTS_SQL = `SELECT status, count(*)::int AS count
  FROM agents GROUP BY status ORDER BY status`

export const OPS_OVERVIEW_ACTIVE_DELEGATIONS_SQL = `SELECT count(*)::int AS count
  FROM agent_delegations WHERE status = 'active'
    AND (${delegationLiveWindowSql()})`

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
  WHERE a.user_id = $1 AND d.status = 'active'
    AND (${delegationLiveWindowSql('d')}) ORDER BY d.expires_at`

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

// ── On-chain view (#3513) ────────────────────────────────────────────────
//
// `GET /ops/users/:id/onchain` needs the user's smart accounts and, per
// account, the ACTIVE stored delegations that reference it — the rows the
// chain view reads against (`delegation_hash` identifies the disabled read,
// `delegation_json` feeds the budget reader by owner decision #3510; neither
// value leaves the module — `modules/ops/onchain.ts` masks and drops them).
// An account row carries NO delegation columns and a delegation row carries
// no account columns beyond the join key, so the ops role reads exactly its
// granted columns on both tables.

export const OPS_ONCHAIN_USER_EXISTS_SQL = 'SELECT id FROM users WHERE id = $1'

/** The user's accounts — the rows the on-chain view buckets and, where readable, reads. */
export const OPS_ONCHAIN_ACCOUNTS_SQL = `SELECT id, chain_id, account_address, account_type, execution_rail, name
  FROM smart_accounts WHERE user_id = $1 ORDER BY chain_id, created_at`

/**
 * The user's ACTIVE stored delegations, joined to the delegator account they
 * are stored under (`agents.account_id` → `smart_accounts.id`). Scoped by
 * USER id — a scalar uuid, like every other ops read — rather than by an
 * account-id array, so the #3510 role self-test can run it with its standard
 * binding.
 */
export const OPS_ONCHAIN_DELEGATIONS_SQL = `SELECT sa.id AS account_id, d.chain_id, d.delegation_hash, d.delegation_json, d.budget_atomic
  FROM agent_delegations d
  JOIN agents ag ON ag.id = d.agent_id
  JOIN smart_accounts sa ON sa.id = ag.account_id
  WHERE sa.user_id = $1 AND d.status = 'active'
    AND (${delegationLiveWindowSql('d')})
  ORDER BY d.delegation_hash`

export interface OpsOnchainAccountRow {
  id: string
  chain_id: number
  account_address: string
  account_type: string
  execution_rail: string
  name: string
}

export interface OpsOnchainDelegationRow {
  account_id: string
  chain_id: number
  delegation_hash: string
  delegation_json: string
  budget_atomic: string
}

export interface OpsOnchainRows {
  accounts: (OpsOnchainAccountRow & { delegations: OpsOnchainDelegationRow[] })[]
}

/**
 * The user's accounts with their ACTIVE stored delegations, or `null` when
 * no user has that id. A user with no accounts returns an empty list. The
 * delegations under one account are sorted by hash (the SQL's ORDER BY) so
 * the module's positional chain view is deterministic.
 */
export async function readOpsOnchainView(db: Executor, userId: string): Promise<OpsOnchainRows | null> {
  const exists = await db.query<{ id: string }>(OPS_ONCHAIN_USER_EXISTS_SQL, [userId])
  if (!exists.rows[0]) return null
  const accounts = (await db.query<OpsOnchainAccountRow>(OPS_ONCHAIN_ACCOUNTS_SQL, [userId])).rows
  if (accounts.length === 0) return { accounts: [] }
  const delegations = (
    await db.query<OpsOnchainDelegationRow>(OPS_ONCHAIN_DELEGATIONS_SQL, [userId])
  ).rows
  const byAccount = new Map<string, OpsOnchainDelegationRow[]>()
  for (const delegation of delegations) {
    const list = byAccount.get(delegation.account_id) ?? []
    list.push(delegation)
    byAccount.set(delegation.account_id, list)
  }
  return {
    accounts: accounts.map((account) => ({
      ...account,
      delegations: (byAccount.get(account.id) ?? []).sort((a, b) =>
        a.delegation_hash.localeCompare(b.delegation_hash),
      ),
    })),
  }
}
