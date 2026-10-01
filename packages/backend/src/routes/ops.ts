/**
 * Ops console — backend foundation (#3509, epic #3507).
 *
 * A founders-only, READ-ONLY window onto this backend. Nothing under `/ops`
 * moves funds, signs, changes signers or delegations, or acts as a user
 * (invariant 1, pinned by `__tests__/ops.invariants.test.ts`). This slice
 * ships sign-in, the session check and the reveal contract; the data reads
 * arrive with #3512–#3514.
 *
 * Off by default. Whether ops is configured is decided in this plugin's
 * `onRequest` hook — before request validation, auth and rate limiting — so
 * an unconfigured backend answers every `/ops/*` request, even a malformed
 * `POST /ops/reveal`, exactly as it answers a path that does not exist.
 *
 * Sign-in (GitHub OAuth, no scopes; the handoff contract is shared with the
 * ops app, #3515):
 *   1. The app calls `GET /ops/auth/github/start?return_to=<its origin>&nonce=<n>`.
 *      `return_to` must EXACTLY equal an `OPS_REDIRECT_ORIGINS` entry.
 *   2. The backend sends the browser to GitHub with a signed, 10-minute
 *      `state` carrying that origin and nonce.
 *   3. `GET /ops/auth/github/callback` verifies the state, re-checks the
 *      origin, exchanges the code, reads `GET /user`, drops GitHub's token,
 *      checks the numeric id against the allowlist (and 2FA when GitHub
 *      reports it), writes the audit row, and redirects to
 *      `<origin>/#token=<ops token>&nonce=<n>` — or `#error=<code>&nonce=<n>`.
 *
 * Every sign-in that reaches a GitHub identity (allowed or refused) and every
 * reveal writes an `ops_access_log` row through the MAIN pool before the response is sent; a
 * failed write answers 503 and returns nothing (invariant 6).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isOpsConfigured, type OpsConfig } from '../config/ops.js'
import { authRateLimit, opsRevealRateLimit } from '../middleware/rate-limit.js'
import { createOpsAuth, opsOperatorOf } from '../middleware/ops-auth.js'
import {
  exchangeGithubCode,
  fetchGithubUser,
  githubAuthorizeUrl,
  signOpsState,
  signOpsToken,
  verifyOpsState,
  type FetchLike,
  type GithubUser,
} from '../modules/ops/index.js'
import { insertOpsAccessLog, type OpsAccessLogEntry } from '../infra/repositories/ops-access-log.js'
import { isOpsRevealField, readOpsRevealField } from '../infra/repositories/ops-reveal.js'
import { OpsReadRoleUnsafeError } from '../infra/repositories/ops-read-role.js'
import type { Executor } from '../infra/transaction.js'

/** Where GitHub sends the browser back; must match the OAuth App's redirect URI. */
export const OPS_CALLBACK_PATH = '/ops/auth/github/callback'

export interface OpsRoutesOptions {
  ops: OpsConfig
  trustProxyHops: number
  /** Executor for ops DATA reads — the read-only role from #3510. Absent → data routes are off (404). */
  readDb?: Executor | null
  /** Audit writer; defaults to the main-pool insert. A test seam, never a way to skip the write. */
  audit?: (entry: OpsAccessLogEntry) => Promise<void>
  fetchImpl?: FetchLike
  now?: () => number
}

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const

export default async function opsRoutes(app: FastifyInstance, opts: OpsRoutesOptions): Promise<void> {
  const { ops } = opts
  const configured = isOpsConfigured(ops)
  // The default writer uses the repository's main-pool default — never the read-only role.
  const audit = opts.audit ?? ((entry: OpsAccessLogEntry) => insertOpsAccessLog(entry))
  const fetchImpl = opts.fetchImpl ?? fetch
  const tokenOpts = () => ({ secret: ops.jwtSecret, issuer: ops.publicOrigin, now: opts.now?.() })
  const opsAuth = createOpsAuth(ops, opts.now)
  const redirectUri = `${ops.publicOrigin}${OPS_CALLBACK_PATH}`

  // Invariant 3: unconfigured ⇒ indistinguishable from a missing route,
  // decided before validation, auth and rate limiting run.
  app.addHook('onRequest', async (_request, reply) => {
    if (!configured) return reply.callNotFound()
  })

  /** Write the audit row, or answer 503 and return false (fail-closed). */
  async function recordOrRefuse(
    request: FastifyRequest,
    reply: FastifyReply,
    entry: Omit<OpsAccessLogEntry, 'requestId'>,
  ): Promise<boolean> {
    try {
      await audit({ ...entry, requestId: request.id })
      return true
    } catch (err) {
      request.log.error(
        { errName: err instanceof Error ? err.name : 'non-error', action: entry.action },
        'ops access could not be recorded; refusing the request',
      )
      await reply.code(503).headers(NO_STORE).send({ error: 'Ops access could not be recorded; nothing was returned' })
      return false
    }
  }

  function backToApp(reply: FastifyReply, origin: string, fragment: Record<string, string>) {
    return reply.code(302).headers(NO_STORE).header('location', `${origin}/#${new URLSearchParams(fragment)}`).send()
  }

  // GET /ops/auth/github/start — begin a sign-in.
  app.get<{ Querystring: { return_to: string; nonce: string } }>(
    '/auth/github/start',
    { config: authRateLimit(opts.trustProxyHops, 'ops_auth') },
    async (request, reply) => {
      const { return_to: returnTo, nonce } = request.query
      if (!ops.redirectOrigins.includes(returnTo)) {
        return reply.code(400).send({ error: 'return_to is not an allowed ops origin' })
      }
      const state = signOpsState(tokenOpts(), { origin: returnTo, nonce })
      return reply
        .code(302)
        .headers(NO_STORE)
        .header('location', githubAuthorizeUrl({ clientId: ops.githubClientId, redirectUri, state }))
        .send()
    },
  )

  // GET /ops/auth/github/callback — finish a sign-in.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/github/callback',
    { config: authRateLimit(opts.trustProxyHops, 'ops_auth') },
    async (request, reply) => {
      const state = request.query.state ? verifyOpsState(tokenOpts(), request.query.state) : null
      // The origin is trusted only after the signature AND the current list agree.
      if (!state || !ops.redirectOrigins.includes(state.origin)) {
        return reply.code(400).headers(NO_STORE).send({ error: 'Invalid or expired sign-in state' })
      }
      const fail = (error: string) => backToApp(reply, state.origin, { error, nonce: state.nonce })
      if (request.query.error) return fail('github_denied')
      if (!request.query.code) return fail('missing_code')

      let user: GithubUser
      try {
        const accessToken = await exchangeGithubCode(
          {
            clientId: ops.githubClientId,
            clientSecret: ops.githubClientSecret,
            code: request.query.code,
            redirectUri,
          },
          fetchImpl,
        )
        // GitHub's token is used for this one read and then goes out of scope.
        user = await fetchGithubUser(accessToken, fetchImpl)
      } catch (err) {
        request.log.warn({ errName: err instanceof Error ? err.name : 'non-error' }, 'ops sign-in: GitHub step failed')
        return fail('github_unavailable')
      }

      const denial = !ops.allowedGithubIds.includes(user.id)
        ? 'not_allowed'
        : user.twoFactorAuthentication === false
          ? 'two_factor_required'
          : null
      if (denial) {
        const ok = await recordOrRefuse(request, reply, {
          operatorGithubId: user.id,
          operatorLogin: user.login,
          action: 'sign_in_denied',
          detail: denial,
        })
        return ok ? fail(denial) : reply
      }

      const ok = await recordOrRefuse(request, reply, {
        operatorGithubId: user.id,
        operatorLogin: user.login,
        action: 'sign_in',
      })
      if (!ok) return reply
      const token = signOpsToken(tokenOpts(), { githubId: user.id, login: user.login })
      return backToApp(reply, state.origin, { token, nonce: state.nonce })
    },
  )

  // GET /ops/me — who the session belongs to.
  app.get('/me', { onRequest: opsAuth }, async (request, reply) => {
    const operator = opsOperatorOf(request)
    return reply.headers(NO_STORE).send({
      github_id: operator.githubId,
      login: operator.login,
      expires_at: new Date(operator.exp * 1000).toISOString(),
    })
  })

  // POST /ops/reveal — one unmasked field, audited.
  app.post<{ Body: { target_type: string; target_id: string; field: string } }>(
    '/reveal',
    { onRequest: opsAuth, config: opsRevealRateLimit },
    async (request, reply) => {
      const readDb = opts.readDb
      // Data reads need the read-only role (#3510); without it this is a data route that is off.
      if (!readDb) return reply.callNotFound()
      const { target_type: targetType, target_id: targetId, field } = request.body
      if (!isOpsRevealField(targetType, field)) {
        return reply.code(400).send({ error: 'That field cannot be revealed' })
      }

      let row: Awaited<ReturnType<typeof readOpsRevealField>>
      try {
        row = await readOpsRevealField(readDb, targetType, field, targetId)
      } catch (err) {
        // The login failed the read-only self-check: data reads are off, as if unset.
        if (err instanceof OpsReadRoleUnsafeError) return reply.callNotFound()
        throw err
      }
      if (!row) return reply.code(404).headers(NO_STORE).send({ error: 'Not found' })

      const operator = opsOperatorOf(request)
      const ok = await recordOrRefuse(request, reply, {
        operatorGithubId: operator.githubId,
        operatorLogin: operator.login,
        action: 'reveal',
        targetType,
        targetId,
        field,
      })
      if (!ok) return reply
      return reply.headers(NO_STORE).send({
        target_type: targetType,
        target_id: targetId,
        field,
        value: row.value,
      })
    },
  )
}
