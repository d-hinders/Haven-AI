/**
 * The transaction detail panel's round-2 polish (#4312, on #4267's panel).
 * Every geometric acceptance criterion is MEASURED here, not judged by eye:
 *
 * - A: a deposit's one-line title centres on its 36px mark (±1px) at 1280
 *   and 390, and the two-line header keeps its top alignment.
 * - B: on both x402 rows, at 1280 and 390, line 1 of the when-line never
 *   ends in a stranded "·" (the separator travels with the date).
 * - C: the settlement note's right edge equals the value text's (±1px).
 * - D: in the opened Technical details, every copy glyph shares one centre x
 *   and every explorer glyph one centre x (±1px) — including the Payment ID
 *   row and an unknown-chain row, whose copy glyph sits in the COPY column.
 * - E: the sweep's What happened value is one line at 1280 and 390.
 *
 * The shared feed serves none of the deposit, sweep, failed or unknown-chain
 * rows, so each is overlaid through `serveTransactions` (#4312 fixture).
 * The visual spec's `when:` regexes keep pinning the header line's literal;
 * the two moved baselines are regenerated alongside this spec.
 */
import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dashboardTransaction,
  depositTransaction,
  dismissMobileSidebar,
  failedTransaction,
  mockHavenApi,
  seedAuthenticatedSession,
  serveTransactions,
  sweepTransaction,
  unknownChainTransaction,
  unexpectedBrowserErrors,
  x402UnrecordedSettlementTransaction,
} from './fixtures/haven-api'

const VIEWPORTS = [1280, 390] as const

/** Open the detail panel of the ledger row whose text matches `row`. */
async function openPanel(page: import('@playwright/test').Page, width: number, row: string | RegExp) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/transactions')
  const ledger = page.getByTestId('transactions-ledger')
  await expect(ledger).toBeVisible({ timeout: 15_000 })
  if (width < 768) await dismissMobileSidebar(page)
  await ledger.locator('[role="button"][aria-haspopup="dialog"]').filter({ hasText: row }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe('detail panel polish — header alignment (A)', () => {
  for (const width of VIEWPORTS) {
    test(`a deposit's one-line title centres on its mark (${width})`, async ({ page }) => {
      const browserErrors = collectBrowserErrors(page)
      await mockHavenApi(page)
      await serveTransactions(page, [depositTransaction])
      await seedAuthenticatedSession(page)
      const dialog = await openPanel(page, width, 'Deposit')

      const mark = dialog.locator('span[aria-hidden="true"].h-9.w-9').first()
      const title = dialog.getByRole('heading', { name: 'Deposit' })
      await expect(title).toBeVisible()
      const markBox = await mark.boundingBox()
      const titleBox = await title.boundingBox()
      expect(markBox, 'the 36px direction mark renders').not.toBeNull()
      expect(titleBox, 'the one-line title renders').not.toBeNull()
      const markCentre = markBox!.y + markBox!.height / 2
      const titleCentre = titleBox!.y + titleBox!.height / 2
      expect(
        Math.abs(titleCentre - markCentre),
        `title centre ${titleCentre} vs mark centre ${markCentre}`,
      ).toBeLessThanOrEqual(1)
      expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
    })
  }

  test('the two-line header keeps its top alignment (close button and title block)', async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    // The x402 panel is the two-line case: kindLabel ("Paid request") rides
    // under the title. `items-center` on the row would move the close button
    // ~7px — this pins the pre-existing top edge (py-4) instead.
    const dialog = await openPanel(page, 1280, 'research.example')
    const row = dialog.locator('div.flex.items-start.justify-between').first()
    const close = dialog.getByRole('button', { name: 'Close' })
    const title = dialog.getByRole('heading', { name: 'research.example' })
    await expect(title).toBeVisible()
    const rowBox = await row.boundingBox()
    const closeBox = await close.boundingBox()
    const titleBox = await title.boundingBox()
    // Both sit on the row's content top: the row's own py-4 (16px) below its
    // border-box top — the `items-start` geometry both baselines pin.
    expect(Math.abs(closeBox!.y - rowBox!.y - 16)).toBeLessThanOrEqual(1)
    expect(Math.abs(titleBox!.y - rowBox!.y - 16)).toBeLessThanOrEqual(1)
  })
})

test.describe('detail panel polish — the when-line separator (B)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  const ROWS = ['research.example', 'api.example.dev'] as const

  for (const width of VIEWPORTS) {
    for (const row of ROWS) {
      test(`line 1 of the when-line never ends in "·" (${row}, ${width})`, async ({ page }) => {
        const browserErrors = collectBrowserErrors(page)
        const dialog = await openPanel(page, width, row)
        const stranded = await dialog.evaluate((root) => {
          const p = Array.from(root.querySelectorAll('p')).find((el) => (el.textContent ?? '').includes('·'))
          if (!p) return 'no when-line rendered'
          const text = p.textContent ?? ''
          const idx = text.indexOf('·')
          const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
          let node: Text | null = null
          let offset = idx
          for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
            if (offset < (n.textContent ?? '').length) {
              node = n
              break
            }
            offset -= (n.textContent ?? '').length
          }
          if (!node) return 'separator text node not found'
          const charRange = document.createRange()
          charRange.setStart(node, offset)
          charRange.setEnd(node, offset + 1)
          const charTop = charRange.getBoundingClientRect().top
          const contents = document.createRange()
          contents.selectNodeContents(p)
          const tops = [...new Set(Array.from(contents.getClientRects()).map((r) => Math.round(r.top)))]
          if (tops.length < 2) return null // one line: nothing to strand
          const firstTop = Math.min(...tops)
          // The separator on line 1 of a wrapped line IS the strand.
          return Math.abs(charTop - firstTop) <= 1 ? 'stranded "·" ends line 1' : null
        })
        expect(stranded).toBeNull()
        expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
      })
    }
  }
})

test.describe('detail panel polish — settlement note alignment (C)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    // The needs-attention state rides on the second row (same overlay the
    // visual spec uses), and its unrecorded settlement carries the note.
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname.replace(/^\/api/, '')
      if (request.method() === 'GET' && path === '/transactions') {
        await route.fulfill({
          json: {
            transactions: [
              dashboardTransaction,
              {
                ...x402UnrecordedSettlementTransaction,
                paymentFlowStatus: 'needs_attention',
                paymentAttentionReason: 'merchant_retry_rejected_after_payment',
              },
            ],
            total: 2,
            offset: 0,
            limit: 25,
            hasMore: false,
            partialFailure: false,
            failedAccountIds: [],
            truncated: false,
          },
        })
        return
      }
      await route.fallback()
    })
    await seedAuthenticatedSession(page)
  })

  for (const width of VIEWPORTS) {
    test(`the note's right edge equals the value text's (${width})`, async ({ page }) => {
      const dialog = await openPanel(page, width, 'api.example.dev')
      const edges = await dialog.evaluate((root) => {
        const dd = Array.from(root.querySelectorAll('dd')).find((el) =>
          (el.textContent ?? '').includes('This payment left your account'),
        )
        if (!dd) return null
        const value = dd.querySelector<HTMLDivElement>(':scope > div')
        const note = Array.from(dd.querySelectorAll('p')).find((el) =>
          (el.textContent ?? '').includes('This payment left your account'),
        )
        if (!value || !note) return null
        const rightOf = (el: HTMLElement) => {
          const r = document.createRange()
          r.selectNodeContents(el)
          return r.getBoundingClientRect().right
        }
        return { value: rightOf(value), note: rightOf(note) }
      })
      expect(edges, 'the settlement row with its note is rendered').not.toBeNull()
      expect(Math.abs(edges!.note - edges!.value)).toBeLessThanOrEqual(1)
    })
  }
})

test.describe('detail panel polish — Technical details icon columns (D)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const width of VIEWPORTS) {
    test(`every copy glyph shares one centre x — recorded x402 panel (${width})`, async ({ page }) => {
      const dialog = await openPanel(page, width, 'research.example')
      await dialog.getByTestId('transaction-technical-details').locator('summary').click()
      const centres = await columnCentres(dialog)
      // Five OnChainValue rows with links (merchant, your account, token
      // contract, both transactions) PLUS the linkless Payment ID row — six
      // copy targets, five explorer glyphs, all sharing one column each.
      expect(centres.copy.length).toBeGreaterThanOrEqual(6)
      expect(centres.explorers.length).toBeGreaterThanOrEqual(5)
      expect(spread(centres.copy), `copy glyph spread ${centres.copy}`).toBeLessThanOrEqual(1)
      expect(spread(centres.explorers), `explorer glyph spread ${centres.explorers}`).toBeLessThanOrEqual(1)
    })

    test(`the unknown-chain row's copy glyph sits in the copy column (${width})`, async ({ page }) => {
      await serveTransactions(page, [unknownChainTransaction])
      const dialog = await openPanel(page, width, 'New recipient')
      await dialog.getByTestId('transaction-technical-details').locator('summary').click()
      const centres = await columnCentres(dialog)
      // No registry entry → no explorer link anywhere in this panel; the copy
      // glyphs must still share the column the linked rows use.
      expect(centres.copy.length).toBeGreaterThanOrEqual(4)
      expect(centres.explorers).toEqual([])
      expect(spread(centres.copy), `copy glyph spread ${centres.copy}`).toBeLessThanOrEqual(1)
    })
  }
})

test.describe('detail panel polish — sweep copy on one line (E)', () => {
  for (const width of VIEWPORTS) {
    test(`the What happened value is one line (${width})`, async ({ page }) => {
      const browserErrors = collectBrowserErrors(page)
      await mockHavenApi(page)
      await serveTransactions(page, [sweepTransaction])
      await seedAuthenticatedSession(page)
      const dialog = await openPanel(page, width, 'Returned from Atlas')
      const lineCount = await dialog.evaluate((root) => {
        const dd = Array.from(root.querySelectorAll('dd')).find(
          (el) => el.textContent === 'Unspent allowance returned',
        )
        if (!dd) return -1
        const value = dd.querySelector<HTMLDivElement>(':scope > div')
        if (!value) return -1
        const r = document.createRange()
        r.selectNodeContents(value)
        return [...new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top)))].length
      })
      expect(lineCount, 'the sweep value must not wrap').toBe(1)
      expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
    })
  }
})

test.describe('detail panel polish — the failed headline keeps its sign (F)', () => {
  // Owner ruling 2026-10-23 (F): the sign stays, no strike-through — the
  // failure reads through the danger tone, the badge and the callout.
  test('a failed payment headlines the signed figure in the danger tone', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)
    await mockHavenApi(page)
    await serveTransactions(page, [failedTransaction])
    await seedAuthenticatedSession(page)
    const dialog = await openPanel(page, 1280, 'New recipient')
    const headline = dialog
      .getByTestId('transaction-detail-header')
      .locator('.v2-tabular')
      .first()
    await expect(headline).toHaveText(/-\$0\.50/)
    expect(await headline.evaluate((el) => el.className)).toContain('text-[var(--v2-danger)]')
    await expect(dialog.getByText('Failed', { exact: true })).toBeVisible()
    await expect(
      dialog.getByText('The transaction failed on-chain. Nothing left your account.'),
    ).toBeVisible()
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})

/** Centre x of every copy and explorer glyph inside the opened dialog. */
async function columnCentres(dialog: import('@playwright/test').Locator) {
  return dialog.evaluate((root) => {
    const centre = (svg: Element | null) => {
      if (!svg) return null
      const r = svg.getBoundingClientRect()
      return r.left + r.width / 2
    }
    const copy = Array.from(root.querySelectorAll('button[aria-label^="Copy"]'))
      .map((b) => centre(b.querySelector('svg')))
      .filter((x): x is number => x !== null)
    const explorers = Array.from(root.querySelectorAll('a[aria-label^="Open"]'))
      .map((a) => centre(a.querySelector('svg')))
      .filter((x): x is number => x !== null)
    return { copy, explorers }
  })
}

function spread(xs: number[]): number {
  return Math.max(...xs) - Math.min(...xs)
}
