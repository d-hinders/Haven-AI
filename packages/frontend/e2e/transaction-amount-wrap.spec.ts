/**
 * A transaction list amount renders on ONE line, at any valuation width (#3950).
 *
 * WHAT WAS BROKEN. `<Amount>`'s `≈` mark — a span plus a breakable space in
 * front of an otherwise-NBSP figure — was the only break opportunity a list
 * amount had. In the fixed-width amount column (`w-[110px]`) every
 * approx-valued row wrapped onto two lines (`≈` / the figure): the committed
 * 1280px baseline already carried it for both fixture rows, and the owner
 * found it on prod the moment inbound transfers became visible. The owner
 * decision (2026-10-14): drop the mark on the list, keep the conversion.
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT — the same reason as
 * `transaction-row.mobile.spec.ts`: the committed pixel baselines CARRIED the
 * defect, so a screenshot gate is definitionally unable to catch this shape.
 * Line counts come from a Range's client rects (one box per line box), the
 * idiom `transaction-title-measure.spec.ts` established.
 *
 * TWO TESTS, because the mark's removal alone cannot guard the rule it was
 * named for. Once `≈ ` is gone the fixture figures (`134,50 kr`,
 * `10,76 kr`) have NO break opportunity left — a regression that re-introduced
 * a breakable separator would not wrap them at these widths. The second test
 * serves a LONG approx figure through a test-local route override (the
 * `area-chart-dot-measure.spec.ts` pattern: registered after `mockHavenApi`,
 * so it wins the route for that path alone) and asserts one line AND no
 * horizontal table overflow — the `whitespace-nowrap` cell must widen the
 * column, never push the table past its container.
 *
 * Both widths the visual baselines render at are swept (1280 and 390), in
 * one spec file — the same self-sweep `area-chart-dot-measure.spec.ts` uses,
 * so the geometry holds on both stages of the row: the `md`+ column and the
 * narrow block under the title.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  dashboardTransaction,
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
} from './fixtures/haven-api'

/** Both widths the visual baselines are rendered at. */
const WIDTHS = [1280, 390] as const

/** A five-digit SEK figure: `76 543,21 kr` through `formatFiatDisplay`. */
const LONG_APPROX_AMOUNT = '76543.2100'

type AmountReading = { text: string; lines: number }

/**
 * Every visible amount element in the table body, with its line count.
 *
 * Anchors on the rendered text, not on a class or a component name — the
 * trap `transaction-row.mobile.spec.ts` documents. The voice pattern is the
 * same file's AMOUNT_TEXT minus the now-gone `≈ ` prefix (kept out: a list
 * row that renders `≈` again must fail this guard, not silently match it),
 * recognising the direction sign and every `formatFiat` voice (the SEK
 * group/decimal separators are NBSP). INNERMOST matches only: an element
 * that CONTAINS another match is a wrapper.
 */
async function readAmounts(page: Page): Promise<AmountReading[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0
    const AMOUNT_TEXT = /^[-+]?[\d.,\u00a0\u202f ]+\s*(?:USDC|ETH|USD|EUR|SEK|kr|€|\$)\s*$/u

    const matches = Array.from(document.querySelectorAll('tbody *')).filter((el) => {
      if (!visible(el)) return false
      const text = (el.textContent ?? '').replace(/\u00a0/g, ' ').trim()
      if (!AMOUNT_TEXT.test(text)) return false
      // Innermost only: a wrapper around a matching child is not the amount.
      return !Array.from(el.querySelectorAll('*')).some((child) => {
        const childText = (child.textContent ?? '').replace(/\u00a0/g, ' ').trim()
        return AMOUNT_TEXT.test(childText)
      })
    })

    return matches.map((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const lines = new Set(
        Array.from(range.getClientRects()).map((r) => Math.round(r.top)),
      ).size
      return { text: (el.textContent ?? '').replace(/\u00a0/g, ' ').trim(), lines }
    })
  })
}

test.beforeEach(async ({ page }) => {
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
})

for (const width of WIDTHS) {
  test(`every fixture list amount renders on one line at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/transactions')
    await dismissMobileSidebar(page)

    // Wait for the rows to actually render before measuring.
    await expect
      .poll(async () => (await readAmounts(page)).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2)

    const amounts = await readAmounts(page)
    // Both fixture rows are approx-valued (no book-time fiat), so both
    // stages exercise the defect: at 1280 the wrapped baselines showed
    // `≈` / `-134,50 kr` and `≈` / `-10,76 kr`.
    expect(amounts.length, JSON.stringify(amounts)).toBeGreaterThanOrEqual(2)
    // #3950: no `≈` on a list row, and never two lines.
    for (const amount of amounts) {
      expect(amount.text, `at ${width}`).not.toContain('≈')
      expect(amount.lines, `"${amount.text}" @ ${width}`).toBe(1)
    }
  })

  test(`a long approx amount stays on one line without overflowing the table at ${width}`, async ({
    page,
  }) => {
    // Test-local route override, registered AFTER `mockHavenApi`'s catch-all
    // (Playwright matches the most recent route first); non-list requests
    // fall through to the standard fixture. Trailing `*`: the glob must
    // match the whole URL including the query string these reads carry.
    const row = JSON.parse(JSON.stringify(dashboardTransaction)) as typeof dashboardTransaction
    row.hash = `0x${'ef'.repeat(32)}`
    row.fundingTxHash = row.hash
    row.approxAmount = LONG_APPROX_AMOUNT
    await page.route('**/api/transactions*', async (route) => {
      const url = new URL(route.request().url())
      if (route.request().method() === 'GET' && url.pathname === '/api/transactions') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            transactions: [row],
            total: 1,
            offset: 0,
            limit: 25,
            hasMore: false,
            partialFailure: false,
            failedAccountIds: [],
            truncated: false,
          }),
        })
        return
      }
      await route.fallback()
    })

    await page.setViewportSize({ width, height: 900 })
    await page.goto('/transactions')
    await dismissMobileSidebar(page)

    // Wait for the overridden row to actually render before measuring.
    await expect
      .poll(async () => (await readAmounts(page)).some((a) => a.text.includes('76 543,21')), {
        timeout: 15_000,
      })
      .toBe(true)

    const amounts = await readAmounts(page)
    const long = amounts.find((a) => a.text.includes('76 543,21'))
    expect(long, JSON.stringify(amounts)).toBeTruthy()
    expect(long!.lines, `"${long!.text}" @ ${width}`).toBe(1)

    // The nowrap column must WIDEN, not push the table past its container.
    // (At 1280 the Activity column absorbs the difference; at 390 the
    // amount rides under the title inside the flexible Activity cell.)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `horizontal overflow @ ${width}`).toBeLessThanOrEqual(0.5)
  })
}
