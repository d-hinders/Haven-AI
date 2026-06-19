import { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { authMiddleware } from '../middleware/auth.js'
import { buildAccountingEntries } from '../lib/accounting-entry.js'
import {
  buildFortnoxAuthorizeUrl,
  exchangeCodeForTokens,
  pushVoucher,
  toFortnoxVoucher,
  FortnoxError,
} from '../lib/fortnox.js'
import {
  deleteFortnoxConnection,
  fortnoxConfigured,
  fortnoxCredentials,
  getFortnoxConnection,
  getValidFortnoxAccessToken,
  saveFortnoxConnection,
} from '../lib/fortnox-connection.js'

interface CallbackQuery {
  code?: string
  state?: string
  error?: string
}

interface PushQuery {
  from?: string
  to?: string
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/
const OAUTH_STATE_PURPOSE = 'fortnox_oauth'

/**
 * Fortnox OAuth2 connect + voucher push (epic #462, P2 #465).
 *
 * Registered WITHOUT the global auth hook because the OAuth callback is hit by a
 * browser redirect from Fortnox (no JWT). Authed endpoints opt in per-route; the
 * callback authenticates the user via a signed `state` instead.
 */
export default async function fortnoxRoutes(app: FastifyInstance): Promise<void> {
  const settingsUrl = `${config.frontendUrl}/settings`

  // GET /accounting/fortnox/status
  app.get('/status', { onRequest: authMiddleware }, async (request) => {
    const { sub } = request.user as { sub: string }
    if (!fortnoxConfigured()) return { configured: false, connected: false }
    const conn = await getFortnoxConnection(sub)
    return {
      configured: true,
      connected: Boolean(conn),
      scope: conn?.scope ?? null,
      expiresAt: conn?.expires_at ?? null,
    }
  })

  // GET /accounting/fortnox/connect → redirect to Fortnox consent
  app.get('/connect', { onRequest: authMiddleware }, async (request, reply) => {
    if (!fortnoxConfigured()) {
      return reply.code(503).send({ error: 'Fortnox integration is not configured.' })
    }
    const { sub } = request.user as { sub: string }
    // purpose is carried in the token at runtime; the JWT payload type is fixed
    // to { sub, email }, hence the cast.
    const state = app.jwt.sign(
      { sub, purpose: OAUTH_STATE_PURPOSE } as unknown as { sub: string; email: string },
      { expiresIn: '10m' },
    )
    return reply.redirect(buildFortnoxAuthorizeUrl(fortnoxCredentials(), state))
  })

  // GET /accounting/fortnox/callback?code=&state= (public; authenticated by state)
  app.get<{ Querystring: CallbackQuery }>('/callback', async (request, reply) => {
    const { code, state, error } = request.query
    if (error) return reply.redirect(`${settingsUrl}?fortnox=denied`)
    if (!code || !state) return reply.redirect(`${settingsUrl}?fortnox=error`)

    let userId: string
    try {
      const payload = app.jwt.verify<{ sub: string; purpose?: string }>(state)
      if (payload.purpose !== OAUTH_STATE_PURPOSE) throw new Error('bad_state')
      userId = payload.sub
    } catch {
      return reply.redirect(`${settingsUrl}?fortnox=error`)
    }

    try {
      const tokens = await exchangeCodeForTokens(fortnoxCredentials(), code)
      await saveFortnoxConnection(userId, tokens)
    } catch {
      return reply.redirect(`${settingsUrl}?fortnox=error`)
    }
    return reply.redirect(`${settingsUrl}?fortnox=connected`)
  })

  // DELETE /accounting/fortnox — disconnect
  app.delete('/', { onRequest: authMiddleware }, async (request, reply) => {
    const { sub } = request.user as { sub: string }
    await deleteFortnoxConnection(sub)
    return reply.code(204).send()
  })

  // POST /accounting/fortnox/push?from=&to= — push vouchers for a period
  app.post<{ Querystring: PushQuery }>('/push', { onRequest: authMiddleware }, async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { from, to } = request.query
    if (from && !ISO_DATE_RE.test(from)) return reply.code(400).send({ error: 'Invalid "from" date (expected ISO)' })
    if (to && !ISO_DATE_RE.test(to)) return reply.code(400).send({ error: 'Invalid "to" date (expected ISO)' })

    const accessToken = await getValidFortnoxAccessToken(sub)
    if (!accessToken) return reply.code(400).send({ error: 'Fortnox is not connected. Connect it first.' })

    const entries = await buildAccountingEntries({ userId: sub, from, to })

    let pushed = 0
    let skipped = 0
    const failures: { paymentId: string; error: string }[] = []

    for (const entry of entries) {
      const voucher = toFortnoxVoucher(entry)
      if (!voucher) {
        skipped += 1 // no book-time SEK — unbookable
        continue
      }
      try {
        await pushVoucher(accessToken, voucher)
        pushed += 1
      } catch (err) {
        failures.push({
          paymentId: entry.paymentId,
          error: err instanceof FortnoxError ? err.message : String(err),
        })
      }
    }

    return reply.send({ pushed, skipped, failed: failures.length, failures })
  })
}
