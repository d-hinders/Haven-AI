import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import Fastify, { type FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import fastifyJwt from '@fastify/jwt'

const mockQuery = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

import agentActivityRoutes from '../agent-activity.js'

// #2055 (epic #1440, #2021 readability waiver): `approval_requests` is
// dropped and the activity/feed routes no longer query it at all — the
// `isUserApprovalCount` SQL-shape matcher this file used to pin the
// user-scoped approval COUNT is gone along with the query it matched;
// `pending_approvals` is now hardcoded 0 in both routes (asserted below).

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const TOKEN_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const MERCHANT_ADDRESS = '0x2222222222222222222222222222222222222222'
const TX_HASH = '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1'

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payment-1',
    agent_id: 'agent-1',
    account_id: 'safe-base',
    account_address: SAFE_ADDRESS,
    account_name: 'Base wallet',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: TOKEN_ADDRESS,
    amount_raw: '10000',
    amount_human: '0.01',
    to_address: MERCHANT_ADDRESS,
    status: 'confirmed',
    tx_hash: TX_HASH,
    source: 'x402',
    x402_resource_url: 'https://api.example.com/data',
    x402_merchant_address: MERCHANT_ADDRESS,
    payment_rail: 'x402',
    payment_resource_url: 'https://api.example.com/data',
    merchant_address: MERCHANT_ADDRESS,
    payment_proof_status: 'payment_confirmed',
    payment_reconciliation_event_type: null,
    created_at: '2026-05-08T11:49:00Z',
    confirmed_at: '2026-05-08T11:49:59Z',
    ...overrides,
  }
}

describe('agent activity routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(agentActivityRoutes, { prefix: '/agent-activity' })
    token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  // #2263 (migration 075): was "exposes execution_rail + pinned
  // session_permission_id on payments (#799 rollover observability)". The
  // pinned `session_permission_id` half is gone — the column was dropped with
  // the rest of the inert session/Safe-rail schema, having been NULL on every
  // row any live code path could write since #834 deleted its only supplier.
  // `execution_rail` is the half that still carries information (it is what
  // routes an intent to its rail or its tombstone), so the observability
  // claim narrows to it rather than disappearing.
  it('exposes the pinned execution_rail on payments (#799 rollover observability)', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM agents')) return { rows: [{ id: 'agent-1' }] }
      if (sql.includes('FROM payment_intents pi')) {
        return { rows: [paymentRow({ execution_rail: 'session_key' })] }
      }
      if (sql.includes('FROM agent_tool_invocations')) return { rows: [] }
      throw new Error(`Unexpected query: ${sql}`)
    })

    const response = await app.inject({
      method: 'GET',
      url: '/agent-activity/agent-1/activity',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const payment = response.json().activity[0]
    expect(payment).toMatchObject({
      type: 'payment',
      execution_rail: 'session_key',
    })
    expect(payment).not.toHaveProperty('session_permission_id')
    // The SELECT actually fetches the column (schema-smoke guards the shape),
    // and no longer fetches the dropped one — a stale `pi.session_permission_id`
    // would be a hard SQL error against the post-075 schema, so this pins the
    // query and the migration together.
    const paymentSql = String(
      mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM payment_intents pi'))?.[0],
    )
    expect(paymentSql).toContain('pi.execution_rail')
    expect(paymentSql).not.toContain('session_permission_id')
  })

  // #2055: was "uses stored payment and approval Safe identity for a single
  // agent activity feed" — the approval branch is gone with the table, so
  // this pins the payment branch alone and that no approval query runs.
  it('uses stored payment Safe identity for a single agent activity feed', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM agents')) {
        return { rows: [{ id: 'agent-1' }] }
      }
      if (sql.includes('FROM payment_intents pi')) {
        return { rows: [paymentRow()] }
      }
      if (sql.includes('FROM agent_tool_invocations')) {
        return { rows: [] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })

    const response = await app.inject({
      method: 'GET',
      url: '/agent-activity/agent-1/activity',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.activity).toHaveLength(1)
    expectMatchesSpec('GET', '/agent-activity/{id}/activity', body)
    expect(body.activity[0]).toMatchObject({
      type: 'payment',
      account_id: 'safe-base',
      account_address: SAFE_ADDRESS,
      account_name: 'Base wallet',
      chain_id: 8453,
    })
    // #2914 (naming epic #2906 phase 5, the contraction): the twin `#2907`
    // dual-emitted is gone — one name only, and the old ones must be absent.
    expect(body.activity[0].safe_id).toBeUndefined()
    expect(body.activity[0].safe_address).toBeUndefined()
    expect(body.activity[0].safe_name).toBeUndefined()

    const paymentSql = String(
      mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM payment_intents pi'))?.[0],
    )
    expect(paymentSql).toContain('LOWER(us.account_address) = LOWER(pi.account_address)')
    expect(paymentSql).toContain('us.chain_id = pi.chain_id')
    expect(paymentSql).not.toContain('us.id = a.account_id')
    // No approval-sourced entry, and no query against the dropped table.
    expect(mockQuery.mock.calls.some(([sql]) => /approval_requests/i.test(String(sql)))).toBe(false)
  })

  // #2055: was "uses stored payment and approval Safe identity for the
  // all-agent activity feed" — same reduction, plus `pending_approvals` is
  // now hardcoded 0 rather than read from a COUNT query.
  it('uses stored payment Safe identity for the all-agent activity feed, pending_approvals hardcoded 0', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, name FROM agents')) {
        return { rows: [{ id: 'agent-1', name: 'Research agent' }] }
      }
      if (sql.includes('FROM payment_intents pi')) {
        return { rows: [paymentRow()] }
      }
      if (sql.includes('FROM agent_tool_invocations')) {
        return { rows: [] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })

    const response = await app.inject({
      method: 'GET',
      url: '/agent-activity/feed?limit=10',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.pending_approvals).toBe(0)
    expect(body.activity).toHaveLength(1)
    // The FEED route had no schema assertion at all (#1446 review).
    expectMatchesSpec('GET', '/agent-activity/feed', body)
    expect(body.activity[0]).toMatchObject({
      type: 'payment',
      agent_id: 'agent-1',
      agent_name: 'Research agent',
      account_id: 'safe-base',
      account_address: SAFE_ADDRESS,
      chain_id: 8453,
    })
    expect(body.activity[0].safe_id).toBeUndefined()
    expect(body.activity[0].safe_address).toBeUndefined()
    expect(body.activity[0].safe_name).toBeUndefined()
    expect(mockQuery.mock.calls.some(([sql]) => /approval_requests/i.test(String(sql)))).toBe(false)
  })

  /**
   * #3129: this feed renders the SAME payments as the transaction feed, on
   * `/agents/[agentId]`. The transaction feed normalises its addresses at the
   * row boundary; if this route passed `payment_intents` casing through, one
   * payment would read `0xabcd…1234` on the agent screen and `0xAbCd…1234` on
   * `/transactions` — the defect would have moved, not closed.
   */
  it.each([
    ['per-agent', '/agent-activity/agent-1/activity', 'SELECT id FROM agents', [{ id: 'agent-1' }]],
    [
      'all-agent feed',
      '/agent-activity/feed?limit=10',
      'SELECT id, name FROM agents',
      [{ id: 'agent-1', name: 'Research agent' }],
    ],
  ] as const)(
    'emits every address in one canonical form on the %s mapper, from a row that mixes both (#3129)',
    async (_label, url, agentSql, agentRows) => {
      // A merchant address with hex LETTERS in it: the file's other constants
      // are all-digit, so their checksummed and lowercase forms are identical
      // and could not tell the two apart.
      const lowercaseMerchant = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
      const lowercaseAccount = '0xab5801a7d398351b8be11c439e05c5b3259aec9b'
      const lowercaseToken = TOKEN_ADDRESS.toLowerCase()
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes(agentSql)) {
          return { rows: [...agentRows] }
        }
        if (sql.includes('FROM payment_intents pi')) {
          return {
            rows: [
              paymentRow({
                // The mix the field run found: account/token checksummed,
                // counterparty and merchant lowercase, in ONE row.
                // Lowercase, and letter-bearing: the file's own constants are
                // all-digit (`0x1111…`), whose two forms are byte-identical, so
                // asserting on them would pass with the fix reverted.
                account_address: lowercaseAccount,
                token_address: lowercaseToken,
                to_address: lowercaseMerchant,
                x402_merchant_address: lowercaseMerchant,
              }),
            ],
          }
        }
        if (sql.includes('FROM agent_tool_invocations')) {
          return { rows: [] }
        }
        throw new Error(`Unexpected query: ${sql}`)
      })

      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      })

      expect(response.statusCode).toBe(200)
      const row = response.json().activity[0]

      const expectedMerchant = ethers.getAddress(lowercaseMerchant)
      expect(row.to).toBe(expectedMerchant)
      expect(row.x402_merchant_address).toBe(expectedMerchant)
      expect(row.account_address).toBe(ethers.getAddress(lowercaseAccount))
      expect(row.token_address).toBe(ethers.getAddress(lowercaseToken))

      // CONTROL: every fixture form really differs from its canonical form, so
      // all four assertions above can fail.
      for (const raw of [lowercaseMerchant, lowercaseAccount, lowercaseToken]) {
        expect(ethers.getAddress(raw)).not.toBe(raw)
        }
    },
  )
})
