/**
 * Every string the list-controls pattern shows (#4110, epic #4108). Pages
 * pass a noun; they never write these strings themselves, so "Search
 * agents" and "12 of 60 transactions" read the same on every list.
 */

import type { PeriodPreset, PeriodValue } from './list-url-codec'

/** A list's noun, singular and plural: `{ one: 'agent', other: 'agents' }`. */
export interface ListNoun {
  one: string
  other: string
}

export function nounFor(noun: ListNoun, n: number): string {
  return n === 1 ? noun.one : noun.other
}

export const searchPlaceholder = (noun: ListNoun): string => `Search ${noun.other}`

export const clearFiltersLabel = 'Clear filters'
export const clearSearchLabel = 'Clear search'
export const allOptionLabel = 'All'

export const noMatchTitle = (noun: ListNoun): string => `No ${noun.other} match these filters`
export const noMatchBody = 'Try a different search, or clear filters to see everything.'

/**
 * The count. `shown` and `total` must come from the same source: on a
 * server-paged list both are server figures, never loaded rows against a
 * server total.
 *
 * - unfiltered: "60 transactions"
 * - filtered: "12 of 60 transactions"
 * - `cappedAt` (the server stopped reading): "Showing the first 500
 *   transactions" — the total is unknown, so it is not claimed.
 */
export interface ListCount {
  shown: number
  total: number
  cappedAt?: number
}

export function countLabel(noun: ListNoun, count: ListCount, filtered: boolean): string {
  if (count.cappedAt !== undefined) return `Showing the first ${count.cappedAt} ${nounFor(noun, count.cappedAt)}`
  if (!filtered) return `${count.total} ${nounFor(noun, count.total)}`
  return `${count.shown} of ${count.total} ${nounFor(noun, count.total)}`
}

/**
 * The paging button below a paged list (#4196): "Show 25 more", where N is
 * what the next page adds — the page size, or fewer on the last page. When
 * the server still reports more but the totals say nothing is left (a poll
 * moved the total between reads), it says "Show more" rather than "Show 0
 * more".
 */
export function showMoreLabel(remaining: number, pageSize: number): string {
  const n = Math.min(pageSize, remaining)
  return n > 0 ? `Show ${n} more` : 'Show more'
}
export const loadingMoreLabel = 'Loading…'

/** The phone footer: closes the sheet and names the APPLIED result. */
export function showResultsLabel(noun: ListNoun, count: ListCount | null | undefined): string {
  if (!count) return 'Show results'
  const n = count.cappedAt ?? count.shown
  return `Show ${n} ${nounFor(noun, n)}`
}

export const filtersButtonLabel = (active: number): string => (active > 0 ? `Filters (${active})` : 'Filters')

/**
 * A facet's value as the trigger and its chip read it: "All", one option's
 * label, two labels joined, or "3 selected".
 *
 * An option may carry a `meta` status suffix (#4150). Whether it is included
 * is the caller's choice, stated here: the **trigger summary excludes it**
 * (the compact summary — the menu row, the phone-sheet row and the chip draw
 * it as its own slot), and the **status-row chip passes `includeMeta`**,
 * because the chip is where a filter is spelled out in full.
 */
export function facetValueLabel(
  values: readonly string[],
  options: readonly { value: string; label: string; meta?: string }[],
  allLabel: string = allOptionLabel,
  includeMeta = false,
): string {
  if (values.length === 0) return allLabel
  const labels = values.map((v) => {
    const option = options.find((o) => o.value === v)
    if (!option) return undefined
    return includeMeta && option.meta ? `${option.label} (${option.meta})` : option.label
  })
  // A value the options cannot name (a URL filter whose options have not
  // loaded) still reads as a filter — never as "All", which would label a
  // filtered list unfiltered.
  if (labels.some((l) => l === undefined)) return `${values.length} selected`
  if (labels.length <= 2) return labels.join(', ')
  return `${values.length} selected`
}

export const periodPresetLabels: Record<PeriodPreset, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
}
export const allTimeLabel = 'All time'
export const customRangeLabel = 'Custom range'
export const customRangeHint = 'Both days are included, in your time zone.'

export function periodLabel(period: PeriodValue | undefined): string {
  if (period?.from && period?.to) return `${period.from} to ${period.to}`
  if (period?.preset) return periodPresetLabels[period.preset]
  return allTimeLabel
}
