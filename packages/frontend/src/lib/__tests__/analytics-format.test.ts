import { describe, expect, it } from 'vitest'
import {
  budgetBandsCaption,
  budgetUsedPercent,
  formatAnalyticsAmount,
  formatAnalyticsAmountCompact,
  formatBudgetResetDate,
  formatBudgetTokenValue,
  formatSharePercent,
  lastPaymentCaption,
  percentChange,
  rangeCaption,
  refusalsCaption,
  formatAnalyticsTick,
  formatAnalyticsValue,
} from '../analytics-format'

/**
 * The formatter contract for the Analytics surface (#2947, slice C).
 *
 * The load-bearing expectation across this whole file is that a formatter is a
 * RENDERER, not a calculator: every input here is a value that already exists
 * on `GET /analytics/overview`'s response, in the type the endpoint sends it
 * (money as a numeric STRING — slice B books fiat via `::text` in SQL and
 * never coerces). A test that fed these functions a number where the wire
 * carries a string would be testing a call site that does not exist.
 *
 * The exact strings below are what this repo's Node (`v22`, full ICU) emits,
 * read off the real formatter rather than guessed: the EUR form puts the
 * symbol AFTER the figure behind a no-break space, and `formatBudgetTokenValue`
 * keeps USDC's two default fraction places. Both were wrong in the first
 * draft of this file, which is the argument for reading them off the run.
 */

describe('formatAnalyticsAmount', () => {
  it('renders a booked decimal string as USD, parsed only at the edge', () => {
    // The endpoint's own shape: `totals.spent` arrives as "324.75".
    expect(formatAnalyticsAmount('324.75', 'USD')).toBe('$324.75')
    expect(formatAnalyticsAmount('12.50', 'USD')).toBe('$12.50')
  })

  it('renders EUR in the locale form: grouped with a comma, symbol after, no-break space between', () => {
    // The wire is dot-delimited everywhere (SQL `::text`); only the DISPLAY is
    // locale-formatted. The `\u00A0` is the no-break space Intl emits between
    // figure and symbol in de-DE — pinned because a plain space there would
    // let the amount and its currency break onto two lines in a narrow table
    // cell, which reads as two different figures.
    expect(formatAnalyticsAmount('1234.56', 'EUR')).toBe('1.234,56\u00A0€')
  })

  it('renders a booked zero as zero, not as blank or as a dash', () => {
    // The fees tile does NOT use this when the flag is off (it renders words
    // instead), but refusals do, and a $0.00 refused amount is a real reading
    // of a real row.
    expect(formatAnalyticsAmount('0', 'USD')).toBe('$0.00')
    expect(formatAnalyticsAmount('0.00', 'USD')).toBe('$0.00')
  })

  it('groups thousands and keeps both decimals on a large figure', () => {
    // Float smearing is why these fields are strings on the wire; the pin is
    // that the render is exact to the cent the endpoint sent.
    expect(formatAnalyticsAmount('1234567.89', 'USD')).toBe('$1,234,567.89')
    expect(formatAnalyticsAmount('0.30', 'USD')).toBe('$0.30')
  })

  it('renders a negative booked amount with the minus outside the symbol', () => {
    // The correction-row case: a refund nets into the window's sum. Pinned
    // because a screen reader reads this cell verbatim, and "-$4.20" and
    // "$-4.20" are not the same thing to hear.
    expect(formatAnalyticsAmount('-4.20', 'USD')).toBe('-$4.20')
  })
})

describe('formatAnalyticsAmountCompact', () => {
  it('keeps a figure under the threshold exact and compacts only what Intl compacts', () => {
    // The mobile agents row reads this form at a glance, so a value that has
    // not reached the thousands must NOT gain a suffix — and one that has must
    // not be printed in full width.
    expect(formatAnalyticsAmountCompact('12.50', 'USD')).toBe('$12.50')
    expect(formatAnalyticsAmountCompact('324.75', 'USD')).toBe('$324.75')
    expect(formatAnalyticsAmountCompact('1234.00', 'USD')).toBe('$1.23K')
  })
})

describe('formatSharePercent', () => {
  it('rounds the endpoint fraction to a whole percent for the share column', () => {
    // `share` is the response's one number-typed money-adjacent field, and B
    // derives it (spent divided by the window total) rather than shipping a
    // string, so the rounding is this file's to own — and to pin.
    expect(formatSharePercent(0.9615)).toBe('96%')
    expect(formatSharePercent(0.0385)).toBe('4%')
    expect(formatSharePercent(0)).toBe('0%')
    expect(formatSharePercent(1)).toBe('100%')
  })
})

describe('formatBudgetTokenValue', () => {
  it('divides atomic strings down to the token decimal places, in the token own units', () => {
    // The capture harness's own pair: 214 of 250 USDC, the >75% band the
    // `budget_bands` count reflects. USDC is 6 unit decimals and keeps two
    // fraction places by the shared allowance formatter's stable default — so
    // the rendered pair is "214.00 of 250.00", which is the whole point of
    // routing through `formatAllowanceForToken` instead of dividing here: a
    // second decimals table would be a second answer to "how many places does
    // this token show".
    expect(
      formatBudgetTokenValue({ token: 'USDC', used_atomic: '214000000', budget_atomic: '250000000' }),
    ).toBe('214.00 of 250.00 USDC')
  })

  it('renders a sub-unit budget without scientific notation', () => {
    // The harness's second row, the `remaining_from_chain: false` case whose
    // cell also carries the snapshot caveat.
    expect(
      formatBudgetTokenValue({ token: 'USDC', used_atomic: '5000000', budget_atomic: '500000000' }),
    ).toBe('5.00 of 500.00 USDC')
  })
})

describe('budgetUsedPercent', () => {
  it('reports the used share of a delegation as a whole percent', () => {
    expect(budgetUsedPercent('214000000', '250000000')).toBe(86)
    expect(budgetUsedPercent('5000000', '500000000')).toBe(1)
  })

  it('clamps an over-drawn delegation to 100 rather than printing a bar past full', () => {
    // An on-chain read that races the period end can report more used than the
    // budget permits. The figure is a measurement of one delegation against
    // its own period; a width past the container is a layout defect.
    expect(budgetUsedPercent('600000000', '500000000')).toBe(100)
    expect(budgetUsedPercent('500000000', '500000000')).toBe(100)
  })

  it('reports 0 rather than Infinity or NaN for a degenerate budget', () => {
    // The states this file's own docblock names. A delegation approved down to
    // nothing is a state that exists, and a progressbar whose aria-valuenow is
    // "NaN" is an accessibility defect as well as a display one: a screen
    // reader would announce a budget that has no number.
    expect(budgetUsedPercent('100', '0')).toBe(0)
    expect(budgetUsedPercent('100', '-1')).toBe(0)
    expect(budgetUsedPercent('100', 'not-a-number')).toBe(0)
    expect(budgetUsedPercent('not-a-number', '250000000')).toBe(0)
    expect(budgetUsedPercent('0', '250000000')).toBe(0)
  })
})

describe('formatBudgetResetDate', () => {
  it('renders the period end as day and short month, with no year', () => {
    // A delegation period runs hours to weeks, so a year would read as a
    // period years away; the element carries the full timestamp on its title
    // for the reader who needs the date precisely.
    expect(formatBudgetResetDate('2026-07-11T00:00:00.000Z')).toBe('11 Jul')
    // Midday UTC, not the day's last second: this formatter renders in the
    // HOST zone (no timeZone option), so `23:59:59Z` is already the following
    // day here in +01:00 — '2 Dec', correctly. An instant that is the same
    // calendar day across the zones a CI box can sit in is the only honest
    // input for a day-number pin.
    expect(formatBudgetResetDate('2026-12-01T12:00:00.000Z')).toBe('1 Dec')
  })
})

describe('budgetBandsCaption', () => {
  it('counts the denominator of agents WITH a budget, never the agent list', () => {
    // An agent with no delegation budget is not at 0% of anything, and
    // counting it would report a coverage the response does not claim.
    expect(budgetBandsCaption(1, 2)).toBe('1 of 2 agents above 75% of their period budget')
    expect(budgetBandsCaption(0, 2)).toBe('0 of 2 agents above 75% of their period budget')
  })
})

describe('rangeCaption', () => {
  it('names the window the figures cover, for every option the control offers', () => {
    expect(rangeCaption(7)).toBe('Last 7 days')
    expect(rangeCaption(30)).toBe('Last 30 days')
    expect(rangeCaption(90)).toBe('Last 90 days')
  })
})

describe('lastPaymentCaption', () => {
  it('says never in words for a null last payment', () => {
    // A bare "-" in this column is read as "no payments" and as "unknown"
    // with equal ease by two readers, and the page cannot tell them which it
    // got. The words are the column's answer for the null case.
    expect(lastPaymentCaption(null)).toBe('No payments in this range')
  })

  it('renders a recent timestamp through the shared relative vocabulary', () => {
    // The same `timeAgo` the transaction rows use, so the two surfaces say
    // "2h ago" and not one "2h ago" plus one "2 hours ago".
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
    expect(lastPaymentCaption(twoHoursAgo)).toBe('2h ago')
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(lastPaymentCaption(fiveMinutesAgo)).toBe('5m ago')
  })

  it('collapses an old fixed date into a relative bucket rather than printing an absolute one', () => {
    // The harness's fixed `last_payment_at` is a past absolute instant, so its
    // bucket is pinned by SHAPE here rather than by value: a value pin would
    // rot as "now" moves, and a rotting pin that fails in a month is worse
    // than no pin. The absolute instant rides on the element's title instead.
    expect(lastPaymentCaption('2020-01-01T00:00:00.000Z')).toMatch(/^[0-9]+(m|h|d|mo|y) ago$/)
  })
})

describe('percentChange', () => {
  it('expresses the change against the previous window as a percentage of it', () => {
    // The harness pair behind the Spent tile's chip: 324.75 on 280.10.
    expect(percentChange('324.75', '280.10')).toBeCloseTo(15.94, 2)
    expect(percentChange(2, 1)).toBe(100)
    expect(percentChange(1, 2)).toBe(-50)
    expect(percentChange(2, 2)).toBe(0)
  })

  it('accepts both wire types, numeric strings for money and numbers for counts', () => {
    // The two fields the page calls it with are `totals.spent` (a string) and
    // `totals.refused_count` (a number). A helper that refused the string would
    // push a Number() coercion into the render, which the rule at the top of
    // the file forbids.
    expect(percentChange('10.00', '20.00')).toBe(-50)
    expect(percentChange(3, '2')).toBe(50)
  })

  it('reports no change figure at all when there is nothing to compare against', () => {
    // The states the tile must NOT render a chip for. "Up from zero" is not a
    // percentage of zero, and the first window an account has data in has no
    // previous window; a made-up 0% would be a figure the endpoint never
    // reported, and a reader cannot tell it from a real "flat".
    expect(percentChange('324.75', '0')).toBeNull()
    expect(percentChange('324.75', '0.00')).toBeNull()
    expect(percentChange(2, 0)).toBeNull()
    expect(percentChange(2, -1)).toBeNull()
    expect(percentChange('324.75', 'not-a-number')).toBeNull()
    expect(percentChange('not-a-number', '280.10')).toBeNull()
  })
})

describe('refusalsCaption', () => {
  it('states the rows and the attempts behind them as one line when they differ', () => {
    // One attempt can carry two refusal rows upstream, so the counts differ;
    // the pair is one fact and gets one cell, not two columns doubling the
    // width of the loudest zero.
    expect(refusalsCaption(2, 3)).toBe('2 refused payments · across 3 attempts')
    expect(refusalsCaption(1, 2)).toBe('1 refused payment · across 2 attempts')
  })

  it('drops the attempts clause when the counts are equal, which is the usual case', () => {
    // Spelling "2 refused payments · across 2 attempts" every time would
    // train the reader to stop parsing the cell.
    expect(refusalsCaption(2, 2)).toBe('2 refused payments')
    expect(refusalsCaption(1, 1)).toBe('1 refused payment')
    expect(refusalsCaption(0, 0)).toBe('0 refused payments')
  })
})

describe('formatAnalyticsTick — the y-axis tick, without cents (#3051)', () => {
  it('prints whole currency units in USD, never the cents a figure carries', () => {
    expect(formatAnalyticsTick(100, 'USD')).toBe('$100')
    expect(formatAnalyticsTick(1240, 'USD')).toBe('$1,240')
    // A figure in the same voice keeps its cents — the tick deliberately does not.
    expect(formatAnalyticsValue(100, 'USD')).toBe('$100.00')
  })

  it('keeps the EUR form (symbol after, no-break space) with no fraction digits', () => {
    expect(formatAnalyticsTick(100, 'EUR')).toBe('100\u00a0€')
    expect(formatAnalyticsTick(1240, 'EUR')).toBe('1.240\u00a0€')
  })
})

/**
 * SEK, the served default (#3127). Same provenance rule as the header states
 * for USD/EUR: the exact strings are this repo's Node (v24, full ICU) sv-SE
 * output, read off the real formatter rather than guessed — NBSP group
 * separators, decimal comma, the "kr" suffix behind an NBSP, and a true
 * U+2212 minus sign (not the ASCII hyphen) on negatives.
 */
describe('SEK renders in the sv-SE voice (#3127)', () => {
  it('formats a booked amount with the group separator, decimal comma, and suffix', () => {
    expect(formatAnalyticsAmount('1234.56', 'SEK')).toBe('1\u00a0234,56\u00a0kr')
    expect(formatAnalyticsAmount('0', 'SEK')).toBe('0,00\u00a0kr')
  })

  it('negatives carry the U+2212 minus the sv-SE locale actually emits', () => {
    expect(formatAnalyticsAmount('-4.20', 'SEK')).toBe('\u22124,20\u00a0kr')
  })

  it('compacts, values, and ticks in the same voice as the other currencies', () => {
    expect(formatAnalyticsAmountCompact('1234.00', 'SEK')).toBe('1,23\u00a0tn\u00a0kr')
    expect(formatAnalyticsValue(1234.56, 'SEK')).toBe('1\u00a0234,56\u00a0kr')
    expect(formatAnalyticsTick(1240, 'SEK')).toBe('1\u00a0240\u00a0kr')
  })
})
