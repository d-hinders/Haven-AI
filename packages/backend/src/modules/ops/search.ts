/**
 * `GET /ops/search` (#3512, epic #3507): detect what an operator pasted and
 * look it up across the tables that can hold it.
 *
 * - UUID → `users.id`, `agents.id`, `payment_intents.id`.
 * - Address (`0x` + 40 hex) → `smart_accounts.account_address` and
 *   `agents.delegate_address`, the address explorers show most often.
 * - Tx hash (`0x` + 64 hex) → `payment_intents.tx_hash`, and
 *   `outbound_txs.tx_hash` as a typed `system_tx` hit with no user link
 *   (`outbound_txs` has no user or agent column, 061).
 * - Anything else is an email PREFIX, case-insensitive, at least 3 characters.
 *
 * At most `OPS_SEARCH_LIMIT` hits per lookup. The lookups run ONE AFTER
 * ANOTHER under a total time budget, so a request holds at most one of the
 * read-only role's connections (`CONNECTION LIMIT 5`, #3510) at a time. When
 * the budget runs out, or Postgres cancels a statement, the remaining lookups
 * are reported in `timed_out` and the hits found so far are returned. After a
 * lookup times out no further lookup starts, because the abandoned statement
 * may still hold its connection until `statement_timeout` ends it.
 *
 * Emails are masked here; the raw value only ever leaves through
 * `POST /ops/reveal`.
 */
import type { Executor } from '../../infra/transaction.js'
import {
  searchOpsAccountsByAddress,
  searchOpsAgentById,
  searchOpsAgentsByDelegate,
  searchOpsIntentById,
  searchOpsIntentsByTx,
  searchOpsSystemTxsByTx,
  searchOpsUserById,
  searchOpsUsersByEmail,
  type OpsAccountSearchRow,
  type OpsAgentSearchRow,
  type OpsIntentSearchRow,
  type OpsSystemTxSearchRow,
  type OpsUserSearchRow,
} from '../../infra/repositories/ops-reads.js'
import { maskEmail } from './masking.js'

export type OpsSearchKeyType = 'uuid' | 'address' | 'tx_hash' | 'email'

/** The total budget for one search, matching the role's per-statement `statement_timeout` (#3510). */
export const OPS_SEARCH_BUDGET_MS = 5_000
/** Shortest email prefix accepted. */
export const OPS_SEARCH_MIN_EMAIL_PREFIX = 3

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/

/** Postgres `query_canceled`, raised when `statement_timeout` fires. */
const PG_QUERY_CANCELED = '57014'

export type OpsSearchKey = { keyType: OpsSearchKeyType; value: string } | { error: string }

export function detectOpsSearchKey(raw: string): OpsSearchKey {
  const value = raw.trim()
  if (UUID.test(value)) return { keyType: 'uuid', value: value.toLowerCase() }
  if (TX_HASH.test(value)) return { keyType: 'tx_hash', value: value.toLowerCase() }
  if (ADDRESS.test(value)) return { keyType: 'address', value: value.toLowerCase() }
  if (value.length < OPS_SEARCH_MIN_EMAIL_PREFIX) {
    return { error: `An email search needs at least ${OPS_SEARCH_MIN_EMAIL_PREFIX} characters` }
  }
  return { keyType: 'email', value }
}

export type OpsSearchHit =
  | { kind: 'user'; id: string; email: string; created_at: string | null }
  | { kind: 'agent'; id: string; user_id: string; status: string; delegate_address: string | null; created_at: string | null }
  | { kind: 'payment_intent'; id: string; user_id: string; agent_id: string; status: string; chain_id: number; created_at: string | null }
  | { kind: 'smart_account'; id: string; user_id: string; chain_id: number; account_address: string; account_type: string }
  | { kind: 'system_tx'; id: string; chain_id: number; submitter: string; status: string; created_at: string | null }

export type OpsSearchLookup = 'users' | 'agents' | 'payment_intents' | 'smart_accounts' | 'system_txs'

export interface OpsSearchResult {
  key_type: OpsSearchKeyType
  hits: OpsSearchHit[]
  /** Lookups that did not complete within the budget (empty when every lookup ran). */
  timed_out: OpsSearchLookup[]
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null)

const userHit = (r: OpsUserSearchRow): OpsSearchHit => ({
  kind: 'user',
  id: r.id,
  email: maskEmail(r.email),
  created_at: iso(r.created_at),
})
const agentHit = (r: OpsAgentSearchRow): OpsSearchHit => ({
  kind: 'agent',
  id: r.id,
  user_id: r.user_id,
  status: r.status,
  delegate_address: r.delegate_address,
  created_at: iso(r.created_at),
})
const intentHit = (r: OpsIntentSearchRow): OpsSearchHit => ({
  kind: 'payment_intent',
  id: r.id,
  user_id: r.user_id,
  agent_id: r.agent_id,
  status: r.status,
  chain_id: r.chain_id,
  created_at: iso(r.created_at),
})
const accountHit = (r: OpsAccountSearchRow): OpsSearchHit => ({
  kind: 'smart_account',
  id: r.id,
  user_id: r.user_id,
  chain_id: r.chain_id,
  account_address: r.account_address,
  account_type: r.account_type,
})
const systemTxHit = (r: OpsSystemTxSearchRow): OpsSearchHit => ({
  kind: 'system_tx',
  id: r.id,
  chain_id: r.chain_id,
  submitter: r.submitter,
  status: r.status,
  created_at: iso(r.created_at),
})

type Lookup = { name: OpsSearchLookup; run: () => Promise<OpsSearchHit[]> }

function lookupsFor(db: Executor, keyType: OpsSearchKeyType, value: string): Lookup[] {
  switch (keyType) {
    case 'uuid':
      return [
        { name: 'users', run: async () => (await searchOpsUserById(db, value)).map(userHit) },
        { name: 'agents', run: async () => (await searchOpsAgentById(db, value)).map(agentHit) },
        { name: 'payment_intents', run: async () => (await searchOpsIntentById(db, value)).map(intentHit) },
      ]
    case 'address':
      return [
        { name: 'smart_accounts', run: async () => (await searchOpsAccountsByAddress(db, value)).map(accountHit) },
        { name: 'agents', run: async () => (await searchOpsAgentsByDelegate(db, value)).map(agentHit) },
      ]
    case 'tx_hash':
      return [
        { name: 'payment_intents', run: async () => (await searchOpsIntentsByTx(db, value)).map(intentHit) },
        { name: 'system_txs', run: async () => (await searchOpsSystemTxsByTx(db, value)).map(systemTxHit) },
      ]
    case 'email':
      return [{ name: 'users', run: async () => (await searchOpsUsersByEmail(db, value)).map(userHit) }]
  }
}

const TIMED_OUT: unique symbol = Symbol('timed out')

export interface OpsSearchOptions {
  budgetMs?: number
  now?: () => number
}

/** Run every lookup for a detected key, one at a time, inside the budget. */
export async function runOpsSearch(
  db: Executor,
  key: { keyType: OpsSearchKeyType; value: string },
  opts: OpsSearchOptions = {},
): Promise<OpsSearchResult> {
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.budgetMs ?? OPS_SEARCH_BUDGET_MS)
  const lookups = lookupsFor(db, key.keyType, key.value)
  const hits: OpsSearchHit[] = []
  const timedOut: OpsSearchLookup[] = []

  for (let i = 0; i < lookups.length; i++) {
    const remaining = deadline - now()
    if (remaining <= 0) {
      timedOut.push(...lookups.slice(i).map((l) => l.name))
      break
    }
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      lookups[i].run(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), remaining)
      }),
    ])
      .catch((err: unknown): typeof TIMED_OUT => {
        if ((err as { code?: unknown } | null)?.code === PG_QUERY_CANCELED) return TIMED_OUT
        throw err
      })
      .finally(() => clearTimeout(timer))
    if (outcome === TIMED_OUT) {
      timedOut.push(...lookups.slice(i).map((l) => l.name))
      break
    }
    hits.push(...outcome)
  }
  return { key_type: key.keyType, hits, timed_out: timedOut }
}
