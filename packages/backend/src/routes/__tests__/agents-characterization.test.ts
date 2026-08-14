import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import agentRoutes from '../agents.js'

/**
 * Characterization coverage for the agents route paths #988 extracts into
 * `infra/repositories/agents.ts` (per the #985 convention). These pins landed
 * BEFORE the extraction commit and must pass unchanged on both sides of it:
 * they assert observable behaviour only — status codes, response bodies, the
 * parameter vectors handed to the driver, and transaction call order.
 *
 * The previously uncovered query paths pinned here: PUT /:id, DELETE /:id,
 * POST /:id/revoke, POST /:id/rotate-key, POST /:id/pause, POST /:id/resume,
 * GET /:id/delegate-balance, the create-flow transaction sequence, and the
 * allowance-delete happy path.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
    // Transaction clients route to the same mock so BEGIN/COMMIT/ROLLBACK are
    // observable in mockQuery.calls, exactly like agents.test.ts does.
    connect: async () => ({
      query: (...args: unknown[]) => mockQuery(...args),
      release: () => {},
    }),
  },
}))

const { mockEnqueueRevocation, mockRevokeBestEffort } = vi.hoisted(() => ({
  mockEnqueueRevocation: vi.fn(),
  mockRevokeBestEffort: vi.fn(),
}))
vi.mock('../../modules/passport/index.js', () => ({
  requestPassport: vi.fn(),
  issuePassportBestEffort: vi.fn(),
  enqueuePassportRevocation: (...a: unknown[]) => mockEnqueueRevocation(...a),
  revokePassportBestEffort: (...a: unknown[]) => mockRevokeBestEffort(...a),
  isPassportConfigured: vi.fn().mockReturnValue(false),
  PASSPORT_CHAIN_IDS: new Set([84532]),
}))

const { mockGetTokenBalance } = vi.hoisted(() => ({
  mockGetTokenBalance: vi.fn(),
}))
vi.mock('../../rails/allowance-module.js', () => ({
  getTokenBalance: (...a: unknown[]) => mockGetTokenBalance(...a),
}))

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'user-1' }
  },
}))

const VALID_DELEGATE = '0x1111111111111111111111111111111111111111'
const VALID_TOKEN = '0x3333333333333333333333333333333333333333'

async function makeApp() {
  const app = Fastify({ logger: false })
  await app.register(agentRoutes, { prefix: '/agents' })
  return app
}

beforeEach(() => {
  mockQuery.mockReset()
  mockEnqueueRevocation.mockReset().mockResolvedValue(true)
  mockRevokeBestEffort.mockReset()
  mockGetTokenBalance.mockReset()
})

describe('GET /agents — the #1069 pin: pending_approval agents are SURFACED', () => {
  const PENDING_AGENT = {
    id: 'agent-p',
    name: 'Pending Agent',
    description: null,
    delegate_address: VALID_DELEGATE,
    safe_id: 'safe-1',
    safe_address: '0x2222222222222222222222222222222222222222',
    safe_name: 'Main wallet',
    safe_chain_id: 8453,
    account_type: null,
    api_key_prefix: 'sk_agent_abc',
    status: 'pending_approval',
    created_at: '2026-08-01T12:00:00.000Z',
    mcp_last_seen_at: null,
    has_stranded_funds: false,
  }

  it('the list returns a pending_approval agent and its SQL carries no status filter', async () => {
    const app = await makeApp()
    mockQuery
      .mockResolvedValueOnce({ rows: [PENDING_AGENT] })
      .mockResolvedValueOnce({ rows: [] }) // allowances

    const res = await app.inject({ method: 'GET', url: '/agents' })
    expect(res.statusCode).toBe(200)
    expect(res.json().agents).toHaveLength(1)
    expect(res.json().agents[0].status).toBe('pending_approval')

    const listSql = String(mockQuery.mock.calls[0][0])
    // No status-based scoping in the list read: neither the pre-#1069
    // pending_approval exclusion nor a revoked filter.
    expect(listSql).not.toContain('pending_approval')
    expect(listSql).not.toMatch(/a\.status\s*(!=|=|IN)/)
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1'])
    await app.close()
  })

  it('the single read returns a pending_approval agent and its SQL carries no status filter', async () => {
    const app = await makeApp()
    mockQuery
      .mockResolvedValueOnce({ rows: [PENDING_AGENT] })
      .mockResolvedValueOnce({ rows: [] }) // allowances

    const res = await app.inject({ method: 'GET', url: '/agents/agent-p' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('pending_approval')

    const singleSql = String(mockQuery.mock.calls[0][0])
    expect(singleSql).not.toContain('pending_approval')
    expect(singleSql).not.toMatch(/a\.status\s*(!=|=|IN)/)
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1', 'agent-p'])
    await app.close()
  })
})

describe('GET /agents/:id/delegate-balance', () => {
  it('excludes revoked agents in SQL — the one status-scoped agent read', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const res = await app.inject({ method: 'GET', url: '/agents/agent-1/delegate-balance' })
    expect(res.statusCode).toBe(404)

    const sql = String(mockQuery.mock.calls[0][0])
    expect(sql).toContain("a.status != 'revoked'")
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1', 'agent-1'])
    await app.close()
  })

  it('returns formatted ETH + USDC balances for the delegate', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({
      rows: [{
        delegate_address: VALID_DELEGATE,
        safe_chain_id: 8453,
        safe_address: '0x2222222222222222222222222222222222222222',
      }],
    })
    // First call: native ETH (zero address); second: USDC.
    mockGetTokenBalance
      .mockResolvedValueOnce(1000000000000000000n)
      .mockResolvedValueOnce(2000000n)

    const res = await app.inject({ method: 'GET', url: '/agents/agent-1/delegate-balance' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.delegate_address).toBe(VALID_DELEGATE)
    expect(body.chain_id).toBe(8453)
    expect(body.eth_atomic).toBe('1000000000000000000')
    expect(body.usdc_atomic).toBe('2000000')
    await app.close()
  })

  it('422s when the agent has no delegate address', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({
      rows: [{ delegate_address: null, safe_chain_id: 8453, safe_address: null }],
    })

    const res = await app.inject({ method: 'GET', url: '/agents/agent-1/delegate-balance' })
    expect(res.statusCode).toBe(422)
    await app.close()
  })
})

describe('POST /agents — create-flow transaction sequence', () => {
  const CREATE_BODY = {
    name: 'Research Agent',
    delegate_address: VALID_DELEGATE,
    safe_id: 'safe-1',
    allowances: [{
      token_address: VALID_TOKEN,
      token_symbol: 'USDC',
      allowance_amount: '25000000',
      reset_period_min: 1440,
    }],
  }

  function mockHappyCreate() {
    mockQuery.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (/SELECT id FROM user_safes WHERE id = \$1 AND user_id = \$2/.test(s)) {
        return { rows: [{ id: 'safe-1' }] }
      }
      if (/SELECT id FROM agents WHERE user_id = \$1 AND delegate_address/.test(s)) {
        return { rows: [] }
      }
      if (/INSERT INTO agents/.test(s)) {
        return {
          rows: [{
            id: 'agent-1', name: 'Research Agent', description: null,
            delegate_address: VALID_DELEGATE, safe_id: 'safe-1',
            api_key_prefix: 'sk_agent_abcd', status: 'active',
            created_at: '2026-08-05T00:00:00.000Z', mcp_last_seen_at: null,
          }],
        }
      }
      if (/SELECT safe_address, name AS safe_name/.test(s)) {
        return { rows: [{ safe_address: '0x2222222222222222222222222222222222222222', safe_name: 'Main', safe_chain_id: 8453 }] }
      }
      if (/INSERT INTO agent_allowances/.test(s)) {
        return { rows: [{ id: 'al-1', agent_id: 'agent-1', ...CREATE_BODY.allowances[0] }] }
      }
      return { rows: [] }
    })
  }

  it('runs safe check, duplicate check, then BEGIN → INSERT agent → safe info → INSERT allowance → COMMIT', async () => {
    const app = await makeApp()
    mockHappyCreate()

    const res = await app.inject({ method: 'POST', url: '/agents', payload: CREATE_BODY })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBe('agent-1')
    expect(body.api_key).toMatch(/^sk_agent_/)
    expect(body.allowances).toHaveLength(1)
    expect(body.safe_address).toBe('0x2222222222222222222222222222222222222222')

    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql))
    const idx = {
      safeCheck: sqls.findIndex((s) => /SELECT id FROM user_safes WHERE id = \$1 AND user_id = \$2/.test(s)),
      dupCheck: sqls.findIndex((s) => /SELECT id FROM agents WHERE user_id = \$1 AND delegate_address/.test(s)),
      begin: sqls.findIndex((s) => s === 'BEGIN'),
      insertAgent: sqls.findIndex((s) => /INSERT INTO agents/.test(s)),
      safeInfo: sqls.findIndex((s) => /SELECT safe_address, name AS safe_name/.test(s)),
      insertAllowance: sqls.findIndex((s) => /INSERT INTO agent_allowances/.test(s)),
      commit: sqls.findIndex((s) => s === 'COMMIT'),
    }
    expect(Object.values(idx).every((i) => i !== -1)).toBe(true)
    expect(idx.safeCheck).toBeLessThan(idx.dupCheck)
    expect(idx.dupCheck).toBeLessThan(idx.begin)
    expect(idx.begin).toBeLessThan(idx.insertAgent)
    expect(idx.insertAgent).toBeLessThan(idx.safeInfo)
    expect(idx.safeInfo).toBeLessThan(idx.insertAllowance)
    expect(idx.insertAllowance).toBeLessThan(idx.commit)
    // The delegate address is lowercased before the duplicate check and insert.
    expect(mockQuery.mock.calls[idx.dupCheck][1]).toEqual(['user-1', VALID_DELEGATE, 'revoked'])
    await app.close()
  })

  it('409s on a pre-existing non-revoked agent for the delegate, before any transaction', async () => {
    const app = await makeApp()
    mockQuery.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (/SELECT id FROM user_safes WHERE id = \$1 AND user_id = \$2/.test(s)) {
        return { rows: [{ id: 'safe-1' }] }
      }
      if (/SELECT id FROM agents WHERE user_id = \$1 AND delegate_address/.test(s)) {
        return { rows: [{ id: 'agent-old' }] }
      }
      return { rows: [] }
    })

    const res = await app.inject({ method: 'POST', url: '/agents', payload: CREATE_BODY })
    expect(res.statusCode).toBe(409)
    expect(mockQuery.mock.calls.map(([sql]) => String(sql))).not.toContain('BEGIN')
    await app.close()
  })

  it('maps a unique-delegate conflict inside the transaction to 409 after ROLLBACK', async () => {
    const app = await makeApp()
    mockQuery.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (/SELECT id FROM user_safes WHERE id = \$1 AND user_id = \$2/.test(s)) {
        return { rows: [{ id: 'safe-1' }] }
      }
      if (/INSERT INTO agents/.test(s)) {
        const err = new Error('duplicate key') as Error & { code: string; constraint: string }
        err.code = '23505'
        err.constraint = 'idx_agents_user_delegate_non_revoked_unique'
        throw err
      }
      return { rows: [] }
    })

    const res = await app.inject({ method: 'POST', url: '/agents', payload: CREATE_BODY })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/already exists/)
    expect(mockQuery.mock.calls.some(([sql]) => String(sql) === 'ROLLBACK')).toBe(true)
    expect(mockQuery.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(false)
    await app.close()
  })
})

describe('PUT /agents/:id', () => {
  it('updates name/description and returns the row with its allowances', async () => {
    const app = await makeApp()
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', name: 'Renamed', description: 'new desc',
          delegate_address: VALID_DELEGATE, safe_id: 'safe-1',
          safe_address: '0x2222222222222222222222222222222222222222',
          safe_name: 'Main', safe_chain_id: 8453, account_type: null,
          api_key_prefix: 'sk_agent_abcd', status: 'active',
          created_at: '2026-08-05T00:00:00.000Z', mcp_last_seen_at: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'al-1', agent_id: 'agent-1', token_address: VALID_TOKEN, token_symbol: 'USDC', allowance_amount: '25000000', reset_period_min: 1440 }],
      })

    const res = await app.inject({
      method: 'PUT',
      url: '/agents/agent-1',
      payload: { name: '  Renamed  ', description: ' new desc ' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'agent-1', name: 'Renamed', allowances: [{ id: 'al-1' }] })
    // Trimmed inputs, tenant-scoped params, in this exact order.
    expect(mockQuery.mock.calls[0][1]).toEqual(['agent-1', 'user-1', 'Renamed', 'new desc'])
    expect(mockQuery.mock.calls[1][1]).toEqual(['agent-1'])
    await app.close()
  })

  it('404s when the agent does not exist for this user', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const res = await app.inject({ method: 'PUT', url: '/agents/agent-x', payload: { name: 'X' } })
    expect(res.statusCode).toBe(404)
    expect(mockQuery).toHaveBeenCalledTimes(1)
    await app.close()
  })
})

describe('DELETE /agents/:id — retired (#1401)', () => {
  it('is a 410 tombstone regardless of agent state, and touches the database not at all', async () => {
    // The old contract (delete revoked / 409 / 404) is GONE by design: hard
    // deletion 500'd on any agent with payment history and cascaded away
    // seven tables of audit trail where it succeeded. Removal is an archive
    // now — POST /agents/:id/archive.
    const app = await makeApp()
    mockQuery.mockClear()

    const res = await app.inject({ method: 'DELETE', url: '/agents/agent-1' })
    expect(res.statusCode).toBe(410)
    expect(res.json().error).toMatch(/archive/)
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /agents/:id/revoke', () => {
  it('revokes an active/paused agent and fires the passport revocation best-effort', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/revoke' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
    expect(String(mockQuery.mock.calls[0][0])).toContain("status IN ('active', 'paused')")
    expect(mockQuery.mock.calls[0][1]).toEqual(['agent-1', 'user-1'])
    expect(mockEnqueueRevocation).toHaveBeenCalledWith('agent-1')
    expect(mockRevokeBestEffort).toHaveBeenCalledWith('agent-1')
    await app.close()
  })

  it('a passport revocation enqueue failure never fails the revoke', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })
    mockEnqueueRevocation.mockRejectedValueOnce(new Error('eas down'))

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/revoke' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
    await app.close()
  })

  it('404s when nothing was revocable', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/revoke' })
    expect(res.statusCode).toBe(404)
    expect(mockEnqueueRevocation).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /agents/:id/rotate-key', () => {
  it('rotates the key of an active agent and returns the new secret once', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/rotate-key' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.api_key).toMatch(/^sk_agent_/)
    expect(body.api_key_prefix).toBe(body.api_key.slice(0, 12))
    const [sql, params] = mockQuery.mock.calls[0]
    expect(String(sql)).toContain("status = 'active'")
    // [hash, prefix, id, sub]
    expect(params[2]).toBe('agent-1')
    expect(params[3]).toBe('user-1')
    await app.close()
  })

  it('409s for an existing agent that is not active', async () => {
    const app = await makeApp()
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', status: 'paused' }] })

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/rotate-key' })
    expect(res.statusCode).toBe(409)
    await app.close()
  })

  it('404s for a missing agent', async () => {
    const app = await makeApp()
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const res = await app.inject({ method: 'POST', url: '/agents/agent-x/rotate-key' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

describe('POST /agents/:id/pause and /resume', () => {
  it('pauses an active agent', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/pause' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(String(sql)).toContain("SET status = 'paused'")
    expect(String(sql)).toContain("status = 'active'")
    expect(params).toEqual(['agent-1', 'user-1'])
    await app.close()
  })

  it('404s when pause matches nothing', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/pause' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('resumes a paused agent', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })

    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/resume' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(String(sql)).toContain("SET status = 'active'")
    expect(String(sql)).toContain("status = 'paused'")
    expect(params).toEqual(['agent-1', 'user-1'])
    await app.close()
  })

  it('404s when resume matches nothing', async () => {
    const app = await makeApp()
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: '/agents/agent-1/resume' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

describe('DELETE /agents/:id/allowances/:tokenAddress — happy path', () => {
  it('deletes the allowance after the ownership/status gate', async () => {
    const app = await makeApp()
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'al-1' }] })

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/agent-1/allowances/${VALID_TOKEN}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
    expect(mockQuery.mock.calls[0][1]).toEqual(['agent-1', 'user-1'])
    expect(mockQuery.mock.calls[1][1]).toEqual(['agent-1', VALID_TOKEN])
    await app.close()
  })

  it('404s when no allowance row matched', async () => {
    const app = await makeApp()
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [] })

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/agent-1/allowances/${VALID_TOKEN}`,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/Allowance not found/)
    await app.close()
  })
})
