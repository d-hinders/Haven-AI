/**
 * Generic API-key flow for accounting providers (#2862, epic #2858).
 *
 * The other auth kind. No redirect, no state, no refresh: the user pastes a
 * key, the flow VALIDATES it by asking the provider who the key belongs to
 * (`connector.getCompanyInfo`), refuses a ledger that books in the wrong
 * currency, and only then stores the key encrypted. A key that the provider
 * rejects never lands. #3017: Accounted is the first live provider of this
 * kind — a key that sees ZERO companies is refused the same way (there is no
 * company to feed), and one that sees SEVERAL is refused by the connector
 * (`MultiCompanyKeyError`) before anything is stored.
 *
 * #3019 widens the flow with the webhook registration step: for the one
 * provider that asks for it — Accounted, wired in `connections.ts`'s
 * `registerAccountedWebhooksAdapter` (the descriptor is hard-coded there,
 * not a `provider.webhooks` field) — the stored connection also carries the
 * three event subscriptions and the capability URL token. The registration
 * runs AFTER the row is stored (the callbacks must name a token the row
 * already answers) and all-or-nothing: a partial registration deletes what
 * it created and the connection is flagged `needs_attention` rather than
 * left half-subscribed. A RECONNECT deletes the previous three
 * subscriptions first (PR #3196 review, S3): `upsertConnection` overwrites
 * the secrets blob, which was the only record of the old triples, so
 * without an explicit teardown the provider keeps three orphaned
 * subscriptions dispatching to a retired callback token.
 */

import {
  getConnection,
  newWebhookToken,
  setWebhookToken,
  stampFeedFromIfUnset,
  updateSecrets,
  upsertConnection,
  type AccountingConnectionRow,
} from '../../infra/repositories/accounting-connections.js'
import { SecretsKeyMissingError, decryptSecrets, encryptSecrets, secretsKeyConfigured } from '../../infra/secrets.js'
import { applyCompanyInfo } from './company-info.js'
import type { AccountingConnector } from './connector.js'
import { ProviderError, assertSupportedBaseCurrency, type AccountingProvider, type ProviderCompanyInfo } from './provider.js'
import { ACCOUNTING_EVENT, emitOpsEvent, flagConnectionStatus } from './ops-signals.js'
import {
  AccountedWebhookRegistrationError,
  deleteAccountedWebhooks,
  registerAccountedWebhooks,
  type AccountedWebhookSubscriptionSecret,
} from './accounted-webhooks.js'

/**
 * The API origin the callback URL is built on — stated per deployment (#2530).
 *
 * FAIL CLOSED (PR #3196 review, S5): with no stated origin there is no
 * public URL the provider could reach, and the old `http://localhost:…`
 * fallback REGISTERED an unroutable callback at the provider while the
 * connection read `connected` — the subscription then dies at the provider
 * after enough failed dispatches, silently. Throwing here lets the connect
 * flow flag the row `needs_attention` with the reason instead of ever
 * registering a callback Haven knows cannot work.
 */
export class NoPublicApiOriginError extends Error {
  readonly name = 'NoPublicApiOriginError'
  constructor() {
    super('no public API origin configured — set HAVEN_API_URL (or PUBLIC_API_URL) on this deployment, then reconnect')
  }
}

export function webhookApiOrigin(): string {
  const env = process.env.HAVEN_API_URL ?? process.env.PUBLIC_API_URL
  if (env && env.trim() !== '') return env.trim().replace(/\/+$/, '')
  throw new NoPublicApiOriginError()
}

/** What the secrets blob carries for an api_key provider. */
export interface ApiKeySecrets {
  apiKey: string
  /**
   * #3019: the webhook triples `(subscription_id, event_type, secret)`,
   * encrypted together with the key. Absent on a connection created before
   * this slice, and on providers that run no webhook registration.
   */
  webhooks?: AccountedWebhookSubscriptionSecret[]
}

/** The per-provider webhook-registration descriptor. `register` is Accounted-only today. */
export interface ProviderWebhookRegistration {
  /**
   * Create the subscriptions and return the triples to store (all-or-nothing).
   * `apiOrigin` is the public callback origin, resolved BY THE FLOW via
   * `webhookApiOrigin()` (S5) — it throws `NoPublicApiOriginError` when the
   * deployment states none, and the flow flags the connection instead of
   * registering an unroutable callback.
   */
  register(input: { secrets: ApiKeySecrets; companyId: string; token: string; apiOrigin: string }): Promise<AccountedWebhookSubscriptionSecret[]>
}

export class InvalidApiKeyError extends Error {
  readonly code = 'INVALID_API_KEY' as const
  constructor(provider: string, detail: string) {
    super(`${provider} did not accept the API key: ${detail}`)
    this.name = 'InvalidApiKeyError'
  }
}

export async function readApiKeyConnection(
  providerId: string,
  userId: string,
): Promise<{ row: AccountingConnectionRow; secrets: ApiKeySecrets } | null> {
  const row = await getConnection(userId, providerId)
  if (!row || !row.secrets_ciphertext || row.status === 'disconnected') return null
  return { row, secrets: decryptSecrets<ApiKeySecrets>(row.secrets_ciphertext, row.secrets_key_version) }
}

/**
 * Validate-then-store. The validation IS the provider call: a connector for an
 * api_key provider must implement `getCompanyInfo` so that it fails (throws a
 * `ProviderError`) on a key the provider rejects.
 *
 * `webhooks` (#3019): when the provider descriptor carries a registration,
 * the connect also subscribes the three Accounted event types. Order
 * matters: the row is stored FIRST (with a placeholder secrets blob — the
 * final one follows below), so the callback token exists before any
 * subscription can deliver; then the registrations run; then the secrets
 * blob is re-encrypted once with everything in it. The failure path flags
 * the connection `needs_attention` — the subscriptions are the only part of
 * the connection that cannot be validated up front, and the runbook owns the
 * retry.
 */
export async function connectWithApiKey(input: {
  provider: AccountingProvider
  connector: AccountingConnector
  userId: string
  apiKey: string
  /** #3019: the webhook registration for this provider, when it has one. */
  webhooks?: {
    register: (reg: { secrets: ApiKeySecrets; companyId: string; token: string; apiOrigin: string }) => Promise<AccountedWebhookSubscriptionSecret[]>
  }
  /** #3019: test seam — the provider HTTP double the registration uses. */
  fetchImpl?: typeof fetch
}): Promise<AccountingConnectionRow> {
  if (!secretsKeyConfigured()) throw new SecretsKeyMissingError()
  const secrets: ApiKeySecrets = { apiKey: input.apiKey }

  let info: ProviderCompanyInfo
  try {
    info = await input.connector.getCompanyInfo(secrets as unknown as Record<string, unknown>)
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
      throw new InvalidApiKeyError(input.provider.id, `HTTP ${err.status}`)
    }
    throw err
  }
  assertSupportedBaseCurrency(info)

  const { ciphertext, keyVersion } = encryptSecrets(secrets as unknown as Record<string, unknown>)
  const existed = await getConnection(input.userId, input.provider.id)
  // S3 (PR #3196 review): on a reconnect, the OLD row's secrets blob is the
  // only record of the previous three (subscription_id, event_type, secret)
  // triples — `upsertConnection` below overwrites it. Delete those
  // subscriptions BEFORE the overwrite, while the secrets are still in
  // hand. Best effort by the disconnect contract: a provider outage must
  // not block a reconnect (the runbook's dead-subscription section covers
  // subscriptions left behind).
  if (existed && input.webhooks && input.provider.id === 'accounted' && existed.secrets_ciphertext && existed.external_company_id) {
    try {
      const previous = decryptSecrets<{ apiKey?: string; webhooks?: AccountedWebhookSubscriptionSecret[] }>(
        existed.secrets_ciphertext,
        existed.secrets_key_version,
      )
      if (previous.apiKey && previous.webhooks && previous.webhooks.length > 0) {
        const outcome = await deleteAccountedWebhooks({
          apiKey: previous.apiKey,
          companyId: existed.external_company_id,
          subscriptions: previous.webhooks,
          fetchImpl: input.fetchImpl ?? fetch,
        })
        // Best effort by contract, but never silent (PR #3196 round 2, S-E):
        // the usual reason to reconnect an api_key provider is a rotated or
        // revoked key, and then every delete with the OLD key is refused —
        // the orphans keep dispatching to a token that now 404s until the
        // provider retires them. The event is the operator's only signal.
        if (outcome.failed > 0) {
          emitOpsEvent('warn', {
            event: ACCOUNTING_EVENT.webhookTeardownFailed,
            userId: input.userId,
            provider: input.provider.id,
            deleted: outcome.deleted,
            failed: outcome.failed,
          })
        }
      }
    } catch (err) {
      emitOpsEvent('warn', {
        event: ACCOUNTING_EVENT.webhookTeardownFailed,
        userId: input.userId,
        provider: input.provider.id,
        deleted: 0,
        failed: -1,
        error: err instanceof Error ? err.name : 'unknown',
      })
    }
  }
  const saved = await upsertConnection(input.userId, {
    provider: input.provider.id,
    authKind: 'api_key',
    secretsCiphertext: ciphertext,
    secretsKeyVersion: keyVersion,
    grantedScope: null,
    tokenExpiresAt: null,
  })
  // Same rule as the OAuth flow: a first connect that took the flag is an
  // activation and carries the feed-from floor; a reconnect keeps its own.
  let row = (!existed && saved.is_active_destination
    ? await stampFeedFromIfUnset(input.userId, input.provider.id, new Date())
    : null) ?? saved

  // #3019: the webhook half. A fresh capability token per connect (a stale
  // token from a previous connect is retired with it — the URL is a
  // capability, and a reconnect re-issues it). Registration AFTER the row
  // exists (the URL must resolve to a row from the first delivery) and the
  // secrets re-encrypted to carry the triples.
  if (input.webhooks && info.externalCompanyId) {
    // S5 (PR #3196 review): no public origin means the callback URL can
    // only ever be unroutable — register nothing, re-issue nothing, flag
    // the row. The token stays the previous one when there is one (its
    // subscriptions were torn down above); the message is the exact flag
    // reason the runbook greps for.
    let apiOrigin: string
    try {
      apiOrigin = webhookApiOrigin()
    } catch (err) {
      const reason = err instanceof NoPublicApiOriginError
        ? 'no public API origin configured'
        : `no public API origin configured — ${err instanceof Error ? err.name : 'Error'}`
      await flagConnectionStatus(input.userId, input.provider.id, 'needs_attention', reason)
      const updated = await getConnection(input.userId, input.provider.id)
      return applyCompanyInfo({ provider: input.provider, userId: input.userId, existed, saved: updated ?? row, info })
    }
    const token = newWebhookToken()
    await setWebhookToken(input.userId, input.provider.id, token)
    try {
      const subscriptions = await input.webhooks.register({
        secrets,
        companyId: info.externalCompanyId,
        token,
        apiOrigin,
      })
      const { ciphertext: withWebhooks, keyVersion: wv } = encryptSecrets({
        ...secrets,
        webhooks: subscriptions,
      } as unknown as Record<string, unknown>)
      await updateSecrets(input.userId, input.provider.id, {
        secretsCiphertext: withWebhooks,
        secretsKeyVersion: wv,
        tokenExpiresAt: null,
      })
    } catch (err) {
      // All-or-nothing held at the provider (registerAccountedWebhooks rolled
      // its creates back); the local row stays connected but is flagged — the
      // feed still works, the push confirmations do not arrive.
      const reason = err instanceof AccountedWebhookRegistrationError
        ? `webhook subscription failed — ${err.message}`
        : `webhook subscription failed — ${err instanceof Error ? err.name : 'Error'}`
      await flagConnectionStatus(input.userId, input.provider.id, 'needs_attention', reason)
    }
    const updated = await getConnection(input.userId, input.provider.id)
    if (updated) row = updated
  }

  // #2864: company switch on reconnect / scope_missing on a refused company
  // read — the same step the OAuth flow runs (`company-info.ts`).
  return applyCompanyInfo({ provider: input.provider, userId: input.userId, existed, saved: row, info })
}
