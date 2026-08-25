import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import agentRoutes from '../agents.js'
// #1444: the spec's own schema decides whether a response matches what we
// promise external integrators — not a hand-written toMatchObject.
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
    // The create path opens a transaction client; route its queries to the same
    // mock so BEGIN/INSERT/COMMIT/ROLLBACK are observable in mockQuery.calls.
    connect: async () => ({
      query: (...args: unknown[]) => mockQuery(...args),
      release: () => {},
    }),
  },
}))

// The passport module is mocked so the creation-path guarantee can be tested
// directly: a passport problem must never fail, delay, or roll back the agent.
const { mockRequestPassport, mockIssueBestEffort } = vi.hoisted(() => ({
  mockRequestPassport: vi.fn(),
  mockIssueBestEffort: vi.fn(),
}))
vi.mock('../../modules/passport/index.js', () => ({
  requestPassport: (...a: unknown[]) => mockRequestPassport(...a),
  issuePassportBestEffort: (...a: unknown[]) => mockIssueBestEffort(...a),
  PASSPORT_CHAIN_IDS: new Set([84532]),
}))

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'user-1' }
  },
}))

// The spec promises `format: uuid` for these ids and the database delivers it;
// a fixture id like 'agent-1' would make the response-shape assertion (#1444)
// pass against a payload production can never produce.
const AGENT_UUID = '4f9a1c2e-7b3d-4a10-9c55-2f8e6d0b1a34'
const SAFE_UUID = 'b1d7c9a4-3e28-4f61-8a0d-5c7e2b9f4d16'

const VALID_DELEGATE = '0x1111111111111111111111111111111111111111'
const VALID_TOKEN = '0x3333333333333333333333333333333333333333'

const VALID_ALLOWANCE = {
  token_address: VALID_TOKEN,
  token_symbol: 'USDC',
  allowance_amount: '25000000',
  reset_period_min: 1440,
}

describe('agent routes', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockRequestPassport.mockReset().mockResolvedValue(true)
    mockIssueBestEffort.mockReset()
  })

  it('fetches one agent with empty allowances and null mcp_last_seen_at when never called', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    // #2020: a non-delegator_hybrid agent gets `allowances: []` with NO
    // second query against `agent_allowances` — the mirror is retired with
    // the Safe rail. A single mocked call is enough; a leftover second one
    // would go unconsumed if the handler regressed into reading it.
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: AGENT_UUID,
        name: 'Research Agent',
        description: null,
        delegate_address: '0x1111111111111111111111111111111111111111',
        safe_id: SAFE_UUID,
        safe_address: '0x2222222222222222222222222222222222222222',
        safe_name: 'Main wallet',
        safe_chain_id: 8453,
        api_key_prefix: 'sk_agent_abc',
        status: 'active',
        created_at: '2026-05-25T12:00:00.000Z',
        mcp_last_seen_at: null,
      }],
    })

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${AGENT_UUID}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: AGENT_UUID,
      name: 'Research Agent',
      allowances: [],
      mcp_last_seen_at: null,
    })
    // #1069: pending_approval agents are SURFACED, not hidden — an abandoned
    // setup used to leave the user with "Agents 0" and no route back to an
    // agent that exists. The list/detail include them; the UI badges them
    // 'Needs setup' and links to the page where the budget grant activates.
    expect(String(mockQuery.mock.calls[0][0])).not.toContain("pending_approval")
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1', AGENT_UUID])
    // Only the single agent-row query — no `agent_allowances` read (#2020).
    expect(mockQuery).toHaveBeenCalledTimes(1)
    // The populated shape is where drift would actually show.
    expectMatchesSpec('GET', '/agents/{id}', response.json())

    await app.close()
  })

  it('returns mcp_last_seen_at when agent has made tool calls', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const lastSeenAt = '2026-05-28T14:00:00.000Z'
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'agent-1',
          name: 'Research Agent',
          description: null,
          delegate_address: '0x1111111111111111111111111111111111111111',
          safe_id: 'safe-1',
          safe_address: '0x2222222222222222222222222222222222222222',
          safe_name: 'Main wallet',
          safe_chain_id: 8453,
          api_key_prefix: 'sk_agent_abc',
          status: 'active',
          created_at: '2026-05-25T12:00:00.000Z',
          mcp_last_seen_at: lastSeenAt,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: '/agents/agent-1',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().mcp_last_seen_at).toBe(lastSeenAt)
    // #1069: pending_approval agents are SURFACED, not hidden — an abandoned
    // setup used to leave the user with "Agents 0" and no route back to an
    // agent that exists. The list/detail include them; the UI badges them
    // 'Needs setup' and links to the page where the budget grant activates.
    expect(String(mockQuery.mock.calls[0][0])).not.toContain("pending_approval")

    await app.close()
  })

  it('excludes pending Connect Agent 2 setups from the legacy agent list', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: '/agents',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ agents: [] })
    expectMatchesSpec('GET', '/agents', response.json())
    // #1069: pending_approval agents are SURFACED, not hidden — an abandoned
    // setup used to leave the user with "Agents 0" and no route back to an
    // agent that exists. The list/detail include them; the UI badges them
    // 'Needs setup' and links to the page where the budget grant activates.
    expect(String(mockQuery.mock.calls[0][0])).not.toContain("pending_approval")

    await app.close()
  })

  // #2020 (epic #1440): per-item allowance validation on create — bad token
  // address, blank/overlong symbol, non-positive/overflowing amount,
  // out-of-range reset period, duplicate tokens — is REMOVED behavior. There
  // is nothing left to validate per-item because a non-empty `allowances`
  // array is refused outright, before any of that shape is inspected. One
  // well-formed allowance is enough to prove the refusal does not depend on
  // the array being invalid.
  it('rejects ANY non-empty create-agent allowances array — 400, before any transaction', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'Research Agent',
        delegate_address: VALID_DELEGATE,
        allowances: [VALID_ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error:
        'Per-token allowances are retired with the Safe rail (#1440). Grant the agent a budget delegation instead.',
    })
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  // #2020: POST /agents/:id/allowances is now a 410 tombstone, same shape as
  // DELETE /agents/:id (#1401) and the session rail (#834) — no ownership
  // lookup, no body validation, nothing written. The old per-item validation,
  // pending-approval/revoked 409 gates, and normalize-and-upsert happy path
  // this replaces are all removed behavior: there is no longer a live write
  // for any of them to gate.
  it('POST /agents/:id/allowances is a 410 tombstone regardless of body or agent state — nothing read or written', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const response = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/allowances',
      payload: {
        token_address: '0x3333333333333333333333333333333333333333',
        token_symbol: 'USDC',
        allowance_amount: '25000000',
        reset_period_min: 1440,
      },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json()).toEqual({
      error:
        'Per-token allowances are retired with the Safe rail (#1440). Grant the agent a budget delegation instead.',
    })
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('rejects invalid allowance delete token addresses before agent lookup', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const response = await app.inject({
      method: 'DELETE',
      url: '/agents/agent-1/allowances/not-an-address',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/Valid token address/)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  // #2020: same tombstone contract as the POST above, for a well-formed
  // token address — the pending-approval/revoked 409 gates and the delete
  // happy path this replaces no longer exist. A malformed address still 400s
  // (pinned separately above): `normalizeAgentAllowanceTokenAddress` runs
  // before the 410, same as it always has.
  it('DELETE /agents/:id/allowances/:tokenAddress is a 410 tombstone for a well-formed address — no ownership lookup, nothing deleted', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const response = await app.inject({
      method: 'DELETE',
      url: `/agents/agent-1/allowances/${VALID_TOKEN}`,
    })

    expect(response.statusCode).toBe(410)
    expect(response.json()).toEqual({
      error:
        'Per-token allowances are retired with the Safe rail (#1440). Revoke or change the agent’s budget delegation instead.',
    })
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })
})

/**
 * The headline acceptance criterion of #972: creating an agent must succeed
 * even when the passport path fails. Reviewer finding #4 — the code was correct
 * on manual read but had ZERO regression protection, so nothing would catch a
 * refactor that moved this before COMMIT or let the error escape.
 */
describe('agent creation — passport opt-in never breaks creation', () => {
  // This block is a sibling of `describe('agent routes')`, so it needs its own
  // reset — the other block's beforeEach does not reach here.
  beforeEach(() => {
    mockQuery.mockReset()
    mockRequestPassport.mockReset().mockResolvedValue(true)
    mockIssueBestEffort.mockReset()
  })

  /** Mock the create path's queries: safe lookup, BEGIN, INSERT, safe info, COMMIT. */
  function mockCreateFlow() {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM user_safes/.test(sql)) return { rows: [{ id: 'safe-1' }] }
      if (/INSERT INTO agents/.test(sql)) {
        return { rows: [{ id: 'agent-1', name: 'A', description: null, delegate_address: VALID_DELEGATE, safe_id: 'safe-1', api_key_prefix: 'sk_a', status: 'active', created_at: '2026-07-26T00:00:00.000Z', mcp_last_seen_at: null }] }
      }
      if (/SELECT safe_address, name AS safe_name/.test(sql)) {
        return { rows: [{ safe_address: '0x2222222222222222222222222222222222222222', safe_name: 'Main', safe_chain_id: 84532 }] }
      }
      return { rows: [] }
    })
  }

  const body = { name: 'A', delegate_address: VALID_DELEGATE, safe_id: 'safe-1', issue_passport: true }

  it('returns 201 even when requestPassport THROWS', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })
    mockCreateFlow()
    mockRequestPassport.mockRejectedValue(new Error('passport table missing'))

    const res = await app.inject({ method: 'POST', url: '/agents', payload: body })
    expect(res.statusCode).toBe(201)
    expect(res.json().id).toBe('agent-1')
    // Never rolled back.
    expect(mockQuery.mock.calls.some(([sql]) => /ROLLBACK/.test(String(sql)))).toBe(false)
  })

  it('returns 201 even when issuePassportBestEffort throws synchronously', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })
    mockCreateFlow()
    mockIssueBestEffort.mockImplementation(() => { throw new Error('boom') })

    const res = await app.inject({ method: 'POST', url: '/agents', payload: body })
    expect(res.statusCode).toBe(201)
    expect(mockQuery.mock.calls.some(([sql]) => /ROLLBACK/.test(String(sql)))).toBe(false)
  })

  it('does not request a passport unless explicitly opted in', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })
    mockCreateFlow()

    const res = await app.inject({
      method: 'POST', url: '/agents',
      payload: { name: 'A', delegate_address: VALID_DELEGATE, safe_id: 'safe-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().passport_requested).toBe(false)
    expect(mockRequestPassport).not.toHaveBeenCalled()
  })

  it('skips the opt-in on an unsupported chain instead of creating a doomed row', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM user_safes/.test(sql)) return { rows: [{ id: 'safe-1' }] }
      if (/INSERT INTO agents/.test(sql)) return { rows: [{ id: 'agent-1', name: 'A', description: null, delegate_address: VALID_DELEGATE, safe_id: 'safe-1', api_key_prefix: 'sk_a', status: 'active', created_at: '2026-07-26T00:00:00.000Z', mcp_last_seen_at: null }] }
      if (/SELECT safe_address, name AS safe_name/.test(sql)) {
        return { rows: [{ safe_address: '0x2222222222222222222222222222222222222222', safe_name: 'Main', safe_chain_id: 100 }] } // Gnosis — unsupported
      }
      return { rows: [] }
    })

    const res = await app.inject({ method: 'POST', url: '/agents', payload: body })
    expect(res.statusCode).toBe(201)
    expect(res.json().passport_requested).toBe(false)
    expect(mockRequestPassport).not.toHaveBeenCalled()
  })
})

describe('agent payloads carry the rail (#1069/#1071 class)', () => {
  it('every user_safes JOIN in the agents repository selects account_type — AgentPanel and EditAgentModal branch on it', async () => {
    // Third instance of the same mine: the fix landed in GET /agents/:id, but
    // AgentPanel (dashboard/agents list) reads GET /agents, whose SELECT
    // omitted account_type — so delegation agents opened the legacy Safe
    // budget editor with a permanently dead "Update budget" button. Pin the
    // field in EVERY user_safes join in the agents SQL, like auth.test.ts
    // does for auth.ts. (#988 moved the SQL verbatim from routes/agents.ts
    // into infra/repositories/agents.ts; this pin follows it there.)
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../infra/repositories/agents.ts', import.meta.url), 'utf8')
    // Bind each match to ONE template literal (backticks can't nest), not
    // `SELECT[\s\S]*?JOIN` — that lazy span crossed statement boundaries, so
    // a SELECT without the join borrowed the NEXT statement's join and the
    // account_type check ran against two statements' merged text (#1210).
    const selects = src.match(/`[^`]*JOIN user_safes[^`]*`/g) ?? []
    expect(selects.length).toBeGreaterThanOrEqual(4)
    for (const sel of selects) {
      expect(sel, `user_safes JOIN missing account_type: ${sel.slice(0, 80)}`).toContain('account_type')
    }
  })
})

describe('delegation-rail budget view derives from active delegations (#1090)', () => {
  // agent_allowances is written once at connection setup and never on budget
  // updates — a frozen onboarding mirror. The summary payloads must read the
  // ACTIVE agent_delegations rows, or every view shows the onboarding budget
  // forever. Legacy AllowanceModule agents keep the mirror verbatim.
  const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
  const AGENT_BASE = {
    id: 'agent-1', name: 'A', description: null, delegate_address: VALID_DELEGATE,
    safe_id: 'safe-1', safe_address: '0x' + '22'.repeat(20), safe_name: 'Main',
    safe_chain_id: 84532, api_key_prefix: 'sk_a', status: 'active',
    created_at: '2026-08-05T00:00:00.000Z', mcp_last_seen_at: null, has_stranded_funds: false,
  }
  beforeEach(() => {
    mockQuery.mockReset()
  })

  function mockReads(opts: {
    accountType: string | null
    delegations?: Array<Record<string, unknown>>
  }) {
    mockQuery.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (/FROM agents a/.test(s)) {
        return { rows: [{ ...AGENT_BASE, account_type: opts.accountType }] }
      }
      if (/FROM agent_delegations/.test(s)) return { rows: opts.delegations ?? [] }
      return { rows: [] }
    })
  }

  async function getAgents(url: string) {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })
    return app.inject({ method: 'GET', url })
  }

  const ACTIVE_DELEGATION = {
    id: 'd-1', agent_id: 'agent-1', chain_id: 84532, token_address: SEPOLIA_USDC,
    budget_atomic: '1000000', period_seconds: 86_400,
  }

  it('list: a delegation agent reports the ACTIVE delegation, not the frozen mirror', async () => {
    mockReads({ accountType: 'delegator_hybrid', delegations: [ACTIVE_DELEGATION] })
    const res = await getAgents('/agents')
    expect(res.statusCode).toBe(200)
    const [agent] = res.json().agents
    expect(agent.allowances).toEqual([{
      id: 'd-1', agent_id: 'agent-1', token_address: SEPOLIA_USDC,
      token_symbol: 'USDC', allowance_amount: '1.00', reset_period_min: 1440,
    }])
  })

  it('by-id: same derivation, and a revoked-only agent reports NO budget', async () => {
    mockReads({ accountType: 'delegator_hybrid', delegations: [] })
    const res = await getAgents('/agents/agent-1')
    expect(res.statusCode).toBe(200)
    expect(res.json().allowances).toEqual([])
  })

  // #2020, reversing the byte-identical mirror pin this replaces: the Safe
  // rail is retired and `agent_allowances` is no longer read anywhere, so a
  // legacy (non-delegator_hybrid) agent reports NO allowances rather than the
  // frozen mirror.
  it('legacy agents get empty allowances — the mirror is retired, and neither allowance table is consulted', async () => {
    mockReads({ accountType: null, delegations: [ACTIVE_DELEGATION] })
    const res = await getAgents('/agents')
    expect(res.json().agents[0].allowances).toEqual([])
    // Neither table is consulted for a legacy-only listing:
    expect(mockQuery.mock.calls.some((c) => /FROM agent_delegations/.test(String(c[0])))).toBe(false)
    expect(mockQuery.mock.calls.some((c) => /FROM agent_allowances/.test(String(c[0])))).toBe(false)
  })

  it('an unlisted token degrades to a generic view instead of dropping the budget', async () => {
    mockReads({
      accountType: 'delegator_hybrid',
      delegations: [{ ...ACTIVE_DELEGATION, token_address: '0x' + '99'.repeat(20), budget_atomic: '2000000000000000000' }],
    })
    const res = await getAgents('/agents/agent-1')
    const [allowance] = res.json().allowances
    expect(allowance.token_symbol).toBe('TOKEN')
    expect(allowance.allowance_amount).toBe('2.00')
  })
})

describe('agent archive routes (#1401)', () => {
  // SQL-pattern dispatch per the #1227 ratchet — no positional mocks.
  function primeDb(handlers: Array<[RegExp, { rows: unknown[] }]>) {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      for (const [pattern, result] of handlers) {
        if (pattern.test(text)) return result
      }
      return { rows: [] }
    })
  }

  async function buildApp() {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })
    return app
  }

  it('DELETE /agents/:id is a 410 tombstone that touches nothing', async () => {
    const app = await buildApp()
    mockQuery.mockClear()
    const response = await app.inject({ method: 'DELETE', url: '/agents/agent-1' })
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toContain('archive')
    // Nothing is read and nothing is written on the retired path.
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('archives a revoked agent and returns archived_at', async () => {
    const app = await buildApp()
    const archivedAt = '2026-08-14T12:00:00.000Z'
    primeDb([
      [/UPDATE agents\s+SET archived_at = COALESCE/, { rows: [{ id: 'agent-1', archived_at: archivedAt }] }],
    ])
    const response = await app.inject({ method: 'POST', url: '/agents/agent-1/archive' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, archived_at: archivedAt })
    expectMatchesSpec('POST', '/agents/{id}/archive', response.json())
    await app.close()
  })

  it('refuses to archive a non-revoked agent with 409 and an actionable message', async () => {
    const app = await buildApp()
    primeDb([
      [/UPDATE agents\s+SET archived_at = COALESCE/, { rows: [] }],
      [/SELECT id FROM agents WHERE id = \$1 AND user_id = \$2/, { rows: [{ id: 'agent-1' }] }],
      [/SELECT EXISTS[\s\S]*agent_delegations/, { rows: [{ live: false }] }],
    ])
    const response = await app.inject({ method: 'POST', url: '/agents/agent-1/archive' })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('Revoke the agent first')
    await app.close()
  })

  // #1436: the two 409s need DIFFERENT remedies — a caller told "revoke the
  // agent first" when the real blocker is a live budget is stuck, because it
  // has already revoked.
  it('refuses with the revoke-all remedy when budgets are still live (#1436)', async () => {
    const app = await buildApp()
    primeDb([
      [/UPDATE agents\s+SET archived_at = COALESCE/, { rows: [] }],
      [/SELECT id FROM agents WHERE id = \$1 AND user_id = \$2/, { rows: [{ id: 'agent-1' }] }],
      [/SELECT EXISTS[\s\S]*agent_delegations/, { rows: [{ live: true }] }],
    ])
    const response = await app.inject({ method: 'POST', url: '/agents/agent-1/archive' })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('revoke-all')
    expect(response.json().error).toContain('still holds budget delegations')
    // and NOT the wrong remedy:
    expect(response.json().error).not.toContain('Revoke the agent first')
    await app.close()
  })

  it('404s archive/unarchive for a foreign or missing agent', async () => {
    const app = await buildApp()
    primeDb([
      [/UPDATE agents/, { rows: [] }],
      [/SELECT id FROM agents WHERE id = \$1 AND user_id = \$2/, { rows: [] }],
    ])
    for (const url of ['/agents/agent-x/archive', '/agents/agent-x/unarchive']) {
      const response = await app.inject({ method: 'POST', url })
      expect(response.statusCode).toBe(404)
    }
    await app.close()
  })

  it('unarchive succeeds, and is an idempotent no-op on a non-archived agent', async () => {
    const app = await buildApp()
    primeDb([
      [/UPDATE agents\s+SET archived_at = NULL/, { rows: [{ id: 'agent-1' }] }],
    ])
    const first = await app.inject({ method: 'POST', url: '/agents/agent-1/unarchive' })
    expect(first.statusCode).toBe(200)

    primeDb([
      [/UPDATE agents\s+SET archived_at = NULL/, { rows: [] }],
      [/SELECT id FROM agents WHERE id = \$1 AND user_id = \$2/, { rows: [{ id: 'agent-1' }] }],
    ])
    const second = await app.inject({ method: 'POST', url: '/agents/agent-1/unarchive' })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ success: true })
    await app.close()
  })
})
