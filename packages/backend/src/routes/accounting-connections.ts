import { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { authMiddleware } from '../middleware/auth.js'
import {
  BackfillRefusedError,
  ConnectionNotActivatableError,
  ConnectionSettingsError,
  InvalidApiKeyError,
  OAUTH_STATE_PURPOSE,
  OAUTH_STATE_TTL_SECONDS,
  ProviderNotConnectableError,
  UnsupportedBaseCurrencyError,
  activateProvider,
  backfillConnection,
  completeProviderOAuthCallback,
  connectProviderWithApiKey,
  connectUrlFor,
  consumeOAuthState,
  disconnectProvider,
  listConnectionSummaries,
  listProviderListings,
  newOAuthStateClaims,
  updateConnectionSettings,
  type OAuthStateClaims,
} from '../modules/accounting/index.js'

interface ProviderParams {
  provider: string
}

interface CallbackQuery {
  code?: string
  state?: string
  error?: string
}

interface ApiKeyBody {
  apiKey?: string
}

interface BackfillBody {
  since?: unknown
}

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/

/**
 * Provider-generic accounting connections (#2862, epic #2858) — replaces
 * `/accounting/fortnox/*`.
 *
 * Registered WITHOUT the global auth hook because the OAuth callback is hit by
 * a browser redirect from the provider (no JWT). Every other route opts in
 * per-route; the callback authenticates the user via the signed `state`.
 *
 * ## The `state`
 *
 * A JWT signed with the app secret (#1640): `sub` is the user, `purpose` is a
 * claim `authMiddleware` rejects (so a session token cannot be replayed as
 * OAuth state and vice versa), `provider` binds the state to the provider the
 * URL was issued for, `jti` makes it single-use (#2862) — the callback
 * consumes it through `consumeOAuthState` BEFORE the code is exchanged, so a
 * replayed state never reaches the provider. Ten-minute expiry.
 *
 * ## Credential boundary
 *
 * Nothing here returns a token, a key or a ciphertext: every connection
 * answer is a `ConnectionSummary` (metadata), the API-key route never echoes
 * the key, and the callback redirects without echoing anything it received.
 * Pinned by the route tests, written as redaction tests.
 */
export default async function accountingConnectionsRoutes(app: FastifyInstance): Promise<void> {
  const accountingUrl = `${config.frontendUrl}/accounting`
  // #2864: a connect refused because the company books in another currency
  // is the one failure the user can act on differently (pick another
  // company), so the redirect names it: `&reason=unsupported_currency`.
  const redirect = (provider: string, outcome: 'connected' | 'denied' | 'error', reason?: 'unsupported_currency') =>
    `${accountingUrl}?provider=${encodeURIComponent(provider)}&connect=${outcome}${reason ? `&reason=${reason}` : ''}`

  function providerRefusal(err: unknown): { status: number; body: { error: string; error_code: string } } | null {
    if (err instanceof ProviderNotConnectableError) {
      const status =
        err.code === 'UNKNOWN_PROVIDER' ? 404 : err.code === 'PROVIDER_NOT_CONFIGURED' ? 503 : 409
      return { status, body: { error: err.message, error_code: err.code } }
    }
    return null
  }

  // GET /accounting/providers — the registry, with per-deployment `configured`.
  app.get('/providers', { onRequest: authMiddleware }, async () => {
    return { providers: listProviderListings() }
  })

  // GET /accounting/connections — the caller's connections, metadata only.
  app.get('/connections', { onRequest: authMiddleware }, async (request) => {
    const { sub } = request.user as { sub: string }
    return { connections: await listConnectionSummaries(sub) }
  })

  // POST /accounting/connections/:provider/connect-url → consent URL as JSON
  // (the SPA cannot carry its Bearer token through a plain browser navigation).
  // #2865: also the RE-CONSENT path. An existing connection — `scope_missing`,
  // `needs_reauthorisation`, or simply one the user wants re-granted — is not
  // a refusal here: the same URL is issued, and the callback below UPDATES
  // the existing row (secrets, scope, status → connected) while keeping its
  // settings, feed_from, active flag and sync history (`completeOAuth2Connect`).
  app.post<{ Params: ProviderParams }>(
    '/connections/:provider/connect-url',
    { onRequest: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { provider } = request.params
      if (!PROVIDER_ID_RE.test(provider)) return reply.code(404).send({ error: 'Unknown accounting provider.', error_code: 'UNKNOWN_PROVIDER' })
      // The payload type is fixed to { sub, email } by the jwt plugin; the
      // state carries different claims at runtime, hence the cast.
      const state = app.jwt.sign(
        newOAuthStateClaims(sub, provider) as unknown as { sub: string; email: string },
        { expiresIn: `${OAUTH_STATE_TTL_SECONDS}s` },
      )
      try {
        return { url: connectUrlFor(provider, state) }
      } catch (err) {
        const refusal = providerRefusal(err)
        if (refusal) return reply.code(refusal.status).send(refusal.body)
        throw err
      }
    },
  )

  // GET /accounting/connections/:provider/callback?code=&state= (public;
  // authenticated by the state).
  app.get<{ Params: ProviderParams; Querystring: CallbackQuery }>(
    '/connections/:provider/callback',
    async (request, reply) => {
      const { provider } = request.params
      const { code, state, error } = request.query
      if (error) return reply.redirect(redirect(provider, 'denied'))
      if (!code || !state) return reply.redirect(redirect(provider, 'error'))

      let claims: OAuthStateClaims
      try {
        claims = app.jwt.verify<OAuthStateClaims>(state)
        if (claims.purpose !== OAUTH_STATE_PURPOSE) throw new Error('bad_state')
        if (claims.provider !== provider) throw new Error('bad_state')
        if (!claims.jti || !claims.sub) throw new Error('bad_state')
      } catch {
        return reply.redirect(redirect(provider, 'error'))
      }

      // Single-use: consumed BEFORE the code exchange, so a replay never
      // reaches the provider. A store that cannot answer refuses (see
      // modules/accounting/oauth-state.ts).
      if (!(await consumeOAuthState(claims.jti))) {
        request.log.warn({ userId: claims.sub, provider }, 'accounting oauth state replayed or unverifiable — refused')
        return reply.redirect(redirect(provider, 'error'))
      }

      try {
        await completeProviderOAuthCallback(provider, claims.sub, code)
      } catch (err) {
        // The redirect is the same for every failure class — the user sees
        // "error" either way — but an operator must be able to tell them
        // apart, so the NAME is logged (never the message: a token exchange
        // error can carry the provider's response body).
        request.log.warn(
          { err: err instanceof Error ? err.name : 'Error', userId: claims.sub, provider },
          'accounting oauth callback failed after state verification',
        )
        if (err instanceof UnsupportedBaseCurrencyError) return reply.redirect(redirect(provider, 'error', 'unsupported_currency'))
        return reply.redirect(redirect(provider, 'error'))
      }
      return reply.redirect(redirect(provider, 'connected'))
    },
  )

  // POST /accounting/connections/:provider/api-key { apiKey } — validate at
  // the provider, then store encrypted. The key is never echoed.
  app.post<{ Params: ProviderParams; Body: ApiKeyBody }>(
    '/connections/:provider/api-key',
    { onRequest: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { provider } = request.params
      const apiKey = typeof request.body?.apiKey === 'string' ? request.body.apiKey.trim() : ''
      if (!apiKey) return reply.code(400).send({ error: 'An API key is required.', error_code: 'API_KEY_REQUIRED' })
      try {
        const connection = await connectProviderWithApiKey(provider, sub, apiKey)
        return reply.code(201).send({ connection })
      } catch (err) {
        const refusal = providerRefusal(err)
        if (refusal) return reply.code(refusal.status).send(refusal.body)
        if (err instanceof InvalidApiKeyError) return reply.code(400).send({ error: err.message, error_code: err.code })
        if (err instanceof UnsupportedBaseCurrencyError) return reply.code(409).send({ error: err.message, error_code: err.code })
        throw err
      }
    },
  )

  // DELETE /accounting/connections/:provider — disconnect (row kept, secrets cleared).
  app.delete<{ Params: ProviderParams }>(
    '/connections/:provider',
    { onRequest: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { provider } = request.params
      const outcome = await disconnectProvider(sub, provider)
      if (outcome.revokeError) {
        request.log.warn({ err: outcome.revokeError, userId: sub, provider }, 'accounting provider revoke failed on disconnect')
      }
      return reply.code(204).send()
    },
  )

  // POST /accounting/connections/:provider/activate — make it the feed
  // destination; feed_from = now.
  app.post<{ Params: ProviderParams }>(
    '/connections/:provider/activate',
    { onRequest: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { provider } = request.params
      try {
        return { connection: await activateProvider(sub, provider) }
      } catch (err) {
        if (err instanceof ConnectionNotActivatableError) {
          return reply.code(err.code === 'NOT_FOUND' ? 404 : 409).send({ error: err.message, error_code: err.code })
        }
        throw err
      }
    },
  )

  // POST /accounting/connections/:provider/backfill { since } — the user's
  // explicit choice to include history (#2867): feed_from moves EARLIER to
  // `since` (never later — that is activate's job), the choice is recorded
  // under settings.backfill, and one bounded sync runs.
  app.post<{ Params: ProviderParams; Body: BackfillBody }>(
    '/connections/:provider/backfill',
    { onRequest: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { provider } = request.params
      try {
        return await backfillConnection(sub, provider, request.body?.since)
      } catch (err) {
        if (err instanceof BackfillRefusedError) {
          const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'NOT_ACTIVE' ? 409 : 400
          return reply.code(status).send({ error: err.message, error_code: err.code })
        }
        throw err
      }
    },
  )

  // PATCH /accounting/connections/:provider/settings { suggested_account?,
  // auto_feed? } — exactly those two keys (#2867); anything else is a 400
  // that names the key.
  app.patch<{ Params: ProviderParams; Body: unknown }>(
    '/connections/:provider/settings',
    { onRequest: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { provider } = request.params
      try {
        return { connection: await updateConnectionSettings(sub, provider, request.body ?? {}) }
      } catch (err) {
        if (err instanceof ConnectionSettingsError) {
          if (err.code === 'NOT_FOUND') return reply.code(404).send({ error: err.message, error_code: err.code })
          return reply.code(400).send({ error: err.message, error_code: err.code, key: err.key })
        }
        throw err
      }
    },
  )
}
