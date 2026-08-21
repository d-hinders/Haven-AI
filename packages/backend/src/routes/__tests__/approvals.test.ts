import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const mockQuery = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

// The execution path snapshots a fiat value; stubbed so the 200/409 paths are
// testable without a price source (#1446).
const mockFiat = vi.fn(async (_symbol: string, _amount: string) => ({ usd: '1.00', eur: '0.92' }))
vi.mock('../../infra/fiat-values.js', () => ({
  getFiatValuesForTokenAmount: (symbol: string, amount: string) => mockFiat(symbol, amount),
}))

import approvalRoutes from '../approvals.js'

describe('approval routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(approvalRoutes, { prefix: '/approvals' })
    token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('GET / includes merchant_address, payment_rail, payment_resource_url for x402 approval rows', async () => {
    const x402Row = {
      id: 'a1b2c3d4-5e6f-4708-9a1b-2c3d4e5f6071',
      agent_id: 'c3d4e5f6-7081-492a-bc3d-4e5f60718293',
      user_id: 'user-1',
      safe_address: '0x' + 'ab'.repeat(20),
      chain_id: 100,
      token_symbol: 'USDC',
      token_address: '0xToken',
      to_address: '0xDelegate',
      amount_raw: '1000000',
      amount_human: '1.000000',
      reason: 'x402 API call',
      source: 'x402',
      x402_resource_url: 'https://api.example.com/resource',
      payment_rail: 'x402',
      payment_resource_url: 'https://api.example.com/resource',
      merchant_address: '0xMerchant',
      status: 'pending',
      tx_hash: null,
      reviewed_at: null,
      usd_value: null,
      eur_value: null,
      executed_at: null,
      created_at: '2026-05-25T00:00:00Z',
      expires_at: '2026-05-26T00:00:00Z',
    }

    // expire stale, SELECT rows, agent names, actionable count
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // expire UPDATE
      .mockResolvedValueOnce({ rows: [x402Row] }) // SELECT approvals
      .mockResolvedValueOnce({ rows: [{ id: 'c3d4e5f6-7081-492a-bc3d-4e5f60718293', name: 'Test Agent' }] }) // agent names
      .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // actionable count

    const response = await app.inject({
      method: 'GET',
      url: '/approvals',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    const approval = body.approvals[0]
    expect(approval.merchant_address).toBe('0xMerchant')
    expect(approval.payment_rail).toBe('x402')
    expect(approval.payment_resource_url).toBe('https://api.example.com/resource')
    expectMatchesSpec('GET', '/approvals', body)
    // legacy fields must still be present
    expect(approval.to_address).toBe('0xDelegate')
    expect(approval.source).toBe('x402')
    expect(approval.x402_resource_url).toBe('https://api.example.com/resource')
  })

  it('POST /:id/approve derives source from payment_rail so it matches GET /', async () => {
    // Row where the legacy `source` column is stale but payment_rail is the
    // authoritative rail. GET / coalesces this via SQL; POST /:id/approve must
    // do the same in JS so both endpoints agree.
    const approvedRow = {
      id: 'a1b2c3d4-5e6f-4708-9a1b-2c3d4e5f6071',
      agent_id: 'c3d4e5f6-7081-492a-bc3d-4e5f60718293',
      user_id: 'user-1',
      safe_address: '0x' + 'ab'.repeat(20),
      chain_id: 100,
      token_symbol: 'USDC',
      token_address: '0xToken',
      to_address: '0xDelegate',
      amount_raw: '1000000',
      amount_human: '1.000000',
      reason: 'x402 API call',
      source: 'direct',
      x402_resource_url: null,
      payment_rail: 'x402',
      payment_resource_url: 'https://api.example.com/resource',
      merchant_address: '0xMerchant',
      status: 'approved',
      tx_hash: null,
      reviewed_at: '2026-05-25T00:00:00Z',
      usd_value: null,
      eur_value: null,
      executed_at: null,
      created_at: '2026-05-25T00:00:00Z',
      expires_at: '2026-05-26T00:00:00Z',
    }
    mockQuery.mockResolvedValueOnce({ rows: [approvedRow] })

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/a1b2c3d4-5e6f-4708-9a1b-2c3d4e5f6071/approve',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.payment.source).toBe('x402')
    expect(body.payment.payment_rail).toBe('x402')
    expect(body.payment.merchant_address).toBe('0xMerchant')
    // Resource URL should also prefer payment_resource_url over legacy x402_resource_url
    expect(body.payment.x402_resource_url).toBe('https://api.example.com/resource')
    expect(body.payment.payment_resource_url).toBe('https://api.example.com/resource')
    expectMatchesSpec('POST', '/approvals/{id}/approve', body)
  })

  it('POST /:id/approve resolves resource URL from legacy x402_resource_url when payment_resource_url is null', async () => {
    // Legacy row shape: payment_resource_url was added later, so older x402
    // approvals only have the value in x402_resource_url. Both response fields
    // must resolve to the same URL so downstream callers don't have to coalesce.
    const legacyRow = {
      id: 'b2c3d4e5-6f70-4819-ab2c-3d4e5f607182',
      agent_id: 'c3d4e5f6-7081-492a-bc3d-4e5f60718293',
      user_id: 'user-1',
      safe_address: '0x' + 'ab'.repeat(20),
      chain_id: 100,
      token_symbol: 'USDC',
      token_address: '0xToken',
      to_address: '0xDelegate',
      amount_raw: '1000000',
      amount_human: '1.000000',
      reason: 'x402 API call',
      source: 'x402',
      x402_resource_url: 'https://legacy.example.com/resource',
      payment_rail: 'x402',
      payment_resource_url: null,
      merchant_address: '0xMerchant',
      status: 'approved',
      tx_hash: null,
      reviewed_at: '2026-05-25T00:00:00Z',
      usd_value: null,
      eur_value: null,
      executed_at: null,
      created_at: '2026-05-25T00:00:00Z',
      expires_at: '2026-05-26T00:00:00Z',
    }
    mockQuery.mockResolvedValueOnce({ rows: [legacyRow] })

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/b2c3d4e5-6f70-4819-ab2c-3d4e5f607182/approve',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.payment.x402_resource_url).toBe('https://legacy.example.com/resource')
    expect(body.payment.payment_resource_url).toBe('https://legacy.example.com/resource')
  })

  it('marks an approved request as proposed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'd4e5f607-1829-4a3b-8c4d-5e6f70819304' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/d4e5f607-1829-4a3b-8c4d-5e6f70819304/proposed',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: 'd4e5f607-1829-4a3b-8c4d-5e6f70819304', status: 'proposed' })
    expectMatchesSpec('POST', '/approvals/{id}/proposed', response.json())
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'approved' AND expires_at > NOW()"),
      ['d4e5f607-1829-4a3b-8c4d-5e6f70819304', 'user-1'],
    )
  })

  it('does not mark pending or expired requests as proposed', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/d4e5f607-1829-4a3b-8c4d-5e6f70819304/proposed',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: 'Approval request not found or no longer actionable',
    })
  })

  it('#1446: records the execution and matches the documented shape', async () => {
    // The 200 path had no test at all — only the malformed-hash 400 was
    // covered, so the documented { id, status, tx_hash } shape was a guess.
    const TX = '0x' + 'ab'.repeat(32)
    mockQuery.mockImplementation(async (sql: string) =>
      /^\s*SELECT/i.test(String(sql))
        ? { rows: [{ id: 'd4e5f607-1829-4a3b-8c4d-5e6f70819304', token_symbol: 'USDC', amount_human: '1.000000' }] }
        : { rows: [{ id: 'd4e5f607-1829-4a3b-8c4d-5e6f70819304' }] },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/d4e5f607-1829-4a3b-8c4d-5e6f70819304/executed',
      headers: { authorization: `Bearer ${token}` },
      payload: { tx_hash: TX },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: 'd4e5f607-1829-4a3b-8c4d-5e6f70819304', status: 'executed', tx_hash: TX })
    expectMatchesSpec('POST', '/approvals/{id}/executed', response.json())
    // The flip is re-guarded in the UPDATE, not trusted from the SELECT.
    const updateSql = String(mockQuery.mock.calls[1][0])
    expect(updateSql).toContain("status = 'approved' AND expires_at > NOW()")
  })

  it('#1446: 409 when it stopped being approved between the read and the write', async () => {
    // The TOCTOU window the second guard exists to close: the row was
    // approved at SELECT time and is not at UPDATE time.
    mockQuery.mockImplementation(async (sql: string) =>
      /^\s*SELECT/i.test(String(sql))
        ? { rows: [{ id: 'd4e5f607-1829-4a3b-8c4d-5e6f70819304', token_symbol: 'USDC', amount_human: '1.000000' }] }
        : { rows: [] },
    )

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/d4e5f607-1829-4a3b-8c4d-5e6f70819304/executed',
      headers: { authorization: `Bearer ${token}` },
      payload: { tx_hash: '0x' + 'cd'.repeat(32) },
    })

    // Distinct from the 404: this one WAS approvable and no longer is.
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/no longer approved/)
  })

  it('rejects malformed execution transaction hashes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/approvals/d4e5f607-1829-4a3b-8c4d-5e6f70819304/executed',
      headers: { authorization: `Bearer ${token}` },
      payload: { tx_hash: '0xabc' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'Valid tx_hash is required' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

// ── #1328 (review finding on #1339): historical mpp_demo approvals are
// readable and rejectable, never approvable/proposable ──────────────────────

describe('mpp_demo retirement gates (#1328)', () => {
  /** SQL-pattern-routed mock (the payments.test.ts style — never positional). */
  function primeApprovalDb(opts: { railRow: { payment_rail: string | null; source: string | null } | null }) {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (/^\s*UPDATE approval_requests/.test(text)) return { rows: [] } // guarded UPDATE matches nothing
      if (/SELECT payment_rail, source/.test(text)) return { rows: opts.railRow ? [opts.railRow] : [] }
      return { rows: [] }
    })
  }

  it('POST /:id/approve refuses an mpp_demo approval — 410, guard lives in the UPDATE WHERE (nothing written)', async () => {
    // MUTATION PROOF: dropping the WHERE-clause guard makes the UPDATE return
    // the row → 200 → this test fails.
    primeApprovalDb({ railRow: { payment_rail: 'mpp_demo', source: 'mpp_demo' } })
    const response = await app.inject({
      method: 'POST',
      url: '/approvals/e5f60718-293a-4b4c-9d5e-6f7081930415/approve',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toMatch(/mpp_demo flow is retired/)
    const updateSql = String(mockQuery.mock.calls.find((c) => /UPDATE approval_requests/.test(String(c[0])))![0])
    expect(updateSql).toContain("COALESCE(payment_rail, source, 'direct') <> 'mpp_demo'")
  })

  it('POST /:id/proposed refuses an mpp_demo approval the same way', async () => {
    primeApprovalDb({ railRow: { payment_rail: 'mpp_demo', source: 'mpp_demo' } })
    const response = await app.inject({
      method: 'POST',
      url: '/approvals/e5f60718-293a-4b4c-9d5e-6f7081930415/proposed',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toMatch(/mpp_demo flow is retired/)
  })

  it('a missing row is still a plain 404, not a retirement message', async () => {
    primeApprovalDb({ railRow: null })
    const response = await app.inject({
      method: 'POST',
      url: '/approvals/approval-gone/approve',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(404)
  })

  it('POST /:id/reject still works for mpp_demo — cleanup stays possible', async () => {
    mockQuery.mockImplementation(async (sql: unknown) =>
      /UPDATE approval_requests/.test(String(sql)) ? { rows: [{ id: 'approval-mpp' }] } : { rows: [] },
    )
    const response = await app.inject({
      method: 'POST',
      url: '/approvals/e5f60718-293a-4b4c-9d5e-6f7081930415/reject',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    // The reject UPDATE carries no mpp_demo exclusion:
    const rejectSql = String(mockQuery.mock.calls.find((c) => /UPDATE approval_requests/.test(String(c[0])))![0])
    expect(rejectSql).not.toContain('mpp_demo')
    expectMatchesSpec('POST', '/approvals/{id}/reject', response.json())
  })
})
})
