/**
 * POST /agent-connection-setups/:setupId/retired-agents (#3772).
 *
 * The new agent (authenticated with ITS OWN api key) reports the agents
 * `connect --replace` retired; the route stamps them superseded. Warning only.
 * What the database does with the UPDATE (tenant scope, self-exclusion,
 * overwrite) is proven on the real-DB harness in
 * `infra/repositories/__tests__/agents-supersession.test.ts`; this suite owns
 * the handler: auth, status gates, body validation, and what is passed down.
 *
 * Every case runs twice: with the request-validation plugin enforcing (as
 * production serves this module) and with it absent (shadow/off), because the
 * handler re-checks the body itself.
 */
// db-mock-exempt: handler-only suite (auth, status gates, body shape) with SQL-content dispatch; the UPDATE's behaviour is proven on the real-DB harness in agents-supersession.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import agentConnectionSetupRoutes from '../agent-connection-setups.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: vi.fn(),
  },
}))

const SETUP_ID = '11111111-1111-1111-1111-111111111111'
const USER_ID = '22222222-2222-2222-2222-222222222222'
const NEW_AGENT_ID = '33333333-3333-3333-3333-333333333333'
const X1 = '44444444-4444-4444-4444-444444444444'
const X2 = '55555555-5555-5555-5555-555555555555'

const SETUP_ROW = {
  id: SETUP_ID,
  user_id: USER_ID,
  agent_id: NEW_AGENT_ID,
  status: 'connected_local',
}

let markedWith: unknown[][] = []
let setupRow: Record<string, unknown> | null = SETUP_ROW

beforeEach(() => {
  markedWith = []
  setupRow = SETUP_ROW
  mockQuery.mockReset()
  // SQL-content dispatch, never positional.
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    if (/a\.api_key_hash = \$2/.test(text)) return { rows: setupRow ? [setupRow] : [] }
    if (/UPDATE agents[\s\S]*superseded_by_agent_id/.test(text)) {
      markedWith.push(params)
      return { rows: (params[2] as string[]).filter((id) => id !== params[1]).map((id) => ({ id })) }
    }
    return { rows: [] }
  })
})

const KEY = 'Bearer sk_agent_live_key'

describe.each([['enforce'], ['off']] as const)('POST /:setupId/retired-agents (#3772) — validation %s', (mode) => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify({ logger: false })
    if (mode === 'enforce') {
      installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/agent-connection-setups.ts'] })
    }
    await app.register(agentConnectionSetupRoutes, { prefix: '/agent-connection-setups' })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  const post = (payload: unknown, headers: Record<string, string> = { authorization: KEY }) =>
    app.inject({ method: 'POST', url: `/agent-connection-setups/${SETUP_ID}/retired-agents`, headers, payload: payload as object })

  it('records the retired ids for the setup user under the setup agent', async () => {
    const response = await post({ retired_agent_ids: [X1, X2] })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ setup_id: SETUP_ID, recorded_agent_ids: [X1, X2] })
    expectMatchesSpec('POST', '/agent-connection-setups/{setupId}/retired-agents', response.json())
    // user scope comes from the SETUP row, replacement from the setup's agent.
    expect(markedWith).toEqual([[USER_ID, NEW_AGENT_ID, [X1, X2]]])
  })

  it('refuses a setup token (header or body) — the agent api key is the only credential', async () => {
    const viaHeader = await post({ retired_agent_ids: [X1] }, { 'x-haven-setup-token': 'hvn_setup_abc' })
    expect(viaHeader.statusCode).toBe(401)
    expect(viaHeader.json()).toEqual({ error: 'Invalid setup status credential' })

    const viaBody = await post({ retired_agent_ids: [X1], setup_token: 'hvn_setup_abc' })
    expect(viaBody.statusCode).toBeGreaterThanOrEqual(400)
    expect(viaBody.statusCode).toBeLessThan(500)
    expect(markedWith).toEqual([])
    // No setup lookup by token was ever attempted.
    expect(mockQuery.mock.calls.some(([sql]) => /setup_token_hash/.test(String(sql)))).toBe(false)
  })

  it('401s on a missing or unknown key and writes nothing', async () => {
    const missing = await post({ retired_agent_ids: [X1] }, {})
    expect(missing.statusCode).toBe(401)
    expect(missing.json()).toEqual({ error: 'Invalid setup status credential' })

    setupRow = null
    const unknown = await post({ retired_agent_ids: [X1] })
    expect(unknown.statusCode).toBe(401)
    expect(markedWith).toEqual([])
  })

  it.each(['cancelled', 'expired', 'failed'])('409s on a %s setup and writes nothing', async (status) => {
    setupRow = { ...SETUP_ROW, status }
    const response = await post({ retired_agent_ids: [X1] })
    expect(response.statusCode).toBe(409)
    expect(markedWith).toEqual([])
  })

  it.each([
    ['non-uuid id', { retired_agent_ids: ['not-a-uuid'] }],
    ['empty list', { retired_agent_ids: [] }],
    ['more than 32 ids', { retired_agent_ids: Array.from({ length: 33 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }],
    ['duplicate ids', { retired_agent_ids: [X1, X1] }],
    // (A bare string would be coerced to a one-element array by the enforcing
    // plugin's ajv, so the non-array case uses an object, which cannot be.)
    ['non-array', { retired_agent_ids: { id: X1 } }],
    ['missing field', {}],
    ['extra key', { retired_agent_ids: [X1], note: 'x' }],
  ])('400s on a malformed body: %s', async (_label, body) => {
    const response = await post(body)
    expect(response.statusCode).toBe(400)
    expect(markedWith).toEqual([])
  })

  it.each(['private_key', 'privateKey', 'mnemonic'])('400s on a credential-shaped field (%s)', async (field) => {
    const response = await post({ retired_agent_ids: [X1], [field]: '0xabc' })
    expect(response.statusCode).toBe(400)
    expect(markedWith).toEqual([])
  })
})
