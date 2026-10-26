import { describe, expect, it } from 'vitest'
import { orderAgentsForDisplay, seriesColorByAgent } from '../analytics-series'
import { avatarTint, seriesColorForAgent } from '../avatar-tint'
import type { AnalyticsAgentRow, AnalyticsDayBucket } from '@/types/analytics'

/**
 * The one order and one colour map every analytics section reads (#3051).
 * The wire's `agents[]` has no ORDER BY, so two requests can disagree on
 * position; a colour keyed on position would then move under the reader.
 */
function agent(id: string, spent: string, tint = 1): AnalyticsAgentRow {
  return {
    id,
    name: id,
    status: 'active',
    // #4431: every analytics agent row carries its STORED tint; the colour
    // map reads it instead of the name hash.
    avatar_tint: tint,
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

describe('seriesColorByAgent', () => {
  const days: AnalyticsDayBucket[] = [
    { date: '2026-07-07', spent_by_agent: { c: '10.00', a: '5.00' }, refusals: 0 },
    { date: '2026-07-08', spent_by_agent: { a: '1.00' }, refusals: 0 },
  ]

  it('maps every rostered agent to its own avatar tint — the colour its monogram wears', () => {
    // Distinct stored tints, each deliberately NOT the name's hash (a→5,
    // b→6, c→1, z→6), so the assertion proves the STORED tint is read.
    const ordered = orderAgentsForDisplay([
      agent('b', '5.00', 2),
      agent('c', '10.00', 3),
      agent('a', '5.00', 4),
      agent('z', '0', 5),
    ])
    const map = seriesColorByAgent(ordered, days)
    expect(map.get('c')).toBe('var(--v2-avatar-3)')
    expect(map.get('a')).toBe('var(--v2-avatar-4)')
    // Whether an agent appears in `by_day` no longer decides its colour
    // (#4331): the tint is stored on the agent (#4428) and repeats past the
    // first six rather than running out, so b and z carry theirs too (they
    // plot on other pages and periods).
    expect(map.get('b')).toBe('var(--v2-avatar-2)')
    expect(map.get('z')).toBe('var(--v2-avatar-5)')
    // The stored tint wins over the hash — the whole point of #4428/#4431.
    expect(map.get('c')).not.toBe(seriesColorForAgent({ name: 'c' }))
    expect(map.get('a')).not.toBe(seriesColorForAgent({ name: 'a' }))
  })

  it('is rank-independent: the same agent keeps its colour under any display order', () => {
    const rows = [agent('b', '5.00', 2), agent('c', '10.00', 3), agent('a', '5.00', 4)]
    const forward = seriesColorByAgent(orderAgentsForDisplay(rows), days)
    const reversed = seriesColorByAgent([...orderAgentsForDisplay(rows)].reverse(), days)
    expect(forward.get('a')).toBe(reversed.get('a'))
    expect(forward.get('a')).toBe('var(--v2-avatar-4)')
  })

  it('gives an id the roster does not carry the neutral ink, named rather than dropped', () => {
    const map = seriesColorByAgent([agent('c', '10.00', 3)], [{ date: '2026-07-07', spent_by_agent: { c: '1', ghost: '2' }, refusals: 0 }])
    expect(map.get('c')).toBe('var(--v2-avatar-3)')
    // No name to hash → no invented hue: the neutral ink MoneyPanel gives
    // unattributed money (#3897).
    expect(map.get('ghost')).toBe('var(--v2-ink-3)')
  })

  it('the name hash still wraps at six tints — merchants and contacts keep it; agents no longer rely on it', () => {
    // Pigeonhole with seven names: the HASH collides, which is why an agent
    // carries a stored tint instead (#4428). Two agents whose names hash alike
    // are drawn in different colours once each has its own tint; past a user's
    // first six a tint repeats and the legend and tooltip tell them apart by
    // name.
    const names = Array.from({ length: 7 }, (_, i) => `agent-${i}`)
    expect(new Set(names.map((n) => avatarTint(n))).size).toBeLessThan(names.length)
    const collided = names.filter((n) => avatarTint(n) === avatarTint(names[0]!))
    expect(collided.length).toBeGreaterThan(1)
    expect(seriesColorForAgent({ name: collided[0]!, avatarTint: 1 })).not.toBe(
      seriesColorForAgent({ name: collided[1]!, avatarTint: 2 }),
    )
  })
})
