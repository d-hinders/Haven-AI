import { describe, expect, it } from 'vitest'
import { orderAgentsForDisplay, seriesIndexByAgent } from '../analytics-series'
import type { AnalyticsAgentRow, AnalyticsDayBucket } from '@/types/analytics'

/**
 * The one order and one colour map every analytics section reads (#3051).
 * The wire's `agents[]` has no ORDER BY, so two requests can disagree on
 * position; a colour keyed on position would then move under the reader.
 */
function agent(id: string, spent: string): AnalyticsAgentRow {
  return {
    id,
    name: id,
    status: 'active',
    spent,
    share: 0,
    payments: 0,
    refusals: 0,
    refusal_attempts: 0,
    budgets: [],
    top_merchant: null,
    last_payment_at: null,
  }
}

describe('orderAgentsForDisplay', () => {
  it('sorts spend descending, then id, and does not mutate the wire array', () => {
    const wire = [agent('b', '5.00'), agent('c', '10.00'), agent('a', '5.00'), agent('z', '0')]
    const ordered = orderAgentsForDisplay(wire)
    expect(ordered.map((a) => a.id)).toEqual(['c', 'a', 'b', 'z'])
    expect(wire.map((a) => a.id)).toEqual(['b', 'c', 'a', 'z'])
  })

  it('gives the same order for two wire orders of the same rows', () => {
    const rows = [agent('b', '5.00'), agent('c', '10.00'), agent('a', '5.00')]
    expect(orderAgentsForDisplay(rows).map((a) => a.id)).toEqual(orderAgentsForDisplay([...rows].reverse()).map((a) => a.id))
  })
})

describe('seriesIndexByAgent', () => {
  const days: AnalyticsDayBucket[] = [
    { date: '2026-07-07', spent_by_agent: { c: '10.00', a: '5.00' }, refusals: 0 },
    { date: '2026-07-08', spent_by_agent: { a: '1.00' }, refusals: 0 },
  ]

  it('numbers only the agents that appear on the chart, in display order', () => {
    const ordered = orderAgentsForDisplay([agent('b', '5.00'), agent('c', '10.00'), agent('a', '5.00'), agent('z', '0')])
    const map = seriesIndexByAgent(ordered, days)
    expect([...map.entries()]).toEqual([
      ['c', 0],
      ['a', 1],
    ])
    expect(map.has('b')).toBe(false)
    expect(map.has('z')).toBe(false)
  })

  it('does not spend a colour on a rostered agent with no bar, so seven agents with two spenders use two tokens', () => {
    const roster = orderAgentsForDisplay(['p', 'q', 'r', 's', 't', 'u', 'v'].map((id) => agent(id, '0')).concat([agent('a', '5.00'), agent('c', '10.00')]))
    const map = seriesIndexByAgent(roster, days)
    expect(map.size).toBe(2)
    expect(Math.max(...map.values())).toBe(1)
  })

  it('names a by_day id the roster does not carry, after the rostered ones', () => {
    const map = seriesIndexByAgent([agent('c', '10.00')], [{ date: '2026-07-07', spent_by_agent: { c: '1', ghost: '2' }, refusals: 0 }])
    expect(map.get('c')).toBe(0)
    expect(map.get('ghost')).toBe(1)
  })
})
