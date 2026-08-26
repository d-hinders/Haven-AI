import { beforeEach, describe, expect, it, vi } from 'vitest'
import { provisionThrowawayIdentity } from './throwaway-identity.js'

const API = 'https://api.example'
const OPTIONS = { chainId: 84_532, budgetAtomic: '10000', label: 'regression' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Drive provisioning as far as the agent-creation call, capturing its body.
 *
 * The grant that follows is deliberately left to fail: this helper exists to
 * inspect what `POST /agents` was SENT, and stopping there keeps the fixture
 * free of a real EIP-712 payload the assertions do not need.
 */
function installUpToAgentCreate(agentResponse: () => Response) {
  const bodies = new Map<string, unknown>()
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace(API, '')
    if (init?.body) bodies.set(path, JSON.parse(String(init.body)))

    if (path === '/auth/signup') return json({ token: 'jwt-token' }, 201)
    if (path === '/accounts/hybrid') return json({ ok: true }, 201)
    if (path === '/auth/me') {
      return json({
        safes: [{ id: 'safe-1', safe_address: '0x' + '11'.repeat(20), account_type: 'delegator_hybrid' }],
      })
    }
    if (path === '/agents') return agentResponse()
    if (path.endsWith('/delegations/build')) return json({ error: 'stop here' }, 500)
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  return bodies
}

beforeEach(() => vi.unstubAllGlobals())

describe('provisionThrowawayIdentity', () => {
  // #2020 retired the per-token mirror and POST /agents began REFUSING a
  // non-empty `allowances` array outright. `seed.ts` was updated in that
  // commit; this helper was the missed caller, so both throwaway scenarios
  // failed with a bare `throwaway agent creation failed (400)` (#2074/#2077).
  it('does not send the retired allowances array to POST /agents', async () => {
    const bodies = installUpToAgentCreate(() => json({ id: 'agent-1', api_key: 'sk-test' }, 201))

    await provisionThrowawayIdentity(API, OPTIONS)

    const body = bodies.get('/agents') as Record<string, unknown>
    expect(body).toBeDefined()
    expect(body).not.toHaveProperty('allowances')
    // The budget still reaches the backend — as a delegation, on the grant call.
    expect(bodies.get('/agents/agent-1/delegations/build')).toMatchObject({
      budget_atomic: OPTIONS.budgetAtomic,
    })
  })

  it("surfaces the backend's error body when agent creation is refused", async () => {
    installUpToAgentCreate(() =>
      json({ error: 'Per-token allowances are retired with the Safe rail (#1440).' }, 400),
    )

    const result = await provisionThrowawayIdentity(API, OPTIONS)

    // A bare `(400)` is what sent three QA runs to manual calldata decoding.
    expect(result).toMatchObject({
      error: expect.stringContaining('Per-token allowances are retired'),
    })
    expect(result).toMatchObject({ error: expect.stringContaining('400') })
  })
})
