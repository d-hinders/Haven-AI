import { describe, expect, it } from 'vitest'
import {
  countLabel,
  facetValueLabel,
  filtersButtonLabel,
  noMatchTitle,
  periodLabel,
  searchPlaceholder,
  showResultsLabel,
} from '../list-controls-copy'

const noun = { one: 'transaction', other: 'transactions' }

describe('list-controls copy', () => {
  it('search placeholder and no-match title name the things', () => {
    expect(searchPlaceholder(noun)).toBe('Search transactions')
    expect(noMatchTitle(noun)).toBe('No transactions match these filters')
  })

  it('counts: unfiltered, filtered, singular and capped', () => {
    expect(countLabel(noun, { shown: 60, total: 60 }, false)).toBe('60 transactions')
    expect(countLabel(noun, { shown: 12, total: 60 }, true)).toBe('12 of 60 transactions')
    expect(countLabel(noun, { shown: 1, total: 1 }, false)).toBe('1 transaction')
    expect(countLabel(noun, { shown: 500, total: 500, cappedAt: 500 }, true)).toBe('Showing the first 500 transactions')
  })

  it('phone footer names the applied result', () => {
    expect(showResultsLabel(noun, { shown: 12, total: 60 })).toBe('Show 12 transactions')
    expect(showResultsLabel(noun, { shown: 1, total: 60 })).toBe('Show 1 transaction')
    expect(showResultsLabel(noun, null)).toBe('Show results')
    expect(filtersButtonLabel(0)).toBe('Filters')
    expect(filtersButtonLabel(2)).toBe('Filters (2)')
  })

  it('facet value: All, one, two joined, "N selected", and never All for an unnamed value', () => {
    const options = [
      { value: 'a', label: 'Active' },
      { value: 'p', label: 'Paused' },
      { value: 'r', label: 'Revoked' },
    ]
    expect(facetValueLabel([], options)).toBe('All')
    expect(facetValueLabel(['a'], options)).toBe('Active')
    expect(facetValueLabel(['a', 'p'], options)).toBe('Active, Paused')
    expect(facetValueLabel(['a', 'p', 'r'], options)).toBe('3 selected')
    expect(facetValueLabel(['unknown-id'], options)).toBe('1 selected')
  })

  it('facet value with meta: excluded from the summary, included with includeMeta (#4150)', () => {
    const options = [
      { value: 'a1', label: 'Lovable Dev preview deployment helper', meta: 'Revoked' },
      { value: 'a2', label: 'Atlas' },
    ]
    // The trigger summary reads the label alone.
    expect(facetValueLabel(['a1'], options)).toBe('Lovable Dev preview deployment helper')
    // The status-row chip spells the filter out in full.
    expect(facetValueLabel(['a1'], options, 'All', true)).toBe('Lovable Dev preview deployment helper (Revoked)')
    // An option without meta is unchanged either way.
    expect(facetValueLabel(['a2'], options, 'All', true)).toBe('Atlas')
  })

  it('period labels', () => {
    expect(periodLabel({})).toBe('All time')
    expect(periodLabel({ preset: '30d' })).toBe('Last 30 days')
    expect(periodLabel({ from: '2026-09-01', to: '2026-10-20' })).toBe('2026-09-01 to 2026-10-20')
  })
})
