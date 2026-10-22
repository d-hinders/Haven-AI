/**
 * The mobile `/transactions` ledger row's horizontal-space rules (#1774,
 * #1750, #2734), retargeted from the retired table to the ledger rows
 * (#4266).
 *
 * WHY THESE ASSERTIONS AND NOT A SCREENSHOT: the visual gate's pixel budget
 * (`maxDiffPixelRatio`) is larger than a whole row changing shape (#1805). A
 * green pixel gate is not evidence about this row; these numbers are.
 *
 * Deleted with the table, because their subject no longer exists (a ledger
 * row is one flex/grid block, not columns of cells):
 *   - "the activity cell keeps a readable measure at 390px" — there is no
 *     Activity cell to collapse to 13px; the title's room is asserted below
 *     as "one line, never past the row".
 *   - the table-only `From / To` column duplicate that forced the
 *     `getClientRects().length` filter in the arrow probe.
 *
 * TWO TRAPS PAID FOR ALREADY, still honoured:
 *   1. Anchor on the ARROW GLYPH and walk up, never on a class string.
 *      `expect(movements.length).toBeGreaterThan(0)` is what makes a probe
 *      that silently finds nothing visible.
 *   2. Filter on `getClientRects().length`: a hidden element is in the DOM
 *      with its text intact and measures 0x0.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  collectBrowserErrors,
  dashboardTransaction,
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

/**
 * Widths swept inside the mobile project. A GEOMETRY sweep (rectangles, not
 * pixels), so resizing away from Pixel 5's 393 costs nothing. 320 is the
 * narrowest phone still in the support matrix and where every number is worst.
 * 768 is the tablet width where long account names still overran the subline
 * (#4266 design review: 39px clipped at 768).
 */
const WIDTHS = [320, 390, 393, 768] as const

const ROW = '[data-testid="transactions-ledger"] [role="button"][aria-haspopup="dialog"]'

/**
 * A move between two of the user's own accounts (#4265), with long account
 * names so the movement subline is starved at 320px. The fixture serves no
 * `ownTransfer` row, and the arrow only renders on this shape in the ledger.
 */
async function serveOwnTransfer(page: Page) {
  const row = JSON.parse(JSON.stringify(dashboardTransaction)) as Record<string, unknown>
  Object.assign(row, {
    hash: `0x${'e1'.repeat(32)}`,
    fundingTxHash: `0x${'e1'.repeat(32)}`,
    settlementTxHash: null,
    source: 'explorer',
    x402ResourceUrl: undefined,
    x402MerchantAddress: undefined,
    paymentId: undefined,
    accounting: undefined,
    agentId: undefined,
    agentName: undefined,
    accountName: 'Operating wallet with a deliberately long name',
    ownTransfer: {
      toAccountId: '00000000-0000-4000-8000-0000000000aa',
      toAccountName: 'Reserve wallet with an equally long name',
      toAccountAddress: '0x2222222222222222222222222222222222222222',
    },
  })
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
}

type Movement = {
  arrowWidth: number
  arrowAlone: boolean
  parts: number
  rowOverflow: number
  /** The subline box's own overflow: it clips (`truncate`), so the row never shows it. */
  sublineOverflow: number
  /** How far the "to" half's box runs past the subline box's right edge. */
  toOverrun: number
}

async function readMovements(page: Page): Promise<Movement[]> {
  return page.evaluate((rowSelector) => {
    const visible = (el: Element) => el.getClientRects().length > 0
    // Anchor on the glyph inside a ledger row, then read its two halves: the
    // "from" label shares the arrow's flex row; the "to" label is the
    // arrow-row's next sibling (TransactionMovement `bare`).
    const arrows = Array.from(document.querySelectorAll(`${rowSelector} [aria-hidden="true"]`))
      .filter((el) => (el.textContent ?? '').trim() === '→')
      .filter(visible)

    return arrows.map((arrow) => {
      const arrowRow = arrow.parentElement as HTMLElement
      const from = arrowRow.firstElementChild
      const to = arrowRow.nextElementSibling
      const parts = [from, to].filter((el): el is Element => el != null && visible(el))
      const arrowRect = arrow.getBoundingClientRect()
      // "Alone on its line" is a vertical-band question: orphaned exactly
      // when no labelled half overlaps the arrow's band.
      const arrowAlone = !parts.some((el) => {
        const r = el.getBoundingClientRect()
        return r.top < arrowRect.bottom && arrowRect.top < r.bottom
      })
      const row = arrow.closest(rowSelector) as HTMLElement
      // The subline is the `truncate` div the movement sits in. It clips its
      // own overflow, so the row's scroll width cannot see a destination cut
      // mid-word (#4266 design review) — measure the box itself.
      const subline = arrowRow.closest('div') as HTMLElement
      const sublineRect = subline.getBoundingClientRect()
      const toRect = to ? to.getBoundingClientRect() : sublineRect
      return {
        arrowWidth: +arrowRect.width.toFixed(1),
        arrowAlone,
        parts: parts.length,
        rowOverflow: row.scrollWidth - row.clientWidth,
        sublineOverflow: subline.scrollWidth - subline.clientWidth,
        toOverrun: +(toRect.right - sublineRect.right).toFixed(1),
      }
    })
  }, ROW)
}

test('/transactions: an own-transfer ledger row keeps its movement arrow beside its labels and never overflows', async ({
  page,
}) => {
  test.slow()
  const errors = collectBrowserErrors(page)
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveOwnTransfer(page)
  await page.goto('/transactions')
  await page.waitForSelector(ROW, { timeout: 60_000 })
  await dismissMobileSidebar(page)

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(200)

    const movements = await readMovements(page)
    // Without this the suite passes vacuously the moment the markup moves.
    expect(movements.length, `@${width}px: no movement rendered to measure`).toBeGreaterThan(0)

    for (const movement of movements) {
      expect(movement.parts, `@${width}px: movement lost a labelled half`).toBe(2)
      // A zero-width arrow is invisible without being absent (#1749's trap).
      expect(movement.arrowWidth, `@${width}px: arrow squeezed to nothing`).toBeGreaterThan(4)
      expect(movement.arrowAlone, `@${width}px: arrow orphaned on its own line`).toBe(false)
      expect(movement.rowOverflow, `@${width}px: row scrolls horizontally`).toBeLessThanOrEqual(0)
      expect(movement.sublineOverflow, `@${width}px: the subline clips its content`).toBeLessThanOrEqual(0)
      expect(movement.toOverrun, `@${width}px: the destination runs past the subline`).toBeLessThanOrEqual(1)
    }
  }

  expect(unexpectedBrowserErrors(errors)).toEqual([])
})

/**
 * The amount and its time ride UNDER the title below `sm` (#2734, #4266).
 *
 * The ledger row stacks its two blocks below 640px: the title/subline block,
 * then the amount with the relative time beneath it. TWO ASSERTIONS, and the
 * structural one is load-bearing: a title that merely stays short could pass a
 * line ceiling while the amount sat beside it, eating its room. So this also
 * asserts WHERE the amount and the time are (below the title, time below the
 * amount), plus that the title never wraps.
 */
test('/transactions: the amount rides under the title with the time beneath it, and the title stays on one line (#2734)', async ({
  page,
}) => {
  const errors = collectBrowserErrors(page)
  await seedAuthenticatedSession(page)
  await mockHavenApi(page)
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/transactions')
  await dismissMobileSidebar(page)
  await page.waitForSelector(ROW, { timeout: 30_000 })

  const rows = await page.evaluate((rowSelector) => {
    const visible = (el: Element) => el.getClientRects().length > 0
    return Array.from(document.querySelectorAll(rowSelector))
      .filter(visible)
      .map((row) => {
        const title = row.querySelector('p')
        if (!title) return null
        const range = document.createRange()
        range.selectNodeContents(title)
        const lines = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size
        // Anchor on the rendered amount text (trap 1): a direction sign then
        // the `formatFiat` output in any voice, or the token form. Excluding
        // the title is load-bearing — an "ETHGlobal"-style merchant would
        // otherwise resolve to the title and make the position check vacuous.
        const AMOUNT_TEXT =
          /^[-+]?(?:\$\s*[\d.,   ]+|[\d.,   ]+\s*(?:USDC|ETH|USD|EUR|SEK|kr|€))\s*$/u
        const matches = Array.from(row.querySelectorAll('*')).filter(
          (el) =>
            visible(el) &&
            el !== title &&
            !el.contains(title) &&
            AMOUNT_TEXT.test((el.textContent ?? '').trim()),
        )
        const amounts = matches.filter((el) => !matches.some((o) => o !== el && el.contains(o)))
        const time = Array.from(row.querySelectorAll('p')).find(
          (p) => visible(p) && /\d+(m|h|d|mo|y) ago$/.test((p.textContent ?? '').trim()),
        )
        const amount = amounts[0]
        return {
          text: (title.textContent ?? '').trim(),
          lines,
          amountMatches: amounts.length,
          amountBelowTitle:
            amount !== undefined && amount.getBoundingClientRect().top >= title.getBoundingClientRect().bottom - 1,
          timeBelowAmount:
            amount !== undefined &&
            time !== undefined &&
            time.getBoundingClientRect().top >= amount.getBoundingClientRect().bottom - 1,
          overflow: (row as HTMLElement).scrollWidth - (row as HTMLElement).clientWidth,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
  }, ROW)

  expect(rows.length).toBeGreaterThan(0)

  // `expect.soft` so one run reports every property that broke.
  for (const row of rows) {
    expect.soft(row.amountMatches, `${row.amountMatches} visible amounts in "${row.text}"`).toBe(1)
    expect.soft(row.lines, `"${row.text}" wraps to ${row.lines} lines at 390px`).toBe(1)
    expect.soft(row.amountBelowTitle, `the amount for "${row.text}" is not under its title`).toBe(true)
    expect.soft(row.timeBelowAmount, `the time for "${row.text}" is not under its amount`).toBe(true)
    expect.soft(row.overflow, `"${row.text}" row scrolls horizontally`).toBeLessThanOrEqual(0)
  }

  expect(unexpectedBrowserErrors(errors)).toEqual([])
})
