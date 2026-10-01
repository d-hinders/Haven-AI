/**
 * #3459 — every throwaway agent a scenario creates is revoked when the
 * scenario ends, and a failed revoke is a warning, never a verdict.
 *
 * The API is a scripted global-fetch fake; what is pinned is which calls the
 * cleanup makes (and with whose token), never how the backend answers them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pass, fail, type ScenarioResult, type Scenario } from '../scenarios/types.js'
import { formatRunReport } from './run-report.js'
import { provisionThrowawayIdentity, withThrowawayIdentity } from './throwaway-identity.js'

const API = 'https://api.example'
const OPTIONS = { chainId: 84_532, budgetAtomic: '10000', label: 'cleanup' }
const TD = { domain: {}, types: { X: [{ name: 'a', type: 'uint256' }] }, message: { a: 1 } }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface FakeOpts {
  /** Answer for the grant build call. */
  build?: () => Response
  /** Answer for the activate call. */
  activate?: () => Response
  /** Answer for the agent revoke. */
  revoke?: () => Response
  /** Optional per-agent creation response (1 = primary, 2 = additional). */
  agent?: (index: number) => Response
}

/** Scripted API for the whole provisioning sequence; records every call. */
function installFake(opts: FakeOpts = {}) {
  const calls: Array<{ method: string; path: string; auth: string | null }> = []
  let agentCreates = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace(API, '')
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ method: init?.method ?? 'GET', path, auth: headers.authorization ?? null })
    if (path === '/auth/signup') return json({ token: 'jwt-throwaway' }, 201)
    if (path === '/accounts/hybrid') return json({}, 201)
    if (path === '/auth/me') {
      return json({ accounts: [{ id: 'safe-1', account_address: '0x' + '11'.repeat(20), account_type: 'delegator_hybrid' }] })
    }
    if (path === '/agents') {
      agentCreates += 1
      return opts.agent?.(agentCreates) ?? json({ id: `agent-${agentCreates}`, api_key: `sk-test-${agentCreates}` }, 201)
    }
    if (path.endsWith('/delegations/build')) {
      return opts.build?.() ?? json({ delegation_hash: '0xhash1', signing_payload: TD }, 201)
    }
    if (path.endsWith('/activate')) return opts.activate?.() ?? json({ activated: true })
    if (/^\/agents\/agent-\d+\/revoke$/.test(path)) {
      // Fastify's contract (review of #3459): a JSON content type with an
      // empty body is refused before the route runs — FST_ERR_CTP_EMPTY_JSON_BODY.
      const ct = headers['content-type'] ?? ''
      if (ct.includes('application/json') && (init?.body === undefined || init.body === '')) {
        return json({ code: 'FST_ERR_CTP_EMPTY_JSON_BODY', error: 'Bad Request' }, 400)
      }
      return opts.revoke?.() ?? json({ success: true })
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`)
  }))
  const revokes = () => calls.filter((c) => c.path === '/agents/agent-1/revoke')
  const allRevokes = () => calls.filter((c) => /^\/agents\/agent-\d+\/revoke$/.test(c.path))
  return { calls, revokes, allRevokes }
}

beforeEach(() => vi.unstubAllGlobals())

describe('withThrowawayIdentity — the scenario ends three ways', () => {
  it('revokes after a PASS, as the throwaway user', async () => {
    const api = installFake()
    const result = await withThrowawayIdentity(API, OPTIONS, async () => pass('green'))
    expect(result).toEqual({ pass: true, detail: 'green' })
    expect(api.revokes()).toEqual([{ method: 'POST', path: '/agents/agent-1/revoke', auth: 'Bearer jwt-throwaway' }])
  })

  it('the revoke carries a JSON body, so the backend accepts it (Fastify 400s an empty JSON body)', async () => {
    installFake()
    const result = await withThrowawayIdentity(API, OPTIONS, async () => pass('ok'))
    expect(result).toEqual(pass('ok')) // no cleanupWarning: the revoke landed
  })

  it('revokes after a FAIL', async () => {
    const api = installFake()
    const result = await withThrowawayIdentity(API, OPTIONS, async () => fail('assertion tripped'))
    expect(result).toEqual({ pass: false, detail: 'assertion tripped' })
    expect(api.revokes()).toHaveLength(1)
  })

  it('revokes after a THROW, and the throw still fails the leg', async () => {
    const api = installFake()
    const result = await withThrowawayIdentity(API, OPTIONS, async () => {
      throw new Error('rpc exploded')
    })
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/rpc exploded/)
    expect(api.revokes()).toHaveLength(1)
  })

  it('revokes only AFTER the leg has finished, never before', async () => {
    const api = installFake()
    let revokesSeenByLeg = -1
    await withThrowawayIdentity(API, OPTIONS, async () => {
      revokesSeenByLeg = api.revokes().length
      return pass('ok')
    })
    expect(revokesSeenByLeg).toBe(0)
    expect(api.revokes()).toHaveLength(1)
  })

  it('registers an additional agent immediately and revokes both on exit', async () => {
    const api = installFake()
    const result = await withThrowawayIdentity(API, OPTIONS, async (identity) => {
      const second = await identity.createAdditionalAgent('sub-agent')
      expect(second).toMatchObject({ agentId: 'agent-2', agentApiKey: 'sk-test-2' })
      return pass('two agents')
    })
    expect(result).toEqual(pass('two agents'))
    expect(api.allRevokes().map((call) => call.path)).toEqual([
      '/agents/agent-2/revoke',
      '/agents/agent-1/revoke',
    ])
  })

  it('revokes an additional agent whose response omitted the api key', async () => {
    const api = installFake({
      agent: (index) =>
        index === 1
          ? json({ id: 'agent-1', api_key: 'sk-test-1' }, 201)
          : json({ id: 'agent-2', error: 'credential generation failed' }, 500),
    })
    const result = await withThrowawayIdentity(API, OPTIONS, async (identity) => {
      const second = await identity.createAdditionalAgent('sub-agent')
      return 'error' in second ? fail(second.error) : pass('unexpected')
    })
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/credential generation failed/)
    expect(api.allRevokes().map((call) => call.path)).toEqual([
      '/agents/agent-2/revoke',
      '/agents/agent-1/revoke',
    ])
  })
})

describe('provisionThrowawayIdentity — errors after POST /agents succeeded', () => {
  it('revokes when the grant build fails, since the caller never receives the agent id', async () => {
    const api = installFake({ build: () => json({ error: 'nope' }, 500) })
    const result = await provisionThrowawayIdentity(API, OPTIONS)
    expect(result).toEqual({ error: 'grant build failed (500): nope' })
    expect(api.revokes()).toEqual([{ method: 'POST', path: '/agents/agent-1/revoke', auth: 'Bearer jwt-throwaway' }])
  })

  it('revokes when activate fails', async () => {
    const api = installFake({ activate: () => json({ error: 'bad sig' }, 400) })
    const result = await provisionThrowawayIdentity(API, OPTIONS)
    expect(result).toMatchObject({ error: expect.stringContaining('activate failed (400)') })
    expect(api.revokes()).toHaveLength(1)
  })

  it('revokes when the grant call THROWS, returning it as an error value', async () => {
    const api = installFake({ build: () => { throw new Error('socket hang up') } })
    const result = await provisionThrowawayIdentity(API, OPTIONS)
    expect(result).toMatchObject({ error: expect.stringContaining('socket hang up') })
    expect(api.revokes()).toHaveLength(1)
  })

  it('does not revoke on success — the scenario owns the agent from here', async () => {
    const api = installFake()
    const result = await provisionThrowawayIdentity(API, OPTIONS)
    expect('error' in result).toBe(false)
    expect(api.revokes()).toHaveLength(0)
  })

  it('surfaces a failed helper-side revoke as cleanupWarning without altering the error', async () => {
    installFake({ build: () => json({ error: 'nope' }, 500), revoke: () => json({ error: 'gone' }, 404) })
    const result = await withThrowawayIdentity(API, OPTIONS, async () => pass('unreachable'))
    expect(result).toMatchObject({ pass: false, detail: 'grant build failed (500): nope' })
    expect(result.cleanupWarning).toMatch(/agent-1 was NOT revoked \(404\): gone/)
  })
})

describe('a failed revoke never changes the verdict', () => {
  const cases: Array<[string, () => Response | never]> = [
    ['HTTP 404', () => json({ error: 'Agent not found or cannot be revoked' }, 404)],
    ['HTTP 500', () => json({ error: 'boom' }, 500)],
    ['a network error', () => { throw new Error('ECONNRESET') }],
  ]
  for (const [label, revoke] of cases) {
    it(`keeps verdict and detail on ${label}, and names the agent id in the warning`, async () => {
      installFake({ revoke })
      for (const leg of [() => pass('green detail'), () => fail('red detail')]) {
        const expected = leg()
        const result = await withThrowawayIdentity(API, OPTIONS, async () => leg())
        expect(result.pass).toBe(expected.pass)
        expect(result.detail).toBe(expected.detail)
        expect(result.cleanupWarning).toMatch(/agent-\d+ was NOT revoked/)
      }
    })
  }

  it('leaves no cleanupWarning key at all when the revoke succeeds', async () => {
    installFake()
    const result = await withThrowawayIdentity(API, OPTIONS, async () => pass('ok'))
    expect(result).not.toHaveProperty('cleanupWarning')
  })
})

describe('the run report renders the cleanup warning', () => {
  const scenario = (name: string): Scenario => ({ name, invariant: 'inv', run: async () => pass('x') })
  const results = (leaky: ScenarioResult) => [
    { scenario: scenario('clean'), result: pass('fine') },
    { scenario: scenario('leaky'), result: leaky },
  ]

  it('lists the warning with its agent id and leaves the table cells alone', () => {
    const text = formatRunReport(API, results({ ...pass('all good'), cleanupWarning: 'throwaway agent agent-9 was NOT revoked (500): ' }), new Date(0)).join('\n')
    expect(text).toContain('| leaky | inv | pass | all good |')
    expect(text).toContain('Cleanup warnings')
    expect(text).toContain('- leaky: throwaway agent agent-9 was NOT revoked')
  })

  it('prints no warnings section when nothing leaked', () => {
    const text = formatRunReport(API, results(pass('ok')), new Date(0)).join('\n')
    expect(text).not.toMatch(/Cleanup warnings/)
  })
})
