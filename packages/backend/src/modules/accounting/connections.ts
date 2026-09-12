/**
 * Provider-generic connection service (#2862, epic #2858) — what the
 * `routes/accounting-connections.ts` handlers and the feed routes call.
 *
 * Joins the three things a connection involves: the DESCRIPTOR
 * (`registry.ts` — is it live, how does it authenticate, what can it do), the
 * CONNECTOR instance (`connector.ts` — the code that talks to the provider)
 * and the ROW (`infra/repositories/accounting-connections.ts` — the grant,
 * encrypted). Routes never see a ciphertext or a token: everything they get
 * back goes through `toConnectionSummary`, which carries metadata only.
 *
 * ## Activate sets `feed_from = now`
 *
 * The epic's feed-from rule (review, 2026-09-11): switching the active
 * destination must never re-feed history into the new ledger. `activate`
 * stamps `feed_from` in the same transaction as the flag, and the
 * orchestrator feeds nothing settled before it. A user who WANTS history
 * chooses a backfill (#2867, `backfillConnection` below) — the ONE path that
 * moves `feed_from` earlier.
 *
 * ## Per-connection settings (#2867)
 *
 * Two user knobs live in the row's `settings` JSONB, next to #2864's
 * `companySwitches` log and the `backfill` record: `suggested_account` (a
 * hint for the accountant, surfaced only through the connector's
 * non-asserting hint field) and `auto_feed` (false = the settlement hook and
 * the retry sweep leave the user alone; Sync now and the backfill still
 * push). `updateConnectionSettings` validates the patch key by key and
 * merges it on the SQL side. Supplier strategy is NOT a setting — one
 * supplier per merchant, fixed (owner decision).
 */

import {
  SETTINGS_KEY_AUTO_FEED,
  SETTINGS_KEY_SUGGESTED_ACCOUNT,
  companyIdAt,
  connectionSettings,
  disconnect as disconnectRow,
  getActiveConnection,
  getConnection,
  listConnections,
  mergeSettings,
  recordBackfill,
  setActiveDestination,
  type AccountingConnectionRow,
  type ConnectionSettings,
  type ConnectionStatus,
} from '../../infra/repositories/accounting-connections.js'
import { flagConnectionStatus } from './ops-signals.js'
import { decryptSecrets } from '../../infra/secrets.js'
import { connectWithApiKey } from './api-key-flow.js'
import { companySwitchLog } from './company-info.js'
import { getConnector, type AccountingVerification, type ProviderSecrets } from './connector.js'
import { syncUser } from './feed-orchestrator.js'
import { getSyncState, reopenMissingPushed } from './feed-sync.js'
import { fortnoxConfigured, fortnoxCredentials } from './fortnox-connection.js'
import { fortnoxOAuth2Config } from './fortnox.js'
import { buildAuthorizeUrl, completeOAuth2Connect, type OAuth2ProviderConfig } from './oauth-flow.js'
import { missingScopesFor, type AccountingProvider } from './provider.js'
import { assertConnectable, connectorFor, getProvider, listProviders, ProviderNotConnectableError } from './registry.js'

/** Safe metadata about one connection — never secrets. The wire shape. */
export interface ConnectionSummary {
  provider: string
  displayName: string
  authKind: 'oauth2' | 'api_key'
  status: ConnectionStatus
  statusReason: string | null
  isActiveDestination: boolean
  feedFrom: string | null
  grantedScope: string | null
  /**
   * #2865: the descriptor's scopes the grant does not carry — from
   * `granted_scope` against `requiredScopes`, plus the scopes a push-time
   * refusal named in `status_reason` while the row is `scope_missing`. Empty
   * when nothing is missing. What the dashboard shows next to "Reconnect".
   */
  missingScopes: string[]
  tokenExpiresAt: string | null
  /** #2864: the provider's own tenant id (Fortnox: `DatabaseNumber`); null until a grant with the scope read it. */
  externalCompanyId: string | null
  externalCompanyName: string | null
  baseCurrency: string | null
  lastPushAt: string | null
  lastError: string | null
  connectedAt: string
  updatedAt: string
  /** #2867: the user's settings, with defaults applied. */
  settings: ConnectionSettings
}

const iso = (d: Date | string | null): string | null => (d == null ? null : new Date(d).toISOString())

export function toConnectionSummary(row: AccountingConnectionRow): ConnectionSummary {
  return {
    provider: row.provider,
    displayName: getProvider(row.provider)?.displayName ?? row.provider,
    authKind: row.auth_kind,
    status: row.status,
    statusReason: row.status_reason,
    isActiveDestination: row.is_active_destination,
    feedFrom: iso(row.feed_from),
    grantedScope: row.granted_scope,
    missingScopes: missingScopesFor(row, getProvider(row.provider)),
    tokenExpiresAt: iso(row.token_expires_at),
    externalCompanyId: row.external_company_id,
    externalCompanyName: row.external_company_name,
    baseCurrency: row.base_currency,
    lastPushAt: iso(row.last_push_at),
    lastError: row.last_error,
    connectedAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    settings: connectionSettings(row),
  }
}

/** Descriptor plus whether THIS deployment can connect it (a connector is registered). */
export interface ProviderListing extends AccountingProvider {
  configured: boolean
}

export function listProviderListings(): ProviderListing[] {
  return listProviders().map((p) => ({ ...p, configured: getConnector(p.id) !== undefined }))
}

export async function listConnectionSummaries(userId: string): Promise<ConnectionSummary[]> {
  return (await listConnections(userId)).map(toConnectionSummary)
}

/** Whether the user has a connected, active feed destination. */
export async function hasActiveConnection(userId: string): Promise<boolean> {
  return (await getActiveConnection(userId)) !== null
}

/**
 * The active destination as the wire summary, or null — what
 * `GET /accounting/feed/status` reads so the UI can say
 * "Connected to <Company AB>" (#2864).
 */
export async function getActiveConnectionSummary(userId: string): Promise<ConnectionSummary | null> {
  const row = await getActiveConnection(userId)
  return row ? toConnectionSummary(row) : null
}

/**
 * The row flagged as the destination WHATEVER its status, or null — so
 * `GET /accounting/feed/status` can name the `missingScopes` of a
 * `scope_missing` destination (#2865), which `getActiveConnectionSummary`
 * (connected rows only) cannot see.
 */
export async function getDestinationSummary(userId: string): Promise<ConnectionSummary | null> {
  const row = (await listConnections(userId)).find((r) => r.is_active_destination)
  return row ? toConnectionSummary(row) : null
}

// ── OAuth2 ───────────────────────────────────────────────────────────────────

/**
 * The per-deployment OAuth2 parameters for a provider, or null when it is not
 * configured here. Fortnox is the one live OAuth2 provider; a second one adds
 * a case, and the routes stay untouched.
 */
export function oauth2ConfigFor(providerId: string): OAuth2ProviderConfig | null {
  if (providerId === 'fortnox') return fortnoxConfigured() ? fortnoxOAuth2Config(fortnoxCredentials()) : null
  return null
}

/**
 * The consent URL for a live OAuth2 provider, given an already-signed state.
 * Throws `ProviderNotConnectableError` for a provider that may not connect.
 */
export function connectUrlFor(providerId: string, state: string): string {
  const { provider } = assertConnectable(providerId, 'oauth2')
  const cfg = oauth2ConfigFor(provider.id)
  if (!cfg) {
    throw new ProviderNotConnectableError('PROVIDER_NOT_CONFIGURED', `${provider.displayName} is not configured on this deployment.`)
  }
  return buildAuthorizeUrl(cfg, state)
}

/** The callback's work after the state is verified and consumed. */
export async function completeProviderOAuthCallback(
  providerId: string,
  userId: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionSummary> {
  const { provider, connector } = assertConnectable(providerId, 'oauth2')
  const cfg = oauth2ConfigFor(provider.id)
  if (!cfg) {
    throw new ProviderNotConnectableError('PROVIDER_NOT_CONFIGURED', `${provider.displayName} is not configured on this deployment.`)
  }
  const row = await completeOAuth2Connect({ provider, cfg, connector, userId, code, fetchImpl })
  return toConnectionSummary(row)
}

// ── API key ──────────────────────────────────────────────────────────────────

export async function connectProviderWithApiKey(
  providerId: string,
  userId: string,
  apiKey: string,
): Promise<ConnectionSummary> {
  const { provider, connector } = assertConnectable(providerId, 'api_key')
  const row = await connectWithApiKey({ provider, connector, userId, apiKey })
  return toConnectionSummary(row)
}

// ── Disconnect / activate ────────────────────────────────────────────────────

function decryptConnectionSecrets(row: AccountingConnectionRow): ProviderSecrets | null {
  if (!row.secrets_ciphertext) return null
  return decryptSecrets<ProviderSecrets>(row.secrets_ciphertext, row.secrets_key_version)
}

/**
 * Disconnect keeps the row (owner decision: history stays) and clears the
 * secrets. When the descriptor declares `capabilities.revoke`, the grant is
 * revoked at the provider FIRST, with the secrets still in hand; a revoke
 * failure is reported, never a reason to keep the secrets stored.
 */
export async function disconnectProvider(
  userId: string,
  providerId: string,
): Promise<{ existed: boolean; revoked: boolean; revokeError: string | null }> {
  const row = await getConnection(userId, providerId)
  if (!row) return { existed: false, revoked: false, revokeError: null }

  let revoked = false
  let revokeError: string | null = null
  const pair = connectorFor(providerId)
  if (pair?.provider.capabilities.revoke && row.status !== 'disconnected') {
    const secrets = decryptConnectionSecrets(row)
    if (secrets) {
      try {
        await pair.connector.revoke(secrets)
        revoked = true
      } catch (err) {
        revokeError = err instanceof Error ? err.name : 'Error'
      }
    }
  }
  await disconnectRow(userId, providerId, revoked ? 'user disconnected (grant revoked at provider)' : 'user disconnected')
  return { existed: true, revoked, revokeError }
}

export class ConnectionNotActivatableError extends Error {
  readonly code: 'NOT_FOUND' | 'NOT_CONNECTED'
  constructor(code: ConnectionNotActivatableError['code'], message: string) {
    super(message)
    this.name = 'ConnectionNotActivatableError'
    this.code = code
  }
}

/**
 * Make `providerId` the active feed destination. `feedFrom` defaults to NOW —
 * the feed-from rule; #2867's backfill passes an earlier date explicitly.
 * Mutation-tested on the real database: dropping the timestamp makes the
 * next sync feed history it must not.
 */
export async function activateProvider(
  userId: string,
  providerId: string,
  opts: { feedFrom?: Date } = {},
): Promise<ConnectionSummary> {
  const row = await getConnection(userId, providerId)
  if (!row) throw new ConnectionNotActivatableError('NOT_FOUND', `No ${getProvider(providerId)?.displayName ?? providerId} connection to activate.`)
  if (row.status !== 'connected') {
    throw new ConnectionNotActivatableError(
      'NOT_CONNECTED',
      `The ${getProvider(providerId)?.displayName ?? providerId} connection is ${row.status.replace(/_/g, ' ')} — reconnect it before making it the destination.`,
    )
  }
  await setActiveDestination(userId, providerId, { feedFrom: opts.feedFrom ?? new Date() })
  const updated = await getConnection(userId, providerId)
  return toConnectionSummary(updated ?? row)
}

/** Record a post-push finding about the grant (see `PushResult.connectionStatus`). */
export async function degradeConnection(
  userId: string,
  providerId: string,
  status: ConnectionStatus,
  reason: string | null,
): Promise<void> {
  await flagConnectionStatus(userId, providerId, status, reason)
}

// ── Backfill (#2867) ─────────────────────────────────────────────────────────

/**
 * The earliest `since` a backfill accepts. Haven has no settled payments
 * before it; a date earlier than this is a typo, not a choice.
 */
export const BACKFILL_FLOOR = new Date('2020-01-01T00:00:00.000Z')

export class BackfillRefusedError extends Error {
  readonly code: 'NOT_FOUND' | 'NOT_ACTIVE' | 'SINCE_INVALID' | 'SINCE_NOT_EARLIER'
  constructor(code: BackfillRefusedError['code'], message: string) {
    super(message)
    this.name = 'BackfillRefusedError'
    this.code = code
  }
}

/**
 * `since` as the user sent it → a Date, or a refusal: it must parse as an
 * ISO date, be in the past, and not precede `BACKFILL_FLOOR`.
 */
export function parseBackfillSince(since: unknown, now: Date = new Date()): Date {
  const invalid = (message: string) => new BackfillRefusedError('SINCE_INVALID', message)
  if (typeof since !== 'string' || since.trim() === '') throw invalid('`since` must be an ISO date (for example 2026-01-01).')
  // Strict ISO only (review on #2901): `new Date` would accept "Jan 5 2026",
  // parse a TZ-less time as server-local and roll "2026-02-30" into March.
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(since.trim())) {
    throw invalid('`since` must be an ISO date (for example 2026-01-01) or a date-time with a timezone.')
  }
  const d = new Date(since.trim())
  // A date that rolls over ("2026-02-30" → March 2) is not the date the user typed.
  const [y, m, day] = since.trim().slice(0, 10).split('-').map(Number)
  const rolled = d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day
  if (Number.isNaN(d.getTime()) || (!since.includes('T') && rolled)) throw invalid('`since` must be an ISO date (for example 2026-01-01).')
  if (d.getTime() < BACKFILL_FLOOR.getTime()) throw invalid(`\`since\` cannot be before ${BACKFILL_FLOOR.toISOString().slice(0, 10)}.`)
  if (d.getTime() > now.getTime()) throw invalid('`since` must be in the past.')
  return d
}

/**
 * The user's explicit choice to include history: move the active
 * destination's `feed_from` EARLIER to `since`, record the choice under
 * `settings.backfill`, and run one bounded sync (200 payments, resumable via
 * the claim ledger — a larger history takes further Sync now presses).
 *
 * Only earlier: a `since` at or after the current floor is refused
 * (`SINCE_NOT_EARLIER`) with the floor untouched — moving it forward is the
 * activate path's job. A row with NO floor (a pre-#2862 row that already
 * feeds everything) is refused the same way. The guard is the WHERE clause of
 * `RECORD_BACKFILL_SQL`, so two concurrent backfills cannot leap-frog. Only
 * the ACTIVE destination can be backfilled: the sync feeds the active one,
 * and activating a connection later re-stamps its floor to now anyway.
 */
export async function backfillConnection(
  userId: string,
  providerId: string,
  sinceInput: unknown,
): Promise<{ feedFrom: string; fed: number }> {
  const now = new Date()
  const since = parseBackfillSince(sinceInput, now)
  const name = getProvider(providerId)?.displayName ?? providerId
  const row = await getConnection(userId, providerId)
  if (!row) throw new BackfillRefusedError('NOT_FOUND', `No ${name} connection to backfill.`)
  if (!row.is_active_destination || row.status !== 'connected') {
    throw new BackfillRefusedError('NOT_ACTIVE', `The ${name} connection is not the active feed destination — activate it first.`)
  }
  const moved = await recordBackfill(userId, providerId, { since, requestedAt: now })
  if (!moved) {
    // The statement refused: the floor is null, or not later than `since`.
    const floor = row.feed_from ? new Date(row.feed_from).toISOString() : null
    throw new BackfillRefusedError(
      'SINCE_NOT_EARLIER',
      floor
        ? `\`since\` must be earlier than the current feed-from (${floor}) — a backfill only ever includes more history.`
        : 'This connection already feeds all history; there is nothing earlier to include.',
    )
  }
  const { fed } = await syncUser(userId)
  return { feedFrom: new Date(moved.feed_from!).toISOString(), fed }
}

// ── Settings (#2867) ─────────────────────────────────────────────────────────

export class ConnectionSettingsError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID_SETTING'
  /** The offending key, named so the client can point at the field. */
  readonly key: string | null
  constructor(code: ConnectionSettingsError['code'], message: string, key: string | null = null) {
    super(message)
    this.name = 'ConnectionSettingsError'
    this.code = code
    this.key = key
  }
}

/** Fortnox: a four-digit BAS account, classes 1–8. */
const BAS_ACCOUNT_RE = /^[1-8]\d{3}$/
const GENERIC_ACCOUNT_MAX = 32

/**
 * Validate a settings patch: exactly the two keys, each optional. An unknown
 * key is refused by name (a typo must not silently do nothing); a
 * `suggested_account` for Fortnox must be a BAS account; for any other
 * provider a non-empty string of at most 32 characters. Null clears it.
 * Returns the stored-key patch for the merge.
 */
export function validateSettingsPatch(providerId: string, body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConnectionSettingsError('INVALID_SETTING', 'Settings must be a JSON object.')
  }
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === SETTINGS_KEY_SUGGESTED_ACCOUNT) {
      if (value === null) {
        patch[key] = null
        continue
      }
      if (typeof value !== 'string') {
        throw new ConnectionSettingsError('INVALID_SETTING', '`suggested_account` must be a string or null.', key)
      }
      const account = value.trim()
      // MUTATION TARGET (accounting-connections.test.ts "a non-BAS account is
      // refused"): the Fortnox rule is the four-digit BAS shape, nothing looser.
      if (providerId === 'fortnox') {
        if (!BAS_ACCOUNT_RE.test(account)) {
          throw new ConnectionSettingsError('INVALID_SETTING', '`suggested_account` must be a four-digit BAS account (1000–8999) for Fortnox.', key)
        }
      } else if (account.length === 0 || account.length > GENERIC_ACCOUNT_MAX) {
        throw new ConnectionSettingsError('INVALID_SETTING', `\`suggested_account\` must be 1–${GENERIC_ACCOUNT_MAX} characters.`, key)
      }
      patch[key] = account
    } else if (key === SETTINGS_KEY_AUTO_FEED) {
      if (typeof value !== 'boolean') {
        throw new ConnectionSettingsError('INVALID_SETTING', '`auto_feed` must be true or false.', key)
      }
      patch[key] = value
    } else {
      throw new ConnectionSettingsError('INVALID_SETTING', `Unknown setting \`${key}\`; the settings are \`suggested_account\` and \`auto_feed\`.`, key)
    }
  }
  return patch
}

/**
 * `PATCH /accounting/connections/:provider/settings`: validate, then merge on
 * the SQL side (`MERGE_CONNECTION_SETTINGS_SQL`) so `companySwitches` and
 * `backfill` survive untouched. An empty patch is a no-op that still answers
 * with the row. Any row can carry settings — a disconnected one keeps them
 * for its reconnect.
 */
export async function updateConnectionSettings(
  userId: string,
  providerId: string,
  body: unknown,
): Promise<ConnectionSummary> {
  const patch = validateSettingsPatch(providerId, body)
  const row = Object.keys(patch).length === 0
    ? await getConnection(userId, providerId)
    : await mergeSettings(userId, providerId, patch)
  if (!row) throw new ConnectionSettingsError('NOT_FOUND', `No ${getProvider(providerId)?.displayName ?? providerId} connection.`)
  return toConnectionSummary(row)
}

// ── Verify (dispatches to the ACTIVE connection's connector) ─────────────────

export type VerifyPushedPaymentResult =
  | { ok: true; provider: string; verification: AccountingVerification }
  | { ok: false; error_code: 'not_pushed' | 'not_connected' | 'no_invoice_ref'; status: string | null }

/**
 * `GET /accounting/feed/verify/:paymentId` and the reopen route act on the
 * ACTIVE destination — the right shape while exactly one is active (review,
 * 2026-09-11) — and dispatch to its connector's `verify()`.
 */
export async function verifyPushedPayment(userId: string, paymentId: string): Promise<VerifyPushedPaymentResult> {
  const active = await getActiveConnection(userId)
  const pair = active ? connectorFor(active.provider) : null
  if (!active || !pair) return { ok: false, error_code: 'not_connected', status: null }

  const sync = await getSyncState(userId, active.provider, paymentId)
  if (!sync || sync.status !== 'pushed') {
    return { ok: false, error_code: 'not_pushed', status: sync?.status ?? null }
  }
  if (!sync.external_ref) return { ok: false, error_code: 'no_invoice_ref', status: sync.status }

  const result = await pair.connector.verify(userId, sync.external_ref, paymentId)
  if (!result.ok) return { ok: false, error_code: result.error_code, status: sync.status }
  return { ok: true, provider: active.provider, verification: result.verification }
}

// ── Reopen (#1365), company-aware since #2864 ────────────────────────────────

/** Why a `pushed` row belongs to a company the connection no longer points at. */
export const PREVIOUS_COMPANY_REASON = 'belongs to the previous company'

export type ReopenPushedPaymentResult =
  | { reopened: true }
  | { reopened: false; error_code: 'not_pushed' }
  | { reopened: false; error_code: 'previous_company'; switched_at: string; company_name: string | null }

/**
 * The verification-gated reopen, made aware of company switches (review,
 * 2026-09-11). The caller has already had the provider confirm the record is
 * gone (or foreign). Before the row flips, the sync row's `created_at` is
 * compared with the connection's company-switch log (`settings.companySwitches`,
 * written by `company-info.ts`): a `pushed` row created BEFORE the latest
 * switch was delivered into the PREVIOUS company — its invoice is missing
 * in the current one by construction, and reopening it would re-feed the
 * previous company's history into the new one. Refused with
 * `previous_company`; the row stays `pushed`.
 *
 * Attribution mechanism and its limit: `accounting_feed_syncs` has no
 * company column, so a row is attributed by time — `created_at` against the
 * switch time — which is exact for the sequence connect → push → switch,
 * and is the only signal available for rows that predate #2864.
 */
export async function reopenPushedPayment(
  userId: string,
  providerId: string,
  paymentId: string,
  reason: string,
): Promise<ReopenPushedPaymentResult> {
  const sync = await getSyncState(userId, providerId, paymentId)
  if (!sync || sync.status !== 'pushed') return { reopened: false, error_code: 'not_pushed' }

  // MUTATION TARGET (company-switch.db.test.ts "reopen … refused"): without
  // this guard a company switch lets every pre-switch pushed row flip to
  // failed and re-push into the new company.
  const connection = await getConnection(userId, providerId)
  if (connection && connection.external_company_id) {
    const pushedUnder = companyIdAt(connection, new Date(sync.created_at))
    if (pushedUnder && pushedUnder !== connection.external_company_id) {
      // Name the company the row was pushed under, and the switch that moved
      // the connection away from it.
      const log = companySwitchLog(connection)
      const away = log.find((e) => e.fromCompanyId === pushedUnder && new Date(e.at).getTime() > new Date(sync.created_at).getTime())
      return {
        reopened: false,
        error_code: 'previous_company',
        switched_at: away?.at ?? log.at(-1)!.at,
        company_name: away?.fromCompanyName ?? null,
      }
    }
  }

  const reopened = await reopenMissingPushed(userId, providerId, paymentId, reason)
  return reopened ? { reopened: true } : { reopened: false, error_code: 'not_pushed' }
}
