/**
 * The sweep-recovery exemption in `agentAuthMiddleware` is decided from the
 * MATCHED route, not from the request-target string.
 *
 * A paused, pending, archived or revoked agent key stays usable for exactly
 * one thing: `POST /machine-payments/sweep/prepare` and `/sweep/submit`, so a
 * stranded delegate balance can always be recovered. Every other route must
 * give such a key its normal refusal.
 *
 * Why a raw socket and not `app.inject`: the request-target a client writes
 * reaches `request.url` as sent, while the router matches only the path part
 * of it, so the two can disagree about which route a request is. Node's HTTP
 * parser keeps a `#…` suffix in the request-target; light-my-request parses
 * the URL before dispatch and drops it, so an injected request never presents
 * that shape to the server. The last case below pins that difference so these
 * cases are not "simplified" back to `inject`.
 *
 * Real Postgres for the agent rows (the middleware's own SQL), the real route
 * modules, a real listening server. Only the chain balance read is stubbed —
 * it is a collaborator this suite does not own, and the network guard refuses
 * it anyway.
 */
import net from 'node:net'
import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'

vi.mock('../../infra/chain/relayer-reads.js', () => ({
  getTokenBalance: vi.fn(async () => 0n),
}))

const x402Routes = (await import('../../routes/x402.js')).default
const machinePaymentRoutes = (await import('../../routes/machine-payments.js')).default

const SPEND_PROBE_STATUS = 299

/**
 * The spend route itself is not run: a root `preValidation` probe answers for
 * it once the request has passed `onRequest` (where agent auth lives). A
 * response from the probe therefore means "agent auth accepted this key for
 * the x402 spend route" — the exact boundary under test — without building a
 * payment intent. The sweep routes are not probed; their real handlers run.
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.addHook('preValidation', async (request, reply) => {
    if (request.routeOptions.url === '/x402/authorize') {
      return reply.code(SPEND_PROBE_STATUS).send({
        reached: request.routeOptions.url,
        agent_status: request.agent?.status ?? null,
      })
    }
  })
  await app.register(x402Routes, { prefix: '/x402' })
  await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
  await app.listen({ host: '127.0.0.1', port: 0 })
  return app
}

interface RawResponse {
  statusCode: number
  body: Record<string, unknown>
}

/** One HTTP/1.1 request written byte for byte — the request-target is not normalised. */
function rawPost(app: FastifyInstance, target: string, apiKey: string, body: unknown = {}): Promise<RawResponse> {
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('server is not listening on a port')
  const payload = JSON.stringify(body)
  const request =
    `POST ${target} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${address.port}\r\n` +
    `Authorization: Bearer ${apiKey}\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    'Connection: close\r\n' +
    '\r\n' +
    payload
  return new Promise((resolve, reject) => {
    const socket = net.connect(address.port, '127.0.0.1')
    let received = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { received += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      const [head, ...rest] = received.split('\r\n\r\n')
      const statusLine = head.split('\r\n', 1)[0]
      const statusCode = Number(statusLine.split(' ')[1])
      const text = rest.join('\r\n\r\n')
      let parsed: Record<string, unknown> = {}
      try {
        parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
      } catch {
        parsed = { unparsed: text }
      }
      resolve({ statusCode, body: parsed })
    })
    socket.write(request)
  })
}

const DELEGATE = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const NONCE = `0x${'ab'.repeat(32)}`
const SIG = `0x${'cd'.repeat(65)}`

let seq = 0

/** A user, its bound smart account on Base, and one agent with the given status. */
async function seedAgent(status: 'active' | 'paused' | 'revoked'): Promise<string> {
  seq += 1
  const apiKey = `sk_agent_recovery_route_${status}_${seq}_${Date.now()}`
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`recovery-route-${status}-${seq}-${Date.now()}@test.example`],
  )
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id) VALUES ($1, $2, 8453) RETURNING id`,
    [user.rows[0].id, SAFE],
  )
  await db.query(
    `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
     VALUES ($1, $2, 'Recovery route agent', $3, $4, 'sk_agent_rec', $5)`,
    [user.rows[0].id, account.rows[0].id, DELEGATE, createHash('sha256').update(apiKey).digest('hex'), status],
  )
  return apiKey
}

/** The refusal each status gets on any non-recovery route. */
const REFUSAL: Record<'paused' | 'revoked', { statusCode: number; error: string }> = {
  paused: { statusCode: 403, error: 'agent_paused' },
  revoked: { statusCode: 401, error: 'Invalid or revoked API key' },
}

describeDb('agent auth decides the recovery exemption from the matched route', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = await buildApp()
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('control: an active key reaches the spend route', async () => {
    const key = await seedAgent('active')
    const res = await rawPost(app, '/x402/authorize', key)
    expect(res.statusCode).toBe(SPEND_PROBE_STATUS)
    expect(res.body).toEqual({ reached: '/x402/authorize', agent_status: 'active' })
  })

  for (const status of ['paused', 'revoked'] as const) {
    for (const suffix of ['/sweep/prepare', '/sweep/submit']) {
      it(`a ${status} key is refused on the spend route when the request-target carries #${suffix}`, async () => {
        const key = await seedAgent(status)
        const res = await rawPost(app, `/x402/authorize#${suffix}`, key)
        expect(res.body.reached, 'the spend route must not be reached').toBeUndefined()
        expect(res.statusCode).toBe(REFUSAL[status].statusCode)
        expect(res.body.error).toBe(REFUSAL[status].error)
      })
    }

    it(`a ${status} key is refused on the plain spend route`, async () => {
      const key = await seedAgent(status)
      const res = await rawPost(app, '/x402/authorize', key)
      expect(res.statusCode).toBe(REFUSAL[status].statusCode)
      expect(res.body.error).toBe(REFUSAL[status].error)
    })

    it(`a ${status} key still recovers through the real POST /machine-payments/sweep/prepare`, async () => {
      const key = await seedAgent(status)
      const res = await rawPost(app, '/machine-payments/sweep/prepare', key)
      expect(res.statusCode).toBe(200)
      expect(res.body.nothing_stranded).toBe(true)
    })

    it(`a ${status} key still reaches the real POST /machine-payments/sweep/submit`, async () => {
      const key = await seedAgent(status)
      const res = await rawPost(app, '/machine-payments/sweep/submit', key, {
        signature: SIG,
        authorization: { nonce: NONCE },
      })
      // The handler's own answer for an unknown nonce: auth let the key through.
      expect(res.statusCode).toBe(404)
      expect(String(res.body.error)).toMatch(/No prepared sweep found/)
    })
  }

  it('light-my-request drops the fragment before dispatch, so only the raw socket can show this shape', async () => {
    const key = await seedAgent('paused')
    const injected = await app.inject({
      method: 'POST',
      url: '/x402/authorize#/sweep/prepare',
      headers: { authorization: `Bearer ${key}` },
      payload: {},
    })
    // Refused on every tree — inject never presents `#…` to the middleware.
    expect(injected.statusCode).toBe(403)
    expect(injected.json().error).toBe('agent_paused')
  })
})
