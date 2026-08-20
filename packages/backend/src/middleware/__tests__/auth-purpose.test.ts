/**
 * #1640: a single-purpose token is not a session credential.
 *
 * The Fortnox OAuth flow signs a `state` with the app's own JWT secret and
 * ships it through a URL query string. It verifies like any other token, so
 * before this guard it was accepted as an ordinary Bearer credential on every
 * authenticated route for its full 10-minute life — in browser history, in
 * the provider's access logs, and in any proxy log along the way.
 *
 * These tests are written against the REAL state the flow issues, not a
 * hand-made lookalike, so they keep testing the actual thing if the claim
 * shape ever changes.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authMiddleware } from '../auth.js'

const SECRET = 'test-secret'

/**
 * The exact claim shape routes/fortnox.ts signs for the OAuth handshake.
 * The cast mirrors the route's own: @fastify/jwt pins the payload type to
 * { sub, email }, so a purpose-carrying token needs it in both places.
 */
const OAUTH_STATE = { sub: 'user-1', purpose: 'fortnox_oauth' } as unknown as {
  sub: string
  email: string
}

describe('authMiddleware refuses purpose-scoped tokens (#1640)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: SECRET })
    // A stand-in for any ordinary authenticated route.
    app.get('/protected', { onRequest: authMiddleware }, async (request) => ({
      sub: (request.user as { sub: string }).sub,
    }))
    await app.ready()
  })

  afterAll(async () => app.close())

  it('an ordinary session token still works', async () => {
    const token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' }, { expiresIn: '7d' })
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().sub).toBe('user-1')
  })

  it('MUTATION PROOF: the OAuth state token is refused — it verifies, and that is not enough', async () => {
    // Signed with the SAME secret and genuinely valid; the only thing setting
    // it apart is the purpose claim. Remove the guard in auth.ts and this
    // request returns 200, which is exactly the bug #1640 records.
    const state = app.jwt.sign(OAUTH_STATE, { expiresIn: '10m' })

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${state}` },
    })

    expect(res.statusCode).toBe(401)
  })

  it('refuses ANY purpose, not just the one that exists today', async () => {
    // The guard is written as "carries a purpose" rather than "carries
    // fortnox_oauth", so the next single-purpose token is safe by default
    // instead of by someone remembering to add it here.
    const future = app.jwt.sign(
      { sub: 'user-1', purpose: 'some_future_flow' } as unknown as { sub: string; email: string },
      { expiresIn: '5m' },
    )

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${future}` },
    })

    expect(res.statusCode).toBe(401)
  })

  it('there is exactly ONE jwtVerify in the source — a second door is how this bug happened', async () => {
    // routes/catalog.ts used to verify the token itself, so it silently
    // missed this guard: a purpose token was refused everywhere else and
    // still accepted there. A source-text check, because the property is
    // about what every FUTURE writer must not do, and no runtime test can
    // observe a hand-rolled verify nobody has written yet.
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry !== 'node_modules') walk(full)
          continue
        }
        if (!entry.endsWith('.ts') || entry.includes('.test.')) continue
        const text = readFileSync(full, 'utf8')
        // The middleware itself is the one legitimate caller.
        if (full.endsWith('middleware/auth.ts')) continue
        if (/(?<!\/\/.*)\brequest\.jwtVerify\(/.test(text)) offenders.push(path.relative(src, full))
      }
    }
    walk(src)

    expect(offenders).toEqual([])
  })

  it('says nothing about WHICH kind of token was presented', async () => {
    // A rejected purpose token and a garbage token answer identically: the
    // caller is unauthenticated either way, and the difference is not theirs
    // to learn.
    const state = app.jwt.sign(OAUTH_STATE, { expiresIn: '10m' })

    const [purposeRes, garbageRes] = await Promise.all([
      app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${state}` } }),
      app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer not-a-token' } }),
    ])

    expect(purposeRes.statusCode).toBe(garbageRes.statusCode)
    expect(purposeRes.json()).toEqual(garbageRes.json())
  })
})
