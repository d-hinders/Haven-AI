/**
 * `/transactions` keeps every row title readable across the md-xl band (#1827).
 *
 * The `/design-system` "Transaction tables" showcase this spec used to measure
 * was retired with the table itself (#4266); only the `/transactions` leg
 * remains. Assert the property, not a string: no title stacks past two lines.
 */
import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

/** The width the visual baselines are rendered at. Its numbers must not move. */
const DESKTOP_WIDTH = 1280

const MAX_TITLE_LINES = 2

type TitleReading = {
  text: string
  measure: number
  lines: number
  rowHeight: number
  hasBadge: boolean
  truncated: boolean
}

/**
 * Anchor on the title element (`<p title=…>`, or on selectable rows the row's
 * `<button data-row-select>` that carries the truncation, #3554) inside a `tbody` row and walk up, never on
 * a class string — trap 1 from `transaction-row.mobile.spec.ts`, and this fix
 * is again a change of which cells render.
 *
 * `getClientRects().length` filters the `hidden xl:table-cell` copies, which
 * are in the DOM with their text intact and measure 0x0 — trap 2 from the same
 * file. Line count comes from a Range's client rects (one box per line box),
 * not from dividing height by a guessed line-height.
 */
async function readTitles(page: import('@playwright/test').Page): Promise<TitleReading[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0
    return Array.from(document.querySelectorAll('tbody tr'))
      .filter(visible)
      .map((tr) => {
        const p = tr.querySelector('p[title], button[data-row-select]')
        if (!p || !visible(p)) return null
        const range = document.createRange()
        range.selectNodeContents(p)
        const lines = new Set(
          Array.from(range.getClientRects()).map((r) => Math.round(r.top)),
        ).size
        // The badge is what makes this row the hard case: it is held on the
        // title's line and takes 58px of the measure. A reading taken from a
        // row that lost its badge would be about a different layout.
        const hasBadge = Array.from(tr.querySelectorAll('*')).some(
          (el) => visible(el) && (el.textContent ?? '').trim() === 'Failed' && el !== p,
        )
        return {
          text: (p.textContent ?? '').trim(),
          measure: +p.getBoundingClientRect().width.toFixed(1),
          lines,
          rowHeight: +tr.getBoundingClientRect().height.toFixed(1),
          hasBadge,
          // Ellipsised rather than shown in full. This is what stops the
          // measure floor from being satisfiable by clipping the title down
          // to one short line (see STARVED below).
          truncated: p.scrollWidth > p.clientWidth + 1,
        }
      })
      .filter((r): r is TitleReading => r !== null)
  })
}

/** The widths the band is read at: both teeth of the sidebar sawtooth, and desktop. */
test('/transactions: row titles stay within two lines across the band', async ({ page }) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await page.goto('/transactions')
  await page.waitForSelector('tbody tr', { timeout: 60_000 })

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
    for (const reading of readings) {
      expect(reading.measure, `@${width}px: "${reading.text}" measured 0`).toBeGreaterThan(0)
      expect(
        reading.lines,
        `@${width}px: "${reading.text}" wraps to ${reading.lines} lines`,
      ).toBeLessThanOrEqual(MAX_TITLE_LINES)
    }
  }
})
