import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

import { claimSync, markPushed, markFailed, recordMerchantInvoiceSync, getMerchantInvoiceSyncRef } from '../feed-sync.js'

describe('feed-sync dedup ledger (#497)', () => {
  beforeEach(() => mockQuery.mockReset())

  it('owns a fresh claim (insert wins via the unique constraint)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'x' }] }) // INSERT ... RETURNING id
    const res = await claimSync('u1', 'fortnox', 'pi1')
    expect(res).toEqual({ owned: true, status: 'pending', fresh: true })
    expect(mockQuery.mock.calls[0][0]).toContain('ON CONFLICT')
    expect(mockQuery.mock.calls[0][0]).toContain('DO NOTHING')
  })

  it('does not own a re-push of an already-pushed payment (no-op)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // INSERT conflict
      .mockResolvedValueOnce({ rows: [] }) // re-claim UPDATE (status != 'failed') → none
      .mockResolvedValueOnce({ rows: [{ status: 'pushed', external_ref: 'fx1' }] }) // getSyncState
    const res = await claimSync('u1', 'fortnox', 'pi1')
    expect(res).toEqual({ owned: false, status: 'pushed', fresh: false })
  })

  it('re-claims a previously failed payment for retry', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // INSERT conflict
      .mockResolvedValueOnce({ rows: [{ id: 'x' }] }) // re-claim UPDATE on status='failed'
    const res = await claimSync('u1', 'fortnox', 'pi1')
    expect(res).toEqual({ owned: true, status: 'pending', fresh: false })
    // #1365: skipped rows are re-claimable exactly like failed ones.
    expect(mockQuery.mock.calls[1][0]).toContain("status IN ('failed', 'skipped')")
  })

  it('markPushed records the external ref; markFailed records the error', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await markPushed('u1', 'fortnox', 'pi1', 'voucher-42')
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'pushed'")
    expect((mockQuery.mock.calls[0][1] as unknown[])[3]).toBe('voucher-42')
    expect((mockQuery.mock.calls[0][1] as unknown[])[4]).toBeNull()

    // #498: a non-fatal note (e.g. failed receipt attachment) rides the error
    // column on a PUSHED row — observable, but never retryable.
    mockQuery.mockReset().mockResolvedValue({ rows: [] })
    await markPushed('u1', 'fortnox', 'pi1', 'voucher-42', 'receipt attachment failed: x')
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'pushed'")
    expect((mockQuery.mock.calls[0][1] as unknown[])[4]).toBe('receipt attachment failed: x')

    mockQuery.mockReset().mockResolvedValue({ rows: [] })
    await markFailed('u1', 'fortnox', 'pi1', 'boom')
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'failed'")
    expect((mockQuery.mock.calls[0][1] as unknown[])[3]).toBe('boom')
  })

  /**
   * #3918: a merchant-invoice row is delivery bookkeeping, not retry state —
   * no claim/mark statement may reach it, and its own writer names the kind.
   * (Assertions on the SQL text, not positional chains — the ratchet counts
   * those.)
   */
  it('the generic statements are scoped to the underlag kind; the merchant-invoice writer names its own', async () => {
    mockQuery.mockReset().mockResolvedValue({ rows: [] })
    await markPushed('u1', 'accounted', 'pi1', 'accounted:document:d1')
    expect(mockQuery.mock.calls[0][0]).toContain("document_kind = 'underlag'")
    await markFailed('u1', 'accounted', 'pi1', 'boom')
    expect(mockQuery.mock.calls[1][0]).toContain("document_kind = 'underlag'")
    await recordMerchantInvoiceSync('u1', 'accounted', 'pi1', 'accounted:document:d2')
    expect(mockQuery.mock.calls[2][0]).toContain("'merchant_invoice'")
    expect(mockQuery.mock.calls[2][0]).toContain('ON CONFLICT (provider, payment_id, user_id, document_kind) DO NOTHING')
    await getMerchantInvoiceSyncRef('u1', 'accounted', 'pi1')
    expect(mockQuery.mock.calls[3][0]).toContain("'merchant_invoice'")
  })

})
