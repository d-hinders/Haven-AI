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
 * chooses a backfill (#2867), which passes an explicit `feedFrom`.
 */

import {
  disconnect as disconnectRow,
  getActiveConnection,
  getConnection,
  listConnections,
  setActiveDestination,
  setStatus,
  type AccountingConnectionRow,
  type ConnectionStatus,
} from '../../infra/repositories/accounting-connections.js'
import { decryptSecrets } from '../../infra/secrets.js'
import { connectWithApiKey } from './api-key-flow.js'
import { companySwitchLog } from './company-info.js'
import { getConnector, type AccountingVerification, type ProviderSecrets } from './connector.js'
import { getSyncState, reopenMissingPushed } from './feed-sync.js'
import { fortnoxConfigured, fortnoxCredentials } from './fortnox-connection.js'
import { fortnoxOAuth2Config } from './fortnox.js'
import { buildAuthorizeUrl, completeOAuth2Connect, type OAuth2ProviderConfig } from './oauth-flow.js'
import type { AccountingProvider } from './provider.js'
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
  tokenExpiresAt: string | null
  /** #2864: the provider's own tenant id (Fortnox: `DatabaseNumber`); null until a grant with the scope read it. */
  externalCompanyId: string | null
  externalCompanyName: string | null
  baseCurrency: string | null
  lastPushAt: string | null
  lastError: string | null
  connectedAt: string
  updatedAt: string
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
    tokenExpiresAt: iso(row.token_expires_at),
    externalCompanyId: row.external_company_id,
    externalCompanyName: row.external_company_name,
    baseCurrency: row.base_currency,
    lastPushAt: iso(row.last_push_at),
    lastError: row.last_error,
    connectedAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
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
  await setStatus(userId, providerId, status, reason)
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
  const lastSwitch = connection ? companySwitchLog(connection).at(-1) : undefined
  if (lastSwitch && new Date(sync.created_at).getTime() < new Date(lastSwitch.at).getTime()) {
    return { reopened: false, error_code: 'previous_company', switched_at: lastSwitch.at, company_name: lastSwitch.fromCompanyName }
  }

  const reopened = await reopenMissingPushed(userId, providerId, paymentId, reason)
  return reopened ? { reopened: true } : { reopened: false, error_code: 'not_pushed' }
}
