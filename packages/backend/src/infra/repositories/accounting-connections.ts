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
  await db.query(SET_ACCOUNTING_STATUS_SQL, [userId, provider, status, reason])
}

export async function setActiveDestination(userId: string, provider: string, db: Executor = pool): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query(CLEAR_ACTIVE_DESTINATION_SQL, [userId])
    await tx.query(SET_ACTIVE_DESTINATION_SQL, [userId, provider])
  })
}

export async function disconnect(
  userId: string,
  provider: string,
  reason: string | null,
  db: Executor = pool,
): Promise<void> {
  await db.query(DISCONNECT_ACCOUNTING_CONNECTION_SQL, [userId, provider, reason])
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
