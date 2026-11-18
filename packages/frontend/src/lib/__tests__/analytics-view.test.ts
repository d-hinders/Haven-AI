import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_VIEW_OPTIONS,
  ANALYTICS_VIEW_URL_PARAM,
  DEFAULT_ANALYTICS_VIEW,
  isAnalyticsView,
  readUrlAnalyticsView,
  writeUrlAnalyticsView,
} from '../analytics-view'

/**
 * The Spending / Revenue switch's URL half (#4901).
 *
 * The behaviour that matters is not the reading, it is WHAT the reading is
 * FOR: the side is read inside the `useState` initialiser so the FIRST render
 * already knows which side it is on and no request is spent on the side that
 * is not shown — the same reasoning `analytics-range.test.ts` records for the
 * period. These tests pin the read as a synchronous function of a seeded URL,
 * which is exactly how the client calls it.
 */

function seed(search: string) {
  window.history.replaceState(null, '', `/analytics${search}`)
}

describe('isAnalyticsView', () => {
  it('accepts exactly the two sides the switch offers', () => {
    expect(isAnalyticsView('spending')).toBe(true)
    expect(isAnalyticsView('revenue')).toBe(true)
  })

  it('rejects every other value, including near-misses', () => {
    for (const value of ['', 'Revenue', 'SPENDING', 'spend', 'sales', 'tab']) {
      expect(isAnalyticsView(value)).toBe(false)
    }
    for (const value of [null, undefined, 0, true, {}, []]) {
      expect(isAnalyticsView(value)).toBe(false)
    }
  })
})

describe('readUrlAnalyticsView', () => {
  it('reads the side the address names', () => {
    seed('?view=revenue')
    expect(readUrlAnalyticsView()).toBe('revenue')
    seed('?view=spending')
    expect(readUrlAnalyticsView()).toBe('spending')
  })

  it('is null when the address carries no side, or one this page does not have', () => {
    seed('')
    expect(readUrlAnalyticsView()).toBeNull()
    seed('?view=Revenue')
    expect(readUrlAnalyticsView()).toBeNull()
    seed('?view=')
    expect(readUrlAnalyticsView()).toBeNull()
  })

  it('reads beside the period, not instead of it', () => {
    seed('?period=7d&view=revenue')
    expect(readUrlAnalyticsView()).toBe('revenue')
  })
})

describe('writeUrlAnalyticsView', () => {
  it('writes the side and preserves the keys the page does not own', () => {
    seed('?period=7d&agentId=agent-research')
    writeUrlAnalyticsView('revenue')
    const params = new URLSearchParams(window.location.search)
    expect(params.get(ANALYTICS_VIEW_URL_PARAM)).toBe('revenue')
    expect(params.get('period')).toBe('7d')
    expect(params.get('agentId')).toBe('agent-research')
  })

  it('writes the default side too, so the address says which side it opens on', () => {
    seed('?view=revenue')
    writeUrlAnalyticsView('spending')
    expect(new URLSearchParams(window.location.search).get(ANALYTICS_VIEW_URL_PARAM)).toBe('spending')
  })

  it('replaces rather than pushes: a switch is not a history entry per change', () => {
    seed('')
    const before = window.history.length
    writeUrlAnalyticsView('revenue')
    writeUrlAnalyticsView('spending')
    expect(window.history.length).toBe(before)
  })

  it('refuses a value that is not a side', () => {
    seed('?view=revenue')
    writeUrlAnalyticsView('sales' as never)
    expect(new URLSearchParams(window.location.search).get(ANALYTICS_VIEW_URL_PARAM)).toBe('revenue')
  })
})

describe('the switch’s declared options', () => {
  it('reads Spending / Revenue, in that order, with spending the default', () => {
    expect(ANALYTICS_VIEW_OPTIONS.map((option) => option.label)).toEqual(['Spending', 'Revenue'])
    expect(ANALYTICS_VIEW_OPTIONS.map((option) => option.value)).toEqual(['spending', 'revenue'])
    expect(DEFAULT_ANALYTICS_VIEW).toBe('spending')
  })
})
