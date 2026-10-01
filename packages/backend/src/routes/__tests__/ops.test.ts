/**
 * Ops console foundation (#3509, epic #3507) — sign-in, session, reveal.
 *
 * GitHub is a collaborator this suite does not own, so it is a recorded fake
 * `fetch`. The audit writer is injected only where a test needs to observe
 * or fail it; the real-DB block at the bottom drives the real repository.
 */
import Fastify, { FastifyError, FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { createSigner } from 'fast-jwt'
import { Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { authMiddleware } from '../../middleware/auth.js'
import { agentAuthMiddleware } from '../../middleware/agentAuth.js'
import { eitherAuth } from '../catalog.js'
import type { OpsConfig } from '../../config/ops.js'
import type { OpsAccessLogEntry } from '../../infra/repositories/ops-access-log.js'
import { signOpsToken, verifyOpsState, verifyOpsToken } from '../../modules/ops/tokens.js'
import opsRoutes, { OPS_CALLBACK_PATH, type OpsRoutesOptions } from '../ops.js'

const ORIGIN = 'https://ops.example.com'
const API = 'https://api.example.com'
const NONCE = 'n0nce-n0nce-n0nce-1234'
const GITHUB_ACCESS_TOKEN = 'gho_must_never_leave_the_callback'
const DASH_SECRET = 'dashboard-secret-for-tests'

const OPS: OpsConfig = {
  githubClientId: 'gh-client-id',
  githubClientSecret: 'gh-client-secret',
  jwtSecret: 'ops-secret-for-tests-0123456789',
  allowedGithubIds: [111],
  redirectOrigins: [ORIGIN],
  publicOrigin: API,
}
const UNCONFIGURED: OpsConfig = { ...OPS, githubClientId: '' }

interface GithubFake {
  calls: { url: string; init?: RequestInit }[]
  fetchImpl: typeof fetch
}

function githubFake(user: Record<string, unknown> | 'fail' = { id: 111, login: 'founder', two_factor_authentication: true }): GithubFake {
  const calls: GithubFake['calls'] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (user === 'fail') throw new Error('network down')
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: GITHUB_ACCESS_TOKEN, token_type: 'bearer' }), { status: 200 })
    }
    if (url === 'https://api.github.com/user') return new Response(JSON.stringify(user), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

interface Built {
  app: FastifyInstance
  audits: OpsAccessLogEntry[]
  logs: string[]
}

async function build(overrides: Partial<OpsRoutesOptions> = {}): Promise<Built> {
  const audits: OpsAccessLogEntry[] = []
  const logs: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk))
      cb()
    },
  })
  const app = Fastify({ logger: { level: 'trace', stream } })
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    void reply.status(error.statusCode ?? 500).send({ error: error.message })
  })
  // The production shape: enforce mode with the ops module on the list.
  installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/ops.ts'] })
  await app.register(opsRoutes, {
    prefix: '/ops',
    ops: OPS,
    trustProxyHops: 0,
    fetchImpl: githubFake().fetchImpl,
    audit: async (entry) => {
      audits.push(entry)
    },
    ...overrides,
  })
  await app.ready()
  return { app, audits, logs }
}

function tokenFor(githubId: number, cfg: OpsConfig = OPS, now?: number): string {
  return signOpsToken({ secret: cfg.jwtSecret, issuer: cfg.publicOrigin, now }, { githubId, login: `user-${githubId}` })
}

function fragmentOf(location: string): URLSearchParams {
  return new URLSearchParams(location.slice(location.indexOf('#') + 1))
}

async function startState(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/ops/auth/github/start?return_to=${encodeURIComponent(ORIGIN)}&nonce=${NONCE}` })
  expect(res.statusCode).toBe(302)
  return new URL(String(res.headers.location)).searchParams.get('state') ?? ''
}

describe('ops console — unconfigured deployment answers like a missing route', () => {
  let built: Built
  beforeAll(async () => {
    built = await build({ ops: UNCONFIGURED })
  })
  afterAll(async () => built.app.close())

  it('404s every ops route, before validation runs (a malformed reveal is 404, not 400)', async () => {
    const missing = await built.app.inject({ method: 'GET', url: '/ops/definitely-not-a-route' })
    expect(missing.statusCode).toBe(404)
    for (const req of [
      { method: 'GET' as const, url: '/ops/me' },
      { method: 'GET' as const, url: `/ops/auth/github/start?return_to=${encodeURIComponent(ORIGIN)}&nonce=${NONCE}` },
      { method: 'GET' as const, url: '/ops/auth/github/start' },
      { method: 'GET' as const, url: '/ops/auth/github/callback?state=x&code=y' },
      { method: 'POST' as const, url: '/ops/reveal', payload: { nonsense: true } },
    ]) {
      const res = await built.app.inject(req)
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(404)
      expect(res.json(), `${req.method} ${req.url}`).toEqual({ ...missing.json(), message: expect.any(String) })
    }
  })
})

describe('ops console — GET /ops/auth/github/start', () => {
  let built: Built
  beforeAll(async () => {
    built = await build()
  })
  afterAll(async () => built.app.close())

  it('redirects to GitHub with no scopes, the registered redirect_uri and a state carrying origin + nonce', async () => {
    const res = await built.app.inject({ method: 'GET', url: `/ops/auth/github/start?return_to=${encodeURIComponent(ORIGIN)}&nonce=${NONCE}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers['cache-control']).toBe('no-store')
    const location = new URL(String(res.headers.location))
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(location.searchParams.get('client_id')).toBe(OPS.githubClientId)
    expect(location.searchParams.get('redirect_uri')).toBe(`${API}${OPS_CALLBACK_PATH}`)
    expect(location.searchParams.has('scope')).toBe(false)
    const state = verifyOpsState({ secret: OPS.jwtSecret, issuer: API }, location.searchParams.get('state') ?? '')
    expect(state).toEqual({ origin: ORIGIN, nonce: NONCE })
  })

  it.each([
    ['a prefix match', `${ORIGIN}.evil.example`],
    ['a trailing slash', `${ORIGIN}/`],
    ['another port', `${ORIGIN}:8443`],
    ['plain http', 'http://ops.example.com'],
    ['a path', `${ORIGIN}/callback`],
    ['an unrelated origin', 'https://evil.example'],
  ])('refuses %s', async (_label, returnTo) => {
    const res = await built.app.inject({ method: 'GET', url: `/ops/auth/github/start?return_to=${encodeURIComponent(returnTo)}&nonce=${NONCE}` })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('refuses a missing or malformed nonce (spec-enforced)', async () => {
    for (const nonce of ['', 'short', 'has spaces in it but long enough']) {
      const res = await built.app.inject({ method: 'GET', url: `/ops/auth/github/start?return_to=${encodeURIComponent(ORIGIN)}&nonce=${encodeURIComponent(nonce)}` })
      expect(res.statusCode, JSON.stringify(nonce)).toBe(400)
    }
  })
})

describe('ops console — GET /ops/auth/github/callback', () => {
  it('signs an allowlisted founder in: token + nonce in the fragment, one sign_in audit row, GitHub token discarded', async () => {
    const github = githubFake()
    const { app, audits, logs } = await build({ fetchImpl: github.fetchImpl })
    const state = await startState(app)
    const res = await app.inject({ method: 'GET', url: `/ops/auth/github/callback?code=abc&state=${encodeURIComponent(state)}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    const location = String(res.headers.location)
    expect(location.startsWith(`${ORIGIN}/#`)).toBe(true)
    const fragment = fragmentOf(location)
    expect(fragment.get('nonce')).toBe(NONCE)
    expect(verifyOpsToken({ secret: OPS.jwtSecret, issuer: API }, fragment.get('token') ?? '')).toMatchObject({ githubId: '111', login: 'founder' })

    expect(audits).toEqual([{ operatorGithubId: 111, operatorLogin: 'founder', action: 'sign_in', requestId: expect.any(String) }])
    // The code exchange named the registered redirect_uri.
    const exchange = github.calls.find((c) => c.url.startsWith('https://github.com/login/oauth/access_token'))
    expect(new URLSearchParams(String(exchange?.init?.body)).get('redirect_uri')).toBe(`${API}${OPS_CALLBACK_PATH}`)
    // GitHub's token went to GET /user and nowhere else.
    for (const where of [location, JSON.stringify(audits), logs.join('\n'), res.body]) {
      expect(where).not.toContain(GITHUB_ACCESS_TOKEN)
    }
    await app.close()
  })

  it('refuses an unlisted GitHub id with an error fragment and a sign_in_denied row', async () => {
    const { app, audits } = await build({ fetchImpl: githubFake({ id: 999, login: 'stranger', two_factor_authentication: true }).fetchImpl })
    const res = await app.inject({ method: 'GET', url: `/ops/auth/github/callback?code=abc&state=${encodeURIComponent(await startState(app))}` })
    expect(res.statusCode).toBe(302)
    const fragment = fragmentOf(String(res.headers.location))
    expect(fragment.get('error')).toBe('not_allowed')
    expect(fragment.get('token')).toBeNull()
    expect(audits).toEqual([expect.objectContaining({ operatorGithubId: 999, action: 'sign_in_denied', detail: 'not_allowed' })])
    await app.close()
  })

  it('refuses an allowlisted founder whose GitHub reports 2FA off', async () => {
    const { app, audits } = await build({ fetchImpl: githubFake({ id: 111, login: 'founder', two_factor_authentication: false }).fetchImpl })
    const res = await app.inject({ method: 'GET', url: `/ops/auth/github/callback?code=abc&state=${encodeURIComponent(await startState(app))}` })
    expect(fragmentOf(String(res.headers.location)).get('error')).toBe('two_factor_required')
    expect(audits).toEqual([expect.objectContaining({ action: 'sign_in_denied', detail: 'two_factor_required' })])
    await app.close()
  })

  it('admits an allowlisted founder when GitHub does not report 2FA status', async () => {
    const { app } = await build({ fetchImpl: githubFake({ id: 111, login: 'founder' }).fetchImpl })
    const res = await app.inject({ method: 'GET', url: `/ops/auth/github/callback?code=abc&state=${encodeURIComponent(await startState(app))}` })
    expect(fragmentOf(String(res.headers.location)).get('token')).toBeTruthy()
    await app.close()
  })

  it('fails closed when the audit write fails: 503, no redirect, no token', async () => {
    const { app } = await build({
      audit: async () => {
        throw new Error('db down')
      },
    })
    const res = await app.inject({ method: 'GET', url: `/ops/auth/github/callback?code=abc&state=${encodeURIComponent(await startState(app))}` })
    expect(res.statusCode).toBe(503)
    expect(res.headers.location).toBeUndefined()
    expect(res.body).not.toContain('"token"')
    expect(res.body).not.toContain('eyJ')
    await app.close()
  })

  it('refuses a missing, forged, expired or no-longer-allowed state with 400 and no redirect', async () => {
    const t0 = Date.now()
    const { app } = await build({ now: () => t0 })
    const good = await startState(app)
    const forged = createSigner({ key: 'not-the-ops-secret', aud: 'haven-ops-oauth-state', iss: API, expiresIn: 60_000 })({
      purpose: 'ops_oauth_state',
      origin: ORIGIN,
      nonce: NONCE,
    })
    // An ops TOKEN is not a state: different audience and purpose.
    const notAState = tokenFor(111)
    for (const state of ['', forged, notAState]) {
      const res = await app.inject({ method: 'GET', url: `/ops/auth/github/callback?code=abc&state=${encodeURIComponent(state)}` })
      expect(res.statusCode, state.slice(0, 20)).toBe(400)
      expect(res.headers.location).toBeUndefined()
    }
    await app.close()

    const later = await build({ now: () => t0 + 11 * 60 * 1000 })
    const expired = await later.app.inject({ method: 'GET', url: `/ops/auth/github/callback?code=abc&state=${encodeURIComponent(good)}` })
    expect(expired.statusCode).toBe(400)
    await later.app.close()

    const narrowed = await build({ ops: { ...OPS, redirectOrigins: ['https://other.example.com'] }, now: () => t0 })
    const dropped = await narrowed.app.inject({ method: 'GET', url: `/ops/auth/github/callback?code=abc&state=${encodeURIComponent(good)}` })
    expect(dropped.statusCode).toBe(400)
    await narrowed.app.close()
  })

  it('sends GitHub-side failures back to the app as error codes without calling GitHub needlessly', async () => {
    const declined = githubFake()
    let built = await build({ fetchImpl: declined.fetchImpl })
    let res = await built.app.inject({ method: 'GET', url: `/ops/auth/github/callback?error=access_denied&error_description=x&error_uri=y&state=${encodeURIComponent(await startState(built.app))}` })
    expect(fragmentOf(String(res.headers.location)).get('error')).toBe('github_denied')
    expect(declined.calls).toEqual([])
    expect(built.audits).toEqual([])
    await built.app.close()

    built = await build({ fetchImpl: githubFake('fail').fetchImpl })
    res = await built.app.inject({ method: 'GET', url: `/ops/auth/github/callback?code=abc&state=${encodeURIComponent(await startState(built.app))}` })
    expect(fragmentOf(String(res.headers.location)).get('error')).toBe('github_unavailable')
    await built.app.close()
  })
})

describe('ops console — GET /ops/me and the ops token', () => {
  let built: Built
  beforeAll(async () => {
    built = await build()
  })
  afterAll(async () => built.app.close())

  const me = (authorization?: string) =>
    built.app.inject({ method: 'GET', url: '/ops/me', headers: authorization ? { authorization } : {} })

  it('returns the operator for a valid ops token', async () => {
    const res = await me(`Bearer ${tokenFor(111)}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ github_id: '111', login: 'user-111', expires_at: expect.any(String) })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('refuses a missing token, a dashboard JWT, a wrong audience/issuer/algorithm, an expired token and an unlisted id', async () => {
    const dash = Fastify()
    await dash.register(fastifyJwt, { secret: DASH_SECRET })
    await dash.ready()
    const dashboardJwt = dash.jwt.sign({ sub: 'user-1', email: 'a@b.example' })
    await dash.close()
    const base = { sub: '111', login: 'x', purpose: 'ops' }
    const wrongAud = createSigner({ key: OPS.jwtSecret, aud: 'not-haven-ops', iss: API, expiresIn: 60_000 })(base)
    const wrongIss = createSigner({ key: OPS.jwtSecret, aud: 'haven-ops', iss: 'https://other-backend.example', expiresIn: 60_000 })(base)
    const wrongAlg = createSigner({ key: OPS.jwtSecret, algorithm: 'HS512', aud: 'haven-ops', iss: API, expiresIn: 60_000 })(base)
    const wrongPurpose = createSigner({ key: OPS.jwtSecret, aud: 'haven-ops', iss: API, expiresIn: 60_000 })({ ...base, purpose: 'owner_cli' })
    const expired = tokenFor(111, OPS, Date.now() - 9 * 60 * 60 * 1000)
    for (const [label, header] of [
      ['missing', undefined],
      ['not bearer', `Token ${tokenFor(111)}`],
      ['dashboard JWT', `Bearer ${dashboardJwt}`],
      ['wrong aud', `Bearer ${wrongAud}`],
      ['wrong iss', `Bearer ${wrongIss}`],
      ['wrong alg', `Bearer ${wrongAlg}`],
      ['wrong purpose', `Bearer ${wrongPurpose}`],
      ['expired', `Bearer ${expired}`],
      ['unlisted id', `Bearer ${tokenFor(222)}`],
    ] as const) {
      const res = await me(header)
      expect(res.statusCode, label).toBe(401)
    }
  })

  it('re-checks the allowlist on every request: dropping an id revokes its live token', async () => {
    const live = tokenFor(111)
    const narrowed = await build({ ops: { ...OPS, allowedGithubIds: [333] } })
    const res = await narrowed.app.inject({ method: 'GET', url: '/ops/me', headers: { authorization: `Bearer ${live}` } })
    expect(res.statusCode).toBe(401)
    await narrowed.app.close()
  })
})

describe('ops console — an ops token is refused on every customer route', () => {
  async function customerApp(secret: string): Promise<FastifyInstance> {
    const app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret })
    app.get('/owner', { onRequest: authMiddleware }, async () => ({ ok: true }))
    app.get('/agent', { onRequest: agentAuthMiddleware }, async () => ({ ok: true }))
    app.get('/either', { onRequest: eitherAuth }, async () => ({ ok: true }))
    await app.ready()
    return app
  }

  it.each([
    ['its own secret (the configured case)', DASH_SECRET],
    ['the SAME secret as the dashboard — the purpose claim still refuses it', OPS.jwtSecret],
  ])('signed with %s', async (_label, dashboardSecret) => {
    const app = await customerApp(dashboardSecret)
    const authorization = `Bearer ${tokenFor(111)}`
    for (const url of ['/owner', '/agent', '/either']) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization } })
      expect(res.statusCode, url).toBe(401)
    }
    // Positive control: the same app admits a real dashboard JWT on the owner route.
    const dashboardJwt = app.jwt.sign({ sub: 'user-1', email: 'a@b.example' })
    const ok = await app.inject({ method: 'GET', url: '/owner', headers: { authorization: `Bearer ${dashboardJwt}` } })
    expect(ok.statusCode).toBe(200)
    await app.close()
  })
})

describe('ops console — POST /ops/reveal without a read-only database', () => {
  it('is off (404) until #3510 provides the read-only role', async () => {
    const { app, audits } = await build({ readDb: null })
    const res = await app.inject({
      method: 'POST',
      url: '/ops/reveal',
      headers: { authorization: `Bearer ${tokenFor(111)}` },
      payload: { target_type: 'user', target_id: '00000000-0000-4000-8000-000000000000', field: 'email' },
    })
    expect(res.statusCode).toBe(404)
    expect(audits).toEqual([])
    await app.close()
  })

  it('refuses a pair outside the closed enum and an unauthenticated caller', async () => {
    const { app } = await build({ readDb: db })
    const auth = { authorization: `Bearer ${tokenFor(111)}` }
    const id = '00000000-0000-4000-8000-000000000000'
    for (const payload of [
      { target_type: 'user', target_id: id, field: 'password_hash' },
      { target_type: 'agent', target_id: id, field: 'email' },
      { target_type: 'user', target_id: 'not-a-uuid', field: 'email' },
      { target_type: 'user', target_id: id, field: 'email', extra: true },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/ops/reveal', headers: auth, payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    const anon = await app.inject({ method: 'POST', url: '/ops/reveal', payload: { target_type: 'user', target_id: id, field: 'email' } })
    expect(anon.statusCode).toBe(401)
    await app.close()
  })
})

describeDb('ops console — audit rows and reveal against a real database', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  let built: Built | null = null
  afterEach(async () => {
    await built?.app.close()
    built = null
  })

  async function seedUser(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Ada Lovelace') RETURNING id`,
      [`ops-reveal-${Date.now()}@test.example`],
    )
    return rows[0].id
  }

  async function auditRows(): Promise<Record<string, unknown>[]> {
    const { rows } = await db.query(`SELECT * FROM ops_access_log ORDER BY created_at`)
    return rows
  }

  it('writes exactly one reveal row and returns the value', async () => {
    built = await build({ readDb: db, audit: undefined })
    const userId = await seedUser()
    const res = await built.app.inject({
      method: 'POST',
      url: '/ops/reveal',
      headers: { authorization: `Bearer ${tokenFor(111)}` },
      payload: { target_type: 'user', target_id: userId, field: 'email' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ target_type: 'user', target_id: userId, field: 'email', value: expect.stringMatching(/^ops-reveal-/) })
    expect(await auditRows()).toEqual([
      expect.objectContaining({ operator_github_id: '111', action: 'reveal', target_type: 'user', target_id: userId, field: 'email' }),
    ])
  })

  it('writes one sign_in_denied row for a refused sign-in, through the real repository', async () => {
    built = await build({ audit: undefined, fetchImpl: githubFake({ id: 999, login: 'stranger' }).fetchImpl })
    const res = await built.app.inject({ method: 'GET', url: `/ops/auth/github/callback?code=abc&state=${encodeURIComponent(await startState(built.app))}` })
    expect(fragmentOf(String(res.headers.location)).get('error')).toBe('not_allowed')
    expect(await auditRows()).toEqual([
      expect.objectContaining({ operator_github_id: '999', operator_login: 'stranger', action: 'sign_in_denied', detail: 'not_allowed' }),
    ])
  })

  it('answers 503 with no value when the audit write fails', async () => {
    built = await build({
      readDb: db,
      audit: async () => {
        throw new Error('audit insert failed')
      },
    })
    const userId = await seedUser()
    const res = await built.app.inject({
      method: 'POST',
      url: '/ops/reveal',
      headers: { authorization: `Bearer ${tokenFor(111)}` },
      payload: { target_type: 'user', target_id: userId, field: 'email' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.body).not.toContain('ops-reveal-')
  })

  it('404s a reveal of a record that does not exist, and audits nothing', async () => {
    built = await build({ readDb: db, audit: undefined })
    const res = await built.app.inject({
      method: 'POST',
      url: '/ops/reveal',
      headers: { authorization: `Bearer ${tokenFor(111)}` },
      payload: { target_type: 'user', target_id: '00000000-0000-4000-8000-000000000000', field: 'name' },
    })
    expect(res.statusCode).toBe(404)
    expect(await auditRows()).toEqual([])
  })
})
