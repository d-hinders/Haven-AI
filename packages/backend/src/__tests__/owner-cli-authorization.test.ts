import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { describe, expect, it } from 'vitest'
import { authMiddleware } from '../middleware/auth.js'
import { OWNER_CLI_PURPOSE, allowOwnerCli } from '../middleware/owner-cli.js'

/**
 * The `owner_cli` token at the door (#2526).
 *
 * The census test proves the allow-LIST is a decision. This one proves the
 * MIDDLEWARE honours it — that an opted-in route lets the token through, that
 * an ordinary route does not, and that neither the #1640 refusal nor the
 * Fortnox single-purpose token changed behaviour.
 */

const SECRET = 'test-secret-2526-only'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(fastifyJwt, { secret: SECRET })
  // An allow-listed route and an ordinary one, side by side.
  // `/agents` carries NO marker: it is allowed because the list says so, which
  // is the real enforcement path. `/marked` carries the marker and no list
  // entry, covering the additive escape hatch.
  app.get('/agents', { preHandler: authMiddleware }, async () => ({ ok: true }))
  app.post('/agents/:id/rekey/start', { preHandler: authMiddleware }, async () => ({ ok: true }))
  app.get('/marked', { preHandler: authMiddleware, ...allowOwnerCli() }, async () => ({ ok: true }))
  return app
}

function sign(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>): string {
  return app.jwt.sign(payload as unknown as { sub: string; email: string }, { expiresIn: '7d' })
}

describe('owner_cli at the door', () => {
  it('reaches an OPTED-IN route', async () => {
    const app = await buildApp()
    const token = sign(app, { sub: 'u1', email: 'u@test.dev', purpose: OWNER_CLI_PURPOSE })
    const res = await app.inject({ method: 'GET', url: '/agents', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('is REFUSED on a route that did not opt in — the authority surface', async () => {
    // Re-keying is the shape that matters: an agent-driven session must not be
    // able to move a key. It refuses because nobody opted it in, not because
    // anyone remembered to deny it.
    const app = await buildApp()
    const token = sign(app, { sub: 'u1', email: 'u@test.dev', purpose: OWNER_CLI_PURPOSE })
    const res = await app.inject({
      method: 'POST',
      url: '/agents/abc/rekey/start',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('an ORDINARY session still reaches both — the opt-in grants, never restricts', async () => {
    // Positive control. If the marker had accidentally become a requirement,
    // the refusal above would pass for the wrong reason.
    const app = await buildApp()
    const token = sign(app, { sub: 'u1', email: 'u@test.dev' })
    for (const [method, url] of [['GET', '/agents'], ['POST', '/agents/abc/rekey/start']] as const) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode, `${method} ${url}`).toBe(200)
    }
    await app.close()
  })

  it('the LIST is the enforcement — an unmarked, listed route accepts the token', async () => {
    // `/agents` has no marker in this app. It is reachable because
    // OWNER_CLI_ALLOWED_ROUTES names it, so the census test guards the real
    // behaviour rather than a parallel document.
    const app = await buildApp()
    const token = sign(app, { sub: 'u1', email: 'u@test.dev', purpose: OWNER_CLI_PURPOSE })
    const res = await app.inject({ method: 'GET', url: '/agents', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('the marker still works for a route that is NOT on the list', async () => {
    // The escape hatch is additive, not an alternative.
    const app = await buildApp()
    const token = sign(app, { sub: 'u1', email: 'u@test.dev', purpose: OWNER_CLI_PURPOSE })
    const res = await app.inject({ method: 'GET', url: '/marked', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('a DIFFERENT purpose is refused even on an opted-in route', async () => {
    // The Fortnox OAuth state token verifies with the same secret. An opted-in
    // route must accept `owner_cli` specifically, not "any purpose".
    const app = await buildApp()
    const token = sign(app, { sub: 'u1', email: 'u@test.dev', purpose: 'fortnox_oauth' })
    const res = await app.inject({ method: 'GET', url: '/agents', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('#1640 holds: the refusal body is identical to a failed verification', async () => {
    const app = await buildApp()
    const garbage = await app.inject({
      method: 'POST',
      url: '/agents/abc/rekey/start',
      headers: { authorization: 'Bearer nonsense' },
    })
    const scoped = await app.inject({
      method: 'POST',
      url: '/agents/abc/rekey/start',
      headers: { authorization: `Bearer ${sign(app, { sub: 'u1', email: 'u@test.dev', purpose: OWNER_CLI_PURPOSE })}` },
    })
    expect(scoped.statusCode).toBe(garbage.statusCode)
    expect(scoped.body).toBe(garbage.body)
    await app.close()
  })
})
