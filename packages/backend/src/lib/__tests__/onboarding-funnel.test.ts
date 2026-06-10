import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))

import { emitFunnelEvent, queryFunnel } from '../onboarding-funnel.js'

describe('emitFunnelEvent', () => {
  beforeEach(() => mockQuery.mockReset())

  async function drainMicrotasks() {
    // Flush the async IIFE inside emitFunnelEvent
    await new Promise((r) => setTimeout(r, 0))
  }

  it('inserts the event fire-and-forget', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    emitFunnelEvent('usr-1', 'signed_up')
    await drainMicrotasks()
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO onboarding_events'),
      ['usr-1', 'signed_up', null],
    )
  })

  it('serialises metadata as JSON', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    emitFunnelEvent('usr-2', 'agent_created', { agent_id: 'agt-1' })
    await drainMicrotasks()
    const [, params] = mockQuery.mock.calls[0]
    expect(params[2]).toBe(JSON.stringify({ agent_id: 'agt-1' }))
  })

  it('uses ON CONFLICT DO NOTHING for idempotency', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    emitFunnelEvent('usr-1', 'first_payment_settled')
    await drainMicrotasks()
    const [sql] = mockQuery.mock.calls[0]
    expect(String(sql)).toContain('ON CONFLICT DO NOTHING')
  })
})

describe('queryFunnel', () => {
  beforeEach(() => mockQuery.mockReset())

  it('returns all 7 funnel steps', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { event: 'signed_up', users: '50' },
          { event: 'first_payment_settled', users: '10' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ median_ms: '300000' }] })

    const from = new Date('2026-01-01')
    const to = new Date('2026-07-01')
    const { steps, medianTtfpMs } = await queryFunnel(from, to)

    expect(steps).toHaveLength(7)
    expect(medianTtfpMs).toBe(300000)

    const signedUp = steps.find((s) => s.event === 'signed_up')!
    expect(signedUp.users).toBe(50)
    expect(signedUp.conversionFromPrev).toBeNull()

    // Steps with 0 users because not in the mock result
    const safeDeployed = steps.find((s) => s.event === 'safe_deployed')!
    expect(safeDeployed.users).toBe(0)
  })

  it('returns null medianTtfpMs when no completions', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ median_ms: null }] })

    const { medianTtfpMs } = await queryFunnel(new Date('2026-01-01'), new Date('2026-07-01'))
    expect(medianTtfpMs).toBeNull()
  })

  it('computes conversion rate correctly', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { event: 'signed_up', users: '200' },
          { event: 'safe_deployed', users: '100' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ median_ms: null }] })

    const { steps } = await queryFunnel(new Date('2026-01-01'), new Date('2026-07-01'))
    const safeDeployed = steps.find((s) => s.event === 'safe_deployed')!
    expect(safeDeployed.conversionFromPrev).toBe(50) // 100/200 = 50%
  })
})
