/**
 * Two container-keyed layouts, each tested with the viewport held FIXED and
 * the container itself resized (#1999) — the only shape of test that can tell
 * a container query from a viewport query on this shell, where container
 * width is a sawtooth function of viewport width:
 *
 *     viewport   390   767   768   900   1023  1024  1279  1280
 *     container  340   717   718   850   973   718   973   974
 *
 * 1. The `Table` primitive's column collapse (`revealAt`, `tableColumnClass`).
 *    Its `/transactions` consumer is gone (#4266: the shared ledger replaced
 *    the table), so the guard now reads the live consumer of the `xl` stage —
 *    the analytics Agents table, whose Share and Top merchant columns reveal
 *    at a 974px container. A `@container v2table` query with no named
 *    container ancestor stays hidden at EVERY width, silently; jsdom cannot
 *    evaluate container queries, so this real-browser read is the guard.
 *    (The sticky-`thead` leg is not carried over: no `Table` consumer pins its
 *    head any more.)
 *
 * 2. `/transactions` ledger rows survive a starved container. A ledger row
 *    lays out on the VIEWPORT breakpoint (`sm:` two-column grid), so a narrow
 *    container at a wide viewport is the case where the row cannot rely on
 *    its breakpoint: the title must give way (truncate), the amount must keep
 *    its one line, and nothing may push the row past its container.
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
import { analyticsOverview } from './fixtures/analytics-overview'

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

/**
 * The analytics Agents table — the `xl` stage's consumer. Anchored on its
 * own header text, never on the first `<table>` (a page may render others).
 */
async function readAgentsTable(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0
    const table = Array.from(document.querySelectorAll('table')).find(
      (t) => visible(t) && (t.querySelector('thead')?.textContent ?? '').includes('Budget used'),
    )
    if (!table) return { columns: ['NO TABLE'], bodyCells: -1, containerWidth: -1 }
    const headRow = table.querySelector('thead tr')
    const columns = headRow
      ? Array.from(headRow.children).filter(visible).map((th) => (th.textContent ?? '').trim())
      : []
    const bodyRow = Array.from(table.querySelectorAll('tbody tr')).find(visible)
    const bodyCells = bodyRow ? Array.from(bodyRow.children).filter(visible).length : -1
    const container = table.parentElement
    return {
      columns,
      bodyCells,
      containerWidth: container ? +container.getBoundingClientRect().width.toFixed(1) : -1,
    }
  })
}

async function setAgentsTableContainerWidth(page: Page, px: number) {
  await page.evaluate((width) => {
    const table = Array.from(document.querySelectorAll('table')).find(
      (t) => t.getClientRects().length > 0 && (t.querySelector('thead')?.textContent ?? '').includes('Budget used'),
    )
    const container = table?.parentElement
    if (!container || !container.className.includes('container-type')) {
      throw new Error('no inline-size container found around the Agents table')
    }
    container.style.width = `${width}px`
  }, px)
  // Container queries re-evaluate on the next layout; two frames is ample.
  await page.waitForTimeout(250)
}

test('Table primitive: the xl collapse follows the CONTAINER while the viewport stands still', async ({
  page,
}) => {
  test.slow()
  await mockHavenApi(page)
  // The shared fixture does not serve the analytics overview; serve the
  // populated body the analytics visual spec photographs, after
  // `mockHavenApi` so LIFO matching reaches it first (its idiom, verbatim).
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() !== 'GET' || path !== '/analytics/overview') {
      await route.fallback()
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(analyticsOverview) })
  })
  await seedAuthenticatedSession(page)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/analytics')
  await expect(page.getByRole('columnheader', { name: 'Budget used' })).toBeVisible({ timeout: 60_000 })

  // 974px: exactly the `xl` stage — every column, header and body together.
  await setAgentsTableContainerWidth(page, 974)
  const atStage = await readAgentsTable(page)
  expect(atStage.containerWidth, 'the container really is 974px wide').toBe(974)
  expect(atStage.columns).toContain('Share')
  expect(atStage.columns).toContain('Top merchant')
  expect(atStage.bodyCells, 'the body row carries every column the header shows').toBe(atStage.columns.length)

  // 973px: one pixel under — Share and Top merchant drop from header AND body,
  // though the 1600px viewport is far past `xl`.
  await setAgentsTableContainerWidth(page, 973)
  const under = await readAgentsTable(page)
  expect(under.containerWidth).toBe(973)
  expect(under.columns).not.toContain('Share')
  expect(under.columns).not.toContain('Top merchant')
  expect(under.columns.length).toBe(atStage.columns.length - 2)
  expect(under.bodyCells, 'the body drops the same two cells').toBe(atStage.bodyCells - 2)
})
