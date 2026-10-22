/**
 * `/transactions` rows survive a starved CONTAINER while the viewport stands
 * still (#1999, retargeted to the ledger in #4266).
 *
 * WHAT WAS DELETED, AND WHY. This spec pinned the `Table` primitive's column
 * collapse (seven columns -> three at a 717px container, back at 718px) and
 * the sticky `thead` pinning through the container wrapper (#1772). Both
 * subjects belonged to the `/transactions` table, which the shared ledger
 * replaced: there are no columns to collapse and no header to pin, so those
 * two tests have nothing left to read on this route. (The `Table` primitive
 * itself still serves other pages; it is not what `/transactions` renders.)
 *
 * WHAT REMAINS is the same idea in the ledger's terms. A ledger row lays out
 * on the VIEWPORT breakpoint (`sm:` two-column grid), so a narrow container at
 * a wide viewport is the case where the row cannot rely on its breakpoint to
 * save it: the title must give way (truncate), the amount must keep its one
 * line, and nothing may push the row past its container. The viewport is held
 * FIXED and the ledger's own box is resized — the only shape of test that can
 * tell a row that adapts to its box from one that adapts to the window.
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

const ROW = '[data-testid="transactions-ledger"] [role="button"][aria-haspopup="dialog"]'

type RowShape = {
  title: string
  rowWidth: number
  rowOverflow: number
  titleTruncated: boolean
  titleLines: number
  amountLines: number
  amountVisible: boolean
}

async function readRows(page: Page): Promise<RowShape[]> {
  return page.evaluate((rowSelector) => {
    const visible = (el: Element) => el.getClientRects().length > 0
    const lineCount = (el: Element) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size
    }
    return Array.from(document.querySelectorAll(rowSelector))
      .filter(visible)
      .map((row) => {
        const title = row.querySelector('p') as HTMLElement
        // The amount is the first <p> of the right-hand block: the last
        // child of the row's grid, whose first <p> is the Amount.
        const rightBlock = row.lastElementChild as HTMLElement
        const amount = rightBlock.querySelector('p') as HTMLElement | null
        return {
          title: (title.textContent ?? '').trim(),
          rowWidth: +row.getBoundingClientRect().width.toFixed(1),
          rowOverflow: (row as HTMLElement).scrollWidth - (row as HTMLElement).clientWidth,
          titleTruncated: title.scrollWidth > title.clientWidth,
          titleLines: lineCount(title),
          amountLines: amount ? lineCount(amount) : -1,
          amountVisible: amount !== null && visible(amount),
        }
      })
  }, ROW)
}

async function setLedgerWidth(page: Page, px: number) {
  await page.evaluate((width) => {
    const ledger = document.querySelector('[data-testid="transactions-ledger"]') as HTMLElement | null
    if (!ledger) throw new Error('no ledger found')
    ledger.style.width = `${width}px`
  }, px)
  await page.waitForTimeout(250)
}

test('/transactions: a starved ledger truncates titles and keeps amounts whole while the viewport stands still', async ({
  page,
}) => {
  test.slow()
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/transactions')
  await page.waitForSelector(ROW, { timeout: 60_000 })
  await page.waitForTimeout(400)

  const wide = await readRows(page)
  expect(wide.length, 'rows rendered at the wide container').toBeGreaterThan(0)
  for (const row of wide) {
    expect(row.titleTruncated, `"${row.title}" is truncated at full width`).toBe(false)
    expect(row.amountVisible).toBe(true)
  }

  // Starve the CONTAINER without touching the viewport: the `sm:` breakpoint
  // stays on, so the row keeps its two-column arrangement in 220px.
  await setLedgerWidth(page, 220)
  const starved = await readRows(page)
  expect(starved.length).toBe(wide.length)
  for (const row of starved) {
    expect(row.rowWidth, `the ledger really is 220px wide`).toBeLessThanOrEqual(220)
    expect(row.rowOverflow, `"${row.title}" row scrolls horizontally`).toBeLessThanOrEqual(0)
    expect(row.amountVisible, `"${row.title}" lost its amount`).toBe(true)
    expect(row.amountLines, `"${row.title}" amount wraps`).toBe(1)
    expect(row.titleLines, `"${row.title}" title wraps`).toBe(1)
  }
  // The title is what gave way: at least one title now ellipsises, which a
  // row that ignored its container could not do.
  expect(
    starved.some((r) => r.titleTruncated),
    'no title truncated in a 220px container — the row is not adapting to its box',
  ).toBe(true)
})
