import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

import { claimSync, markPushed, markFailed } from '../feed-sync.js'

describe('feed-sync dedup ledger (#497)', () => {
  beforeEach(() => mockQuery.mockReset())

  it('owns a fresh claim (insert wins via the unique constraint)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'x' }] }) // INSERT ... RETURNING id
    const res = await claimSync('u1', 'fortnox', 'pi1')
    expect(res).toEqual({ owned: true, status: 'pending' })
    expect(mockQuery.mock.calls[0][0]).toContain('ON CONFLICT')
    expect(mockQuery.mock.calls[0][0]).toContain('DO NOTHING')
  })

  it('does not own a re-push of an already-pushed payment (no-op)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // INSERT conflict
      .mockResolvedValueOnce({ rows: [] }) // re-claim UPDATE (status != 'failed') → none
      .mockResolvedValueOnce({ rows: [{ status: 'pushed', external_ref: 'fx1' }] }) // getSyncState
    const res = await claimSync('u1', 'fortnox', 'pi1')
    expect(res).toEqual({ owned: false, status: 'pushed' })
  })

  it('re-claims a previously failed payment for retry', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // INSERT conflict
      .mockResolvedValueOnce({ rows: [{ id: 'x' }] }) // re-claim UPDATE on status='failed'
    const res = await claimSync('u1', 'fortnox', 'pi1')
    expect(res).toEqual({ owned: true, status: 'pending' })
    expect(mockQuery.mock.calls[1][0]).toContain("status = 'failed'")
  })

  it('markPushed records the external ref; markFailed records the error', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await markPushed('u1', 'fortnox', 'pi1', 'voucher-42')
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'pushed'")
    expect((mockQuery.mock.calls[0][1] as unknown[])[3]).toBe('voucher-42')

    mockQuery.mockReset().mockResolvedValue({ rows: [] })
    await markFailed('u1', 'fortnox', 'pi1', 'boom')
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'failed'")
    expect((mockQuery.mock.calls[0][1] as unknown[])[3]).toBe('boom')
  })
})
