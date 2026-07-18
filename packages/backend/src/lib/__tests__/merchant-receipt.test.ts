/**
 * #956 merchant-receipt capture: validation, agent scoping, first-write-wins.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

const {
  captureMerchantReceipt,
  validateMerchantReceiptUrl,
  MERCHANT_RECEIPT_INLINE_MAX_BYTES,
} = await import('../merchant-receipt.js')

beforeEach(() => {
  mockQuery.mockReset()
})

describe('validateMerchantReceiptUrl', () => {
  it('accepts https, rejects http/garbage/oversized', () => {
    expect(validateMerchantReceiptUrl('https://merchant.example/receipt.pdf')).toBeNull()
    expect(validateMerchantReceiptUrl('http://merchant.example/receipt.pdf')).toMatch(/https/)
    expect(validateMerchantReceiptUrl('not a url')).toMatch(/valid absolute URL/)
    expect(validateMerchantReceiptUrl('https://x.example/' + 'a'.repeat(3000))).toMatch(/too long/)
  })
})

describe('captureMerchantReceipt (#956)', () => {
  const EVIDENCE = { rows: [{ id: 'ev-1' }] }

  it('stores an inline receipt against the agent-scoped evidence row', async () => {
    mockQuery.mockResolvedValueOnce(EVIDENCE) // evidence lookup
    mockQuery.mockResolvedValueOnce({ rows: [{ evidence_id: 'ev-1' }] }) // insert won
    const res = await captureMerchantReceipt({
      paymentId: 'pay-1', agentId: 'agent-1', inlineJson: { fakturanummer: 'FAK-1' },
    })
    expect(res).toEqual({ ok: true, stored: true })
    // Agent scoping is in the SQL, not trust:
    const [lookupSql, lookupParams] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(lookupSql).toMatch(/COALESCE\(pi\.agent_id, ar\.agent_id\) = \$2/)
    expect(lookupParams).toEqual(['pay-1', 'agent-1'])
  })

  it('first write wins — a duplicate report is dropped, not replaced', async () => {
    mockQuery.mockResolvedValueOnce(EVIDENCE)
    mockQuery.mockResolvedValueOnce({ rows: [] }) // ON CONFLICT DO NOTHING
    const res = await captureMerchantReceipt({
      paymentId: 'pay-1', agentId: 'agent-1', inlineJson: { different: 'doc' },
    })
    expect(res).toEqual({ ok: true, stored: false })
  })

  it('404s when no settled evidence exists for the agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const res = await captureMerchantReceipt({
      paymentId: 'pay-x', agentId: 'agent-1', url: 'https://m.example/r.pdf',
    })
    expect(res).toEqual({ ok: false, code: 404, error: expect.stringMatching(/No settled payment evidence/) })
  })

  it('rejects empty, oversized-inline and bad-url inputs without touching the db', async () => {
    expect(await captureMerchantReceipt({ paymentId: 'p', agentId: 'a' })).toMatchObject({ ok: false, code: 400 })
    expect(await captureMerchantReceipt({ paymentId: 'p', agentId: 'a', url: 'http://x.example' }))
      .toMatchObject({ ok: false, code: 400 })
    const big = { blob: 'x'.repeat(MERCHANT_RECEIPT_INLINE_MAX_BYTES) }
    expect(await captureMerchantReceipt({ paymentId: 'p', agentId: 'a', inlineJson: big }))
      .toMatchObject({ ok: false, code: 400, error: expect.stringMatching(/inline cap/) })
    expect(await captureMerchantReceipt({ paymentId: 'p', agentId: 'a', inlineJson: 'not-an-object' }))
      .toMatchObject({ ok: false, code: 400 })
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
