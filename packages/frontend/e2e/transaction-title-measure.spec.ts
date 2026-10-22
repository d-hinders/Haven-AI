/**
 * `/transactions` keeps every row title on one line, inside its row, across
 * the md-xl band (#1827, retargeted to the ledger rows in #4266 — the
 * table's two-line allowance is gone with the table).
 *
 * The `/design-system` "Transaction tables" showcase this spec used to measure
 * was retired with the table itself (#4266); only the `/transactions` leg
 * remains. Assert the property, not a string: no title stacks past two lines.
 */
import { expect, test } from '@playwright/test'
import { dashboardTransaction, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

/** The width the visual baselines are rendered at. Its numbers must not move. */
const DESKTOP_WIDTH = 1280

// The ledger title is `truncate` (nowrap + ellipsis): one line, always (#4266).
const MAX_TITLE_LINES = 1

type TitleReading = {
  text: string
  measure: number
  lines: number
  rowHeight: number
  hasBadge: boolean
  truncated: boolean
}

/**
 * Anchor on the ledger row (`role="button"` inside `transactions-ledger`) and
 * take its FIRST `<p>` — the title — never a class string (trap 1 from
 * `transaction-row.mobile.spec.ts`). `getClientRects().length` filters hidden
 * copies (trap 2). Line count comes from a Range's client rects (one box per
 * line box), not from dividing height by a guessed line-height.
 */
async function readTitles(page: import('@playwright/test').Page): Promise<TitleReading[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0
    return Array.from(
      document.querySelectorAll('[data-testid="transactions-ledger"] [role="button"][aria-haspopup="dialog"]'),
    )
      .filter(visible)
      .map((row) => {
        const p = row.querySelector('p')
        if (!p || !visible(p)) return null
        const range = document.createRange()
        range.selectNodeContents(p)
        const lines = new Set(
          Array.from(range.getClientRects()).map((r) => Math.round(r.top)),
        ).size
        const rowRect = row.getBoundingClientRect()
        const titleRect = p.getBoundingClientRect()
        return {
          text: (p.textContent ?? '').trim(),
          measure: +titleRect.width.toFixed(1),
          lines,
          rowHeight: +rowRect.height.toFixed(1),
          // A badge shares the title's wrapping line; a reading from a row
          // that lost it would be about a different layout.
          hasBadge: Array.from(row.querySelectorAll('*')).some(
            (el) => visible(el) && (el.textContent ?? '').trim() === 'Failed' && el !== p,
          ),
          // The title box extends past the row's right edge: it must
          // truncate, never spill.
          truncated: titleRect.right > rowRect.right + 1,
        }
      })
      .filter((r): r is TitleReading => r !== null)
  })
}

/** The widths the band is read at: both teeth of the sidebar sawtooth, and desktop. */
test('/transactions: row titles truncate to one line and stay inside the row across the band', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  // The fixture's hosts are short, so on their own they could never wrap or
  // spill. Serve one row whose resource host is far longer than any row can
  // hold (test-local override, registered after mockHavenApi so it wins).
  const long = JSON.parse(JSON.stringify(dashboardTransaction)) as typeof dashboardTransaction
  long.hash = `0x${'f1'.repeat(32)}`
  long.fundingTxHash = long.hash
  long.x402ResourceUrl = `https://${'a-very-long-merchant-hostname-'.repeat(4)}example.com/report`
  await page.route('**/api/transactions*', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET' && url.pathname === '/api/transactions') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transactions: [dashboardTransaction, long],
          total: 2,
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
  await page.goto('/transactions')
  await page.waitForSelector('[data-testid="transactions-ledger"] [role="button"]', { timeout: 60_000 })

  for (const width of [768, 1024, DESKTOP_WIDTH]) {
    await page.setViewportSize({ width, height: 900 })
    let readings = await readTitles(page)
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(150)
      const again = await readTitles(page)
      if (JSON.stringify(again) === JSON.stringify(readings)) break
      readings = again
    }

    expect(readings.length, `@${width}px: no /transactions title rendered to measure`).toBeGreaterThan(0)
    // Non-vacuity: the long host really is on the page and really is longer
    // than its row could show (it would otherwise pass for any layout).
    expect(
      readings.some((r) => r.text.length > 60),
      `@${width}px: the long-host row did not render`,
    ).toBe(true)
    for (const reading of readings) {
      expect(reading.measure, `@${width}px: "${reading.text}" measured 0`).toBeGreaterThan(0)
      expect(
        reading.lines,
        `@${width}px: "${reading.text}" wraps to ${reading.lines} lines`,
      ).toBeLessThanOrEqual(MAX_TITLE_LINES)
      expect(reading.truncated, `@${width}px: "${reading.text}" spills past the row`).toBe(false)
    }
  }
})
