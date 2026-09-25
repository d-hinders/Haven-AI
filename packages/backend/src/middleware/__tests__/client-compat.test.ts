/**
 * Client-version signal (#3303) — the hook wiring, with fake collaborators.
 *
 * Routing (which route refuses which package), the handler-never-runs
 * guarantee, and the hint injection are decided here, where every branch can
 * be driven directly. What the database does — the replay lookup and "nothing
 * written" — is proven on real Postgres in
 * `routes/__tests__/client-compat-refusal.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  PUBLISHED_CLIENT_PACKAGES,
  type ClientCompatEntry,
  type PublishedClientPackage,
} from '@haven_ai/core'
import {
  CLIENT_OUTDATED_STATUS,
  CLIENT_REFUSAL_POINTS,
  findRefusalPoint,
  injectClientUpdate,
  registerClientCompatHooks,
  upgradeCommandFor,
  type ClientCompatDeps,
  type ClientUpdateHint,
} from '../client-compat.js'

function table(
  overrides: Partial<Record<PublishedClientPackage, Partial<ClientCompatEntry>>> = {},
): Record<PublishedClientPackage, ClientCompatEntry> {
  const out = {} as Record<PublishedClientPackage, ClientCompatEntry>
  for (const pkg of PUBLISHED_CLIENT_PACKAGES) {
    out[pkg] = { recommended_version: null, min_version: null, ...overrides[pkg] }
  }
  return out
}

const AGENT = { id: 'agent-1', user_id: 'user-1', chain_id: 8453 }

interface Harness {
  app: FastifyInstance
  handled: string[]
  deps: ClientCompatDeps & { loadRail: ReturnType<typeof vi.fn>; findReplay: ReturnType<typeof vi.fn> }
}

/** Every refusal point plus the non-refusal money routes, each recording that its handler ran. */
async function harness(
  compat: Record<PublishedClientPackage, ClientCompatEntry>,
  opts: { rail?: 'delegation' | 'retired'; replay?: boolean; agent?: boolean } = {},
): Promise<Harness> {
  const handled: string[] = []
  const deps = {
    table: compat,
    loadRail: vi.fn(async () => opts.rail ?? 'delegation'),
    findReplay: vi.fn(async () => opts.replay ?? false),
  }
  const app = Fastify({ logger: false })
  if (opts.agent !== false) {
    app.addHook('onRequest', async (request) => {
      ;(request as unknown as { agent: typeof AGENT }).agent = AGENT
    })
  }
  registerClientCompatHooks(app, deps)
  const record = (label: string) => async () => {
    handled.push(label)
    return { ok: true, handled: label }
  }
  await app.register(
    async (p) => {
      p.post('/', record('POST /payments'))
      p.get('/:id/sign-context', record('GET /payments/:id/sign-context'))
      p.post('/:id/sign', record('POST /payments/:id/sign'))
      p.get('/:id', record('GET /payments/:id'))
    },
    { prefix: '/payments' },
  )
  await app.register(
    async (p) => {
      p.post('/', record('POST /x402'))
      p.post('/authorize', record('POST /x402/authorize'))
      p.get('/:id/sign-context', record('GET /x402/:id/sign-context'))
      p.post('/:id/settle', record('POST /x402/:id/settle'))
    },
    { prefix: '/x402' },
  )
  await app.register(
    async (p) => {
      p.post('/send', record('POST /machine-payments/send'))
      p.post('/sweep/prepare', record('POST /machine-payments/sweep/prepare'))
      p.post('/sweep/submit', record('POST /machine-payments/sweep/submit'))
      p.post('/evidence', record('POST /machine-payments/evidence'))
      p.get('/list', async () => [1, 2, 3])
      p.get('/text', async (_req, reply) => reply.type('text/plain').send('plain'))
    },
    { prefix: '/machine-payments' },
  )
  return { app, handled, deps }
}

const MCP_OLD = '@haven_ai/mcp/0.4.0-alpha.0'
const SIGNER_OLD = '@haven_ai/signer/0.4.0-alpha.0'
const FLAGGED = table({
  '@haven_ai/mcp': { recommended_version: '0.6.0', min_version: '0.5.0' },
  '@haven_ai/signer': { recommended_version: '0.6.0', min_version: '0.5.0' },
})

describe('refusal points', () => {
  it.each([
    ['POST', '/payments'],
    ['POST', '/payments/'],
    ['POST', '/x402'],
    ['POST', '/x402/'],
    ['POST', '/x402/authorize'],
    ['POST', '/machine-payments/send'],
  ] as const)('%s %s refuses an API client below a set minimum — and the handler never runs', async (method, url) => {
    const { app, handled } = await harness(FLAGGED)
    const res = await app.inject({ method, url, headers: { 'x-haven-client': MCP_OLD }, payload: {} })
    expect(res.statusCode).toBe(CLIENT_OUTDATED_STATUS)
    const body = res.json()
    expect(body.error_code).toBe('client_outdated')
    expect(body.next_action).toBe('stop_and_tell_user')
    expect(body.next_tool_omitted_reason).toMatch(/npx -y @haven_ai\/connect@/)
    expect(body.client_update).toEqual({
      package: '@haven_ai/mcp',
      current: '0.4.0-alpha.0',
      recommended: '0.6.0',
      min_version: '0.5.0',
      required: true,
      upgrade_command: upgradeCommandFor('@haven_ai/mcp'),
      notes_url: null,
    })
    expect(handled).toEqual([])
    await app.close()
  })

  it.each(['/payments/pi-1/sign-context', '/x402/pi-1/sign-context'])(
    'GET %s refuses the signer below its minimum — and nothing reaches the handler',
    async (url) => {
      const { app, handled } = await harness(FLAGGED)
      const res = await app.inject({ method: 'GET', url, headers: { 'x-haven-client': SIGNER_OLD } })
      expect(res.statusCode).toBe(CLIENT_OUTDATED_STATUS)
      expect(res.json().client_update.package).toBe('@haven_ai/signer')
      expect(handled).toEqual([])
      await app.close()
    },
  )

  it('does not refuse the signer at an initiating route, nor an API client at sign-context', async () => {
    const { app, handled } = await harness(FLAGGED)
    const a = await app.inject({ method: 'POST', url: '/payments', headers: { 'x-haven-client': SIGNER_OLD }, payload: {} })
    const b = await app.inject({ method: 'GET', url: '/x402/pi-1/sign-context', headers: { 'x-haven-client': MCP_OLD } })
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    expect(handled).toEqual(['POST /payments', 'GET /x402/:id/sign-context'])
    // Not refused here, but still below a minimum: the hint says so.
    expect(a.json().client_update.required).toBe(true)
    expect(b.json().client_update.required).toBe(true)
    await app.close()
  })

  it.each([
    ['POST', '/machine-payments/sweep/prepare'],
    ['POST', '/machine-payments/sweep/submit'],
    ['POST', '/machine-payments/evidence'],
    ['POST', '/payments/pi-1/sign'],
    ['POST', '/x402/pi-1/settle'],
    ['GET', '/payments/pi-1'],
  ] as const)('%s %s is never a refusal point — it would strand funds or a prepared payment', async (method, url) => {
    const { app, handled } = await harness(FLAGGED)
    for (const header of [MCP_OLD, SIGNER_OLD]) {
      const res = await app.inject({ method, url, headers: { 'x-haven-client': header }, payload: method === 'POST' ? {} : undefined })
      expect(res.statusCode).toBe(200)
    }
    expect(handled).toHaveLength(2)
    await app.close()
  })

  it('pins the point list: exactly the four initiating routes and the two sign-context reads', () => {
    expect(CLIENT_REFUSAL_POINTS.map((p) => `${p.method} ${p.url}`).sort()).toEqual([
      'GET /payments/:id/sign-context',
      'GET /x402/:id/sign-context',
      'POST /machine-payments/send',
      'POST /payments',
      'POST /x402',
      'POST /x402/authorize',
    ])
    expect(findRefusalPoint('POST', '/payments/')?.url).toBe('/payments')
    expect(findRefusalPoint('GET', '/payments')).toBeUndefined()
  })
})

describe('never refused (owner decision 2026-09-25)', () => {
  it.each([
    ['no header', undefined],
    ['a malformed header', '@haven_ai/mcp/latest'],
    ['a dev-channel snapshot', '@haven_ai/mcp/0.0.0-dev.20260925'],
    ['a package outside the published five', '@haven_ai/mcp-server/0.0.1'],
  ])('%s passes even with every minimum set', async (_label, header) => {
    const everything = table(
      Object.fromEntries(PUBLISHED_CLIENT_PACKAGES.map((p) => [p, { min_version: '99.0.0', recommended_version: '99.0.0' }])),
    )
    const { app, handled, deps } = await harness(everything)
    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: header ? { 'x-haven-client': header } : {},
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, handled: 'POST /payments' })
    expect(handled).toEqual(['POST /payments'])
    // Not even the refusal-branch lookups run.
    expect(deps.loadRail).not.toHaveBeenCalled()
    await app.close()
  })

  it('a client far below recommended with NO minimum pays and gets required:false', async () => {
    const { app, handled } = await harness(table({ '@haven_ai/mcp': { recommended_version: '9.0.0' } }))
    const res = await app.inject({ method: 'POST', url: '/x402/authorize', headers: { 'x-haven-client': MCP_OLD }, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(handled).toEqual(['POST /x402/authorize'])
    expect(res.json().client_update).toMatchObject({ required: false, recommended: '9.0.0', min_version: null })
    await app.close()
  })

  it('an agent on a retired rail gets the handler (its 410), not client_outdated', async () => {
    const { app, handled, deps } = await harness(FLAGGED, { rail: 'retired' })
    const res = await app.inject({ method: 'POST', url: '/payments', headers: { 'x-haven-client': MCP_OLD }, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(handled).toEqual(['POST /payments'])
    expect(deps.loadRail).toHaveBeenCalledOnce()
    await app.close()
  })

  it('an idempotent replay of an accepted request reaches the handler; the key is read from the route\'s own field', async () => {
    const { app, handled, deps } = await harness(FLAGGED, { replay: true })
    await app.inject({ method: 'POST', url: '/payments', headers: { 'x-haven-client': MCP_OLD }, payload: { idempotency_key: 'k-1' } })
    await app.inject({ method: 'POST', url: '/x402/authorize', headers: { 'x-haven-client': MCP_OLD }, payload: { idempotencyKey: 'k-2' } })
    expect(handled).toEqual(['POST /payments', 'POST /x402/authorize'])
    expect(deps.findReplay.mock.calls).toEqual([
      ['send_intent', AGENT.id, 'k-1'],
      ['x402_intent', AGENT.id, 'k-2'],
    ])
    await app.close()
  })

  it('a key with no accepted row does not unlock the route', async () => {
    const { app, handled } = await harness(FLAGGED, { replay: false })
    const res = await app.inject({ method: 'POST', url: '/payments', headers: { 'x-haven-client': MCP_OLD }, payload: { idempotency_key: 'fresh' } })
    expect(res.statusCode).toBe(CLIENT_OUTDATED_STATUS)
    expect(handled).toEqual([])
    await app.close()
  })

  it('never refuses a request it cannot attribute to an agent', async () => {
    const { app, handled } = await harness(FLAGGED, { agent: false })
    const res = await app.inject({ method: 'POST', url: '/payments', headers: { 'x-haven-client': MCP_OLD }, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(handled).toEqual(['POST /payments'])
    await app.close()
  })
})

describe('hint', () => {
  it('is absent for a current client and for the shipped all-null table', async () => {
    const { app } = await harness(table())
    const res = await app.inject({ method: 'GET', url: '/payments/pi-1', headers: { 'x-haven-client': MCP_OLD } })
    expect(res.json()).toEqual({ ok: true, handled: 'GET /payments/:id' })
    await app.close()
  })

  it('leaves a JSON array and a non-JSON body untouched', async () => {
    const { app } = await harness(FLAGGED)
    const list = await app.inject({ method: 'GET', url: '/machine-payments/list', headers: { 'x-haven-client': MCP_OLD } })
    const text = await app.inject({ method: 'GET', url: '/machine-payments/text', headers: { 'x-haven-client': MCP_OLD } })
    expect(list.json()).toEqual([1, 2, 3])
    expect(text.body).toBe('plain')
    await app.close()
  })

  const HINT: ClientUpdateHint = {
    package: '@haven_ai/sdk',
    current: '0.1.0',
    recommended: '0.2.0',
    min_version: null,
    required: false,
    upgrade_command: 'npm install @haven_ai/sdk@alpha',
    notes_url: null,
  }

  it('injectClientUpdate only rewrites a JSON object and never overwrites an existing client_update', () => {
    expect(JSON.parse(injectClientUpdate('{"a":1}', 'application/json; charset=utf-8', HINT) as string)).toEqual({
      a: 1,
      client_update: HINT,
    })
    expect(injectClientUpdate('{"client_update":{"x":1}}', 'application/json', HINT)).toBe('{"client_update":{"x":1}}')
    expect(injectClientUpdate('[1]', 'application/json', HINT)).toBe('[1]')
    expect(injectClientUpdate('{not json', 'application/json', HINT)).toBe('{not json')
    expect(injectClientUpdate('{"a":1}', 'text/plain', HINT)).toBe('{"a":1}')
    const buffer = Buffer.from('{"a":1}')
    expect(injectClientUpdate(buffer, 'application/json', HINT)).toBe(buffer)
  })
})

describe('upgradeCommandFor', () => {
  it('names the deployment channel, and routes the connector-installed runtimes through a connector re-run', () => {
    expect(upgradeCommandFor('@haven_ai/signer', 'dev')).toBe('npx -y @haven_ai/connect@dev')
    expect(upgradeCommandFor('@haven_ai/mcp', 'dev')).toBe('npx -y @haven_ai/connect@dev')
    expect(upgradeCommandFor('@haven_ai/connect', 'alpha')).toBe('npx -y @haven_ai/connect@alpha')
    expect(upgradeCommandFor('@haven_ai/cli', 'alpha')).toBe('npx -y @haven_ai/cli@alpha')
    expect(upgradeCommandFor('@haven_ai/sdk', 'alpha')).toBe('npm install @haven_ai/sdk@alpha')
  })
})
