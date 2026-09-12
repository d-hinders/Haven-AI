/**
 * Data access for a user's accounting-platform connections (#2860, epic
 * #2858). Replaces `fortnox-connections.ts`.
 *
 * One aggregate: `accounting_connections` — one row per (user, provider), any
 * provider, exactly one row per user flagged as the active feed destination
 * (enforced by a partial unique index, not by this file). Secrets are a
 * ciphertext blob plus a key version; this file never sees a plaintext token
 * and never touches the key — `infra/secrets.ts` does both. Convention:
 * `README.md` in this directory.
 *
 * ## `disconnected` is a state, not a deletion
 *
 * Owner decision 2026-09-11: disconnect keeps history. `disconnect()` clears
 * the secrets and sets `status = 'disconnected'`; the row stays because sync
 * history references the connection, and a later reconnect reuses it.
 * `deleteConnection` exists for the one case that genuinely removes the
 * aggregate (an account deletion cascades anyway) and for tests.
 *
 * ## Why `setActiveDestination` is two statements in a transaction
 *
 * "Exactly one active" is a partial unique index on `(user_id) WHERE
 * is_active_destination`. A first draft did it as ONE statement — an UPDATE
 * with `is_active_destination = (provider = $2)` — on the belief that Postgres
 * checks the constraint once at the end. It does not: a unique INDEX is
 * checked per row as the UPDATE proceeds, and a partial index cannot be made
 * DEFERRABLE (only a constraint can), so whether it trips depended on which
 * row the planner touched first. Measured on the real database: it tripped.
 *
 * Clear-all then set-one, inside a transaction, is the correct shape. The
 * intermediate state — zero active rows — is one the index permits; it forbids
 * two, never none.
 */

import pool from '../../db.js'
import { withTransaction, type Executor } from '../transaction.js'

export type { Executor }

export type ConnectionStatus =
  | 'connected'
  | 'needs_reauthorisation'
  | 'revoked_at_provider'
  | 'scope_missing'
  | 'disconnected'

export type AuthKind = 'oauth2' | 'api_key'

/** The row as stored. `secrets_ciphertext` is opaque here — decrypt via infra/secrets. */
export interface AccountingConnectionRow {
  id: string
  user_id: string
  provider: string
  auth_kind: AuthKind
  secrets_ciphertext: Buffer | null
  secrets_key_version: number
  external_company_id: string | null
  external_company_name: string | null
  base_currency: string | null
  status: ConnectionStatus
  status_reason: string | null
  granted_scope: string | null
  /** pg returns TIMESTAMPTZ as a Date; the type is honest about that. */
  token_expires_at: Date | null
  is_active_destination: boolean
  feed_from: Date | null
  settings: Record<string, unknown>
  last_push_at: Date | null
  last_error: string | null
  created_at: Date
  updated_at: Date
}

const COLUMNS = `id, user_id, provider, auth_kind, secrets_ciphertext, secrets_key_version,
       external_company_id, external_company_name, base_currency, status, status_reason,
       granted_scope, token_expires_at, is_active_destination, feed_from, settings,
       last_push_at, last_error, created_at, updated_at`

export const GET_ACCOUNTING_CONNECTION_SQL = `SELECT ${COLUMNS}
     FROM accounting_connections WHERE user_id = $1 AND provider = $2`

export const GET_ACTIVE_ACCOUNTING_CONNECTION_SQL = `SELECT ${COLUMNS}
     FROM accounting_connections
     WHERE user_id = $1 AND is_active_destination AND status = 'connected'`

export const LIST_ACCOUNTING_CONNECTIONS_SQL = `SELECT ${COLUMNS}
     FROM accounting_connections WHERE user_id = $1 ORDER BY created_at`

/**
 * Connect or reconnect. On conflict the row is REUSED: secrets, scope, expiry
 * and status are replaced, while `settings` and `feed_from` are preserved — a
 * re-consent must not lose what the user configured (#2865's contract,
 * honoured from the start).
 *
 * The active flag on the conflict path is "keep it if you had it, take it if
 * nobody has it". A first draft preserved the flag unconditionally, and that
 * left a real hole: disconnect clears the flag, a reconnect then hit the
 * conflict path and kept `false`, and the user ended with a connected row and
 * ZERO active destinations (haven-reviewer reproduced it via
 * DELETE /accounting/fortnox → connect). A later provider still does not
 * steal an existing destination — the OR only fires when no OTHER row holds
 * the flag.
 */
export const UPSERT_ACCOUNTING_CONNECTION_SQL = `INSERT INTO accounting_connections
       (user_id, provider, auth_kind, secrets_ciphertext, secrets_key_version,
        granted_scope, token_expires_at, status, status_reason, is_active_destination, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'connected', NULL,
             NOT EXISTS (SELECT 1 FROM accounting_connections WHERE user_id = $1 AND is_active_destination),
             NOW())
     ON CONFLICT (user_id, provider) DO UPDATE SET
       auth_kind = EXCLUDED.auth_kind,
       secrets_ciphertext = EXCLUDED.secrets_ciphertext,
       secrets_key_version = EXCLUDED.secrets_key_version,
       granted_scope = EXCLUDED.granted_scope,
       token_expires_at = EXCLUDED.token_expires_at,
       status = 'connected',
       status_reason = NULL,
       last_error = NULL,
       is_active_destination = accounting_connections.is_active_destination
         OR NOT EXISTS (SELECT 1 FROM accounting_connections o
                        WHERE o.user_id = EXCLUDED.user_id AND o.is_active_destination
                          AND o.provider <> EXCLUDED.provider),
       updated_at = NOW()
     RETURNING ${COLUMNS}`

/** Token refresh / re-encrypt: secrets and expiry only, nothing else moves. */
export const UPDATE_ACCOUNTING_SECRETS_SQL = `UPDATE accounting_connections
     SET secrets_ciphertext = $3, secrets_key_version = $4, token_expires_at = $5, updated_at = NOW()
     WHERE user_id = $1 AND provider = $2`

export const SET_ACCOUNTING_STATUS_SQL = `UPDATE accounting_connections
     SET status = $3, status_reason = $4, updated_at = NOW()
     WHERE user_id = $1 AND provider = $2`

/** Step 1 of `setActiveDestination`: no row active. The index permits zero. */
export const CLEAR_ACTIVE_DESTINATION_SQL = `UPDATE accounting_connections
     SET is_active_destination = false, updated_at = NOW()
     WHERE user_id = $1 AND is_active_destination`

/** Step 2: exactly this row active. */
export const SET_ACTIVE_DESTINATION_SQL = `UPDATE accounting_connections
     SET is_active_destination = true, updated_at = NOW()
     WHERE user_id = $1 AND provider = $2`

/** Disconnect keeps the row: secrets gone, status recorded, history intact. */
export const DISCONNECT_ACCOUNTING_CONNECTION_SQL = `UPDATE accounting_connections
     SET secrets_ciphertext = NULL, secrets_key_version = 0, status = 'disconnected',
         status_reason = $3, is_active_destination = false, updated_at = NOW()
     WHERE user_id = $1 AND provider = $2`

/**
 * #2862: the feed-from rule. Activating a destination stamps `feed_from` so
 * the next sync feeds nothing settled before the switch — switching
 * destination never re-feeds history into the new ledger. Runs as the third
 * statement of `setActiveDestination`'s transaction; the clear-then-set pair
 * above is untouched.
 */
export const SET_FEED_FROM_SQL = `UPDATE accounting_connections
     SET feed_from = $3, updated_at = NOW()
     WHERE user_id = $1 AND provider = $2`

/**
 * #2862 (review on #2894): a connect that takes the active flag because no
 * other destination held it is an activation too, so it carries the feed-from
 * floor. Only a row with NO floor yet — a migrated pre-#2862 Fortnox row keeps
 * its NULL (it fed everything) and a reconnect keeps whatever it had.
 */
export const STAMP_FEED_FROM_IF_UNSET_SQL = `UPDATE accounting_connections
     SET feed_from = $3, updated_at = NOW()
     WHERE user_id = $1 AND provider = $2 AND is_active_destination AND feed_from IS NULL
     RETURNING *`

/** #2862: what the provider said about the company at connect time. */
/**
 * A null id/name (a scope-refused read) never erases a known one: otherwise a
 * scope-refused reconnect followed by a reconnect to a different company
 * would not be detected as a switch (review on #2898).
 */
export const SET_COMPANY_INFO_SQL = `UPDATE accounting_connections
     SET external_company_id = COALESCE($3, external_company_id),
         external_company_name = COALESCE($4, external_company_name),
         base_currency = COALESCE($5, base_currency),
         updated_at = NOW()
     WHERE user_id = $1 AND provider = $2`

/**
 * #2864: a reconnect that came back with a DIFFERENT `external_company_id`
 * is a company switch. One row, one statement: the company fields are
 * replaced, `feed_from` moves to the switch time (nothing settled before it
 * is fed into the new company — the same rule as activate), `status_reason`
 * names the switch for the dashboard, and the switch is appended to
 * `settings.companySwitches` — the row's JSONB column, so no migration and
 * no overloaded text column. That log is what attributes a `pushed` sync row
 * to a company: `accounting_feed_syncs` has no company column, so a row is
 * attributed by its `created_at` against the switch times (see
 * `companySwitchLog` and `reopenPushedPayment` in the accounting module).
 * `$6` is the switch entry as JSON text; the concatenation is append-only.
 */
export const RECORD_COMPANY_SWITCH_SQL = `UPDATE accounting_connections
     SET external_company_id = $3, external_company_name = $4, base_currency = $5,
         feed_from = ($6::jsonb ->> 'at')::timestamptz,
         status_reason = $7,
         settings = jsonb_set(settings, '{companySwitches}',
                              COALESCE(settings -> 'companySwitches', '[]'::jsonb) || jsonb_build_array($6::jsonb)),
         updated_at = NOW()
     WHERE user_id = $1 AND provider = $2
     RETURNING ${COLUMNS}`

/**
 * #2867: the per-connection user settings, written as a JSONB MERGE on the
 * SQL side (`settings || $3`) — never read-modify-write — so the other keys
 * the column carries (`companySwitches` from #2864, `backfill` below) are
 * preserved by construction and two writers cannot lose each other's key.
 * `$3` is the patch as JSON text; a key set to JSON null reads back as
 * "unset" (`connectionSettings`).
 */
export const MERGE_CONNECTION_SETTINGS_SQL = `UPDATE accounting_connections
     SET settings = settings || $3::jsonb, updated_at = NOW()
     WHERE user_id = $1 AND provider = $2
     RETURNING ${COLUMNS}`

/**
 * #2867: the backfill choice. The ONE statement that ever moves `feed_from`
 * EARLIER — activate (#2862) and a company switch (#2864) only ever move it
 * forward. The guard is in the WHERE, not in the caller — including the
 * active + connected predicate, so a concurrent activate/disconnect between
 * the caller's read and this statement cannot move an inactive row's floor
 * (review on #2901): a `since` at or after the current floor updates zero
 * rows (the caller then reads the row to tell "no row" from "not earlier"
 * from "not active"), and a NULL floor — a pre-#2862 row
 * that already feeds everything — has nothing earlier to move to and is
 * refused the same way. The choice is recorded under `settings.backfill`
 * (`{ since, requestedAt }`) through the same append-safe merge as the
 * settings write. `$3` is the new floor, `$4` the backfill entry as JSON text.
 *
 * MUTATION TARGET (backfill-and-settings.db.test.ts "a LATER since is
 * refused"): dropping `feed_from > $3` lets a backfill move the floor
 * forward, which is the activate path's job and would hide history the
 * user never asked to hide.
 */
export const RECORD_BACKFILL_SQL = `UPDATE accounting_connections
     SET feed_from = $3,
         settings = settings || jsonb_build_object('backfill', $4::jsonb),
         updated_at = NOW()
     WHERE user_id = $1 AND provider = $2
       AND is_active_destination AND status = 'connected'
       AND feed_from IS NOT NULL AND feed_from > $3::timestamptz
     RETURNING ${COLUMNS}`

/**
 * #2863: the per-connection refresh lock. A provider refresh token is
 * single-use (Fortnox rotates it on every refresh), so two workers refreshing
 * the same row at once — the settlement hook and a "Sync now" click — burn
 * each other's token and lock the connection out. `FOR UPDATE` on the row
 * inside a transaction serialises them: the second waits, then re-reads a row
 * the first has already rotated and uses that token without a provider call.
 * The row itself is the lock (no key hashing, and every write to the row —
 * `updateSecrets`, `setStatus` — queues behind it by construction); the
 * transaction spans the provider call, which is the point.
 */
export const LOCK_ACCOUNTING_CONNECTION_SQL = `SELECT ${COLUMNS}
     FROM accounting_connections WHERE user_id = $1 AND provider = $2 FOR UPDATE`

export const DELETE_ACCOUNTING_CONNECTION_SQL = `DELETE FROM accounting_connections
     WHERE user_id = $1 AND provider = $2`

/** Rows still stored as plaintext — the boot-time re-encrypt job's worklist. */
export const LIST_PLAINTEXT_CONNECTIONS_SQL = `SELECT ${COLUMNS}
     FROM accounting_connections WHERE secrets_key_version = 0 AND secrets_ciphertext IS NOT NULL`

/**
 * The re-encrypt job's write: a COMPARE-AND-SWAP on the key version. Only a
 * row that is STILL at version 0 is touched. A refresh committed by a serving
 * replica between the worklist read and this write has already rotated the
 * secrets to version 1 — writing the job's stale copy over it would put a
 * dead refresh token back (haven-reviewer reproduced this, #2887). Zero rows
 * updated means "someone else moved it", which the job counts, not retries.
 */
export const REENCRYPT_PLAINTEXT_SECRETS_SQL = `UPDATE accounting_connections
     SET secrets_ciphertext = $3, secrets_key_version = $4, updated_at = NOW()
     WHERE user_id = $1 AND provider = $2 AND secrets_key_version = 0`

export async function getConnection(
  userId: string,
  provider: string,
  db: Executor = pool,
): Promise<AccountingConnectionRow | null> {
  const r = await db.query<AccountingConnectionRow>(GET_ACCOUNTING_CONNECTION_SQL, [userId, provider])
  return r.rows[0] ?? null
}

export async function getActiveConnection(
  userId: string,
  db: Executor = pool,
): Promise<AccountingConnectionRow | null> {
  const r = await db.query<AccountingConnectionRow>(GET_ACTIVE_ACCOUNTING_CONNECTION_SQL, [userId])
  return r.rows[0] ?? null
}

export async function listConnections(userId: string, db: Executor = pool): Promise<AccountingConnectionRow[]> {
  const r = await db.query<AccountingConnectionRow>(LIST_ACCOUNTING_CONNECTIONS_SQL, [userId])
  return r.rows
}

export async function upsertConnection(
  userId: string,
  input: {
    provider: string
    authKind: AuthKind
    secretsCiphertext: Buffer
    secretsKeyVersion: number
    grantedScope: string | null
    /** Absolute expiry — pg serializes the Date. Null for api_key providers. */
    tokenExpiresAt: Date | null
  },
  db: Executor = pool,
): Promise<AccountingConnectionRow> {
  const r = await db.query<AccountingConnectionRow>(UPSERT_ACCOUNTING_CONNECTION_SQL, [
    userId,
    input.provider,
    input.authKind,
    input.secretsCiphertext,
    input.secretsKeyVersion,
    input.grantedScope,
    input.tokenExpiresAt,
  ])
  return r.rows[0]
}

export async function updateSecrets(
  userId: string,
  provider: string,
  input: { secretsCiphertext: Buffer; secretsKeyVersion: number; tokenExpiresAt: Date | null },
  db: Executor = pool,
): Promise<void> {
  await db.query(UPDATE_ACCOUNTING_SECRETS_SQL, [
    userId,
    provider,
    input.secretsCiphertext,
    input.secretsKeyVersion,
    input.tokenExpiresAt,
  ])
}

export async function setStatus(
  userId: string,
  provider: string,
  status: ConnectionStatus,
  reason: string | null,
  db: Executor = pool,
): Promise<void> {
  // Bounded like the sync ledger's error column (review on #2900): a provider
  // message must not grow the row without limit; the parseable prefix is at
  // the front, so a slice never loses the scope list.
  await db.query(SET_ACCOUNTING_STATUS_SQL, [userId, provider, status, reason === null ? null : reason.slice(0, 1000)])
}

/**
 * Clear-then-set in one transaction (see the header). `feedFrom` (#2862) is
 * stamped in the same transaction when given, so "this row is active" and
 * "feed from here" can never be observed apart.
 */
export async function setActiveDestination(
  userId: string,
  provider: string,
  opts: { feedFrom?: Date } = {},
  db: Executor = pool,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query(CLEAR_ACTIVE_DESTINATION_SQL, [userId])
    await tx.query(SET_ACTIVE_DESTINATION_SQL, [userId, provider])
    if (opts.feedFrom) await tx.query(SET_FEED_FROM_SQL, [userId, provider, opts.feedFrom])
  })
}

/** See `STAMP_FEED_FROM_IF_UNSET_SQL`. Returns the row when it stamped, null when nothing qualified. */
export async function stampFeedFromIfUnset(
  userId: string,
  provider: string,
  at: Date,
  db: Executor = pool,
): Promise<AccountingConnectionRow | null> {
  const result = await db.query<AccountingConnectionRow>(STAMP_FEED_FROM_IF_UNSET_SQL, [userId, provider, at])
  return result.rows[0] ?? null
}

export async function setCompanyInfo(
  userId: string,
  provider: string,
  info: { externalCompanyId: string | null; name: string | null; baseCurrency: string | null },
  db: Executor = pool,
): Promise<void> {
  await db.query(SET_COMPANY_INFO_SQL, [userId, provider, info.externalCompanyId, info.name, info.baseCurrency])
}

/** One entry of `settings.companySwitches` (#2864). `at` is the ISO switch time — the new `feed_from`. */
export interface CompanySwitchEntry {
  at: string
  fromCompanyId: string
  fromCompanyName: string | null
  toCompanyId: string
  toCompanyName: string | null
}

/**
 * Which company the connection pointed at when `at` happened: the `toCompanyId`
 * of the last switch at or before `at`, else the `fromCompanyId` of the first
 * switch after it, else the row's current id (no switch ever). Walks the whole
 * log, so a round trip A → B → A attributes an A-era row to A (review on
 * #2898), not to whichever company the latest entry names.
 */
export function companyIdAt(row: Pick<AccountingConnectionRow, 'settings' | 'external_company_id'>, at: Date): string | null {
  const log = companySwitchLog(row)
  const t = at.getTime()
  let current: string | null = null
  for (const entry of log) {
    if (new Date(entry.at).getTime() <= t) current = entry.toCompanyId
    else return current ?? entry.fromCompanyId
  }
  return current ?? row.external_company_id
}

/** The append-only switch log on a row, oldest first; empty when the row never switched company. */
export function companySwitchLog(row: Pick<AccountingConnectionRow, 'settings'>): CompanySwitchEntry[] {
  const raw = (row.settings as { companySwitches?: unknown } | null)?.companySwitches
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (e): e is CompanySwitchEntry =>
      typeof e === 'object' && e !== null && typeof (e as CompanySwitchEntry).at === 'string' && typeof (e as CompanySwitchEntry).toCompanyId === 'string',
  )
}

/** See `RECORD_COMPANY_SWITCH_SQL`. Returns the row after the switch, or null when there is no row. */
export async function recordCompanySwitch(
  userId: string,
  provider: string,
  input: {
    from: { externalCompanyId: string; name: string | null }
    to: { externalCompanyId: string; name: string | null; baseCurrency: string | null }
    at: Date
    reason: string
  },
  db: Executor = pool,
): Promise<AccountingConnectionRow | null> {
  const entry: CompanySwitchEntry = {
    at: input.at.toISOString(),
    fromCompanyId: input.from.externalCompanyId,
    fromCompanyName: input.from.name,
    toCompanyId: input.to.externalCompanyId,
    toCompanyName: input.to.name,
  }
  const r = await db.query<AccountingConnectionRow>(RECORD_COMPANY_SWITCH_SQL, [
    userId,
    provider,
    input.to.externalCompanyId,
    input.to.name,
    input.to.baseCurrency,
    JSON.stringify(entry),
    input.reason,
  ])
  return r.rows[0] ?? null
}

/** The user-facing settings on a row (#2867) — the `settings` keys the PATCH route owns, read with their defaults. */
export interface ConnectionSettings {
  /** A hint for the accountant, surfaced only as the connector's non-asserting hint field. Null = none. */
  suggestedAccount: string | null
  /** False = the settlement hook and the retry sweep leave this user alone; manual sync and backfill still push. Default true. */
  autoFeed: boolean
}

/** The stored key names — the wire contract of `PATCH /accounting/connections/:provider/settings`. */
export const SETTINGS_KEY_SUGGESTED_ACCOUNT = 'suggested_account'
export const SETTINGS_KEY_AUTO_FEED = 'auto_feed'

export function connectionSettings(row: Pick<AccountingConnectionRow, 'settings'>): ConnectionSettings {
  const raw = (row.settings ?? {}) as Record<string, unknown>
  const account = raw[SETTINGS_KEY_SUGGESTED_ACCOUNT]
  const auto = raw[SETTINGS_KEY_AUTO_FEED]
  return {
    suggestedAccount: typeof account === 'string' && account.length > 0 ? account : null,
    autoFeed: auto !== false,
  }
}

/** The recorded backfill choice on a row (#2867), or null when the user never chose one. */
export interface BackfillEntry {
  since: string
  requestedAt: string
}

export function backfillChoice(row: Pick<AccountingConnectionRow, 'settings'>): BackfillEntry | null {
  const raw = (row.settings as { backfill?: unknown } | null)?.backfill
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Partial<BackfillEntry>
  return typeof e.since === 'string' && typeof e.requestedAt === 'string' ? { since: e.since, requestedAt: e.requestedAt } : null
}

/**
 * See `MERGE_CONNECTION_SETTINGS_SQL`. `patch` holds only the keys to change,
 * already validated by the caller (`connections.ts`); a null value stores a
 * JSON null, which reads back as unset. Returns the row after the merge, or
 * null when there is no row.
 */
export async function mergeSettings(
  userId: string,
  provider: string,
  patch: Record<string, unknown>,
  db: Executor = pool,
): Promise<AccountingConnectionRow | null> {
  const r = await db.query<AccountingConnectionRow>(MERGE_CONNECTION_SETTINGS_SQL, [userId, provider, JSON.stringify(patch)])
  return r.rows[0] ?? null
}

/**
 * See `RECORD_BACKFILL_SQL`. Returns the row with its new floor, or null when
 * nothing qualified — no row, no floor, or `since` not earlier than the floor;
 * the caller tells those apart with a read.
 */
export async function recordBackfill(
  userId: string,
  provider: string,
  input: { since: Date; requestedAt: Date },
  db: Executor = pool,
): Promise<AccountingConnectionRow | null> {
  const entry: BackfillEntry = { since: input.since.toISOString(), requestedAt: input.requestedAt.toISOString() }
  const r = await db.query<AccountingConnectionRow>(RECORD_BACKFILL_SQL, [userId, provider, input.since, JSON.stringify(entry)])
  return r.rows[0] ?? null
}

export async function disconnect(
  userId: string,
  provider: string,
  reason: string | null,
  db: Executor = pool,
): Promise<void> {
  await db.query(DISCONNECT_ACCOUNTING_CONNECTION_SQL, [userId, provider, reason])
}

/**
 * Run `fn` with the (user, provider) row locked for the duration (see
 * `LOCK_ACCOUNTING_CONNECTION_SQL`). `fn` receives the row as it is AFTER the
 * lock is granted — a concurrent writer's committed changes included — and
 * the transaction executor, so its writes commit with the lock. `fn` gets
 * null when there is no row; the lock then guards nothing and `fn` should
 * simply answer. Through an executor that cannot hand out a connection (a
 * test's query stub) the statement runs inline, unlocked — the real-DB tests
 * are where the lock is proven.
 */
export async function withLockedConnection<T>(
  userId: string,
  provider: string,
  fn: (row: AccountingConnectionRow | null, tx: Executor) => Promise<T>,
  db: Executor = pool,
): Promise<T> {
  return withTransaction(db, async (tx) => {
    const r = await tx.query<AccountingConnectionRow>(LOCK_ACCOUNTING_CONNECTION_SQL, [userId, provider])
    return fn(r.rows[0] ?? null, tx)
  })
}

export async function deleteConnection(userId: string, provider: string, db: Executor = pool): Promise<void> {
  await db.query(DELETE_ACCOUNTING_CONNECTION_SQL, [userId, provider])
}

/** Returns true if the row was still plaintext and is now encrypted; false if it had moved. */
export async function reencryptIfStillPlaintext(
  userId: string,
  provider: string,
  input: { secretsCiphertext: Buffer; secretsKeyVersion: number },
  db: Executor = pool,
): Promise<boolean> {
  const r = await db.query(REENCRYPT_PLAINTEXT_SECRETS_SQL, [userId, provider, input.secretsCiphertext, input.secretsKeyVersion])
  return (r.rowCount ?? 0) === 1
}

export async function listPlaintextConnections(db: Executor = pool): Promise<AccountingConnectionRow[]> {
  const r = await db.query<AccountingConnectionRow>(LIST_PLAINTEXT_CONNECTIONS_SQL)
  return r.rows
}
