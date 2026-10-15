/**
 * #4008: the "Other networks" nested table lines up with the outer one.
 *
 * WHAT WAS BROKEN. The desktop disclosure renders a second `Table` inside a
 * `colSpan={4}` cell of the outer table. On `origin/dev` @ `355af0718` that
 * nested table sized its columns on its own content — auto layout — and the
 * cell's `px-4` shifted its left edge, so at 1280 the two tables' cells sat
 * up to 16px apart (outer 273/744/889/1022 vs nested 289/737/898/982, and
 * the Copy button's right edge 1231 vs 1215).
 *
 * THE FIX, and why it is measured rather than snapshotted. Both tables carry
 * `table-layout: fixed` and one shared `colgroup` (`OFFER_COLUMN_LAYOUT`,
 * `OffersTable.tsx`), and the colSpan cell lost its horizontal padding — so
 * the nested table spans the row's full width and its columns are decided by
 * the same declaration as the outer table's. A measure spec (the
 * `agent-card-fit-measure.spec.ts` pattern) is the honest gate for that: a
 * full-page screenshot could pass with the misalignment in it (and the
 * pixel budget would absorb a 1px column shift), while these assertions read
 * the geometry itself. Rows stay in the DOM while the disclosure is
 * collapsed (`OffersTable.test.tsx`), so the spec OPENS the disclosure
 * before measuring — the same fixture shape as the merchant-page visual
 * scenario: a Base Sepolia default account keeps Fact and Joke in the outer
 * table and puts Quote behind the "1 more on Base" disclosure.
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, serveAddFundsAccount } from './fixtures/haven-api'
import { ampersendDemoApi } from './fixtures/marketplace'

// The desktop width the QA run measured the misalignment at.
const DESKTOP = 1280
// The frozen clock keeps the freshness line ("verified 2d ago") from moving
// the cells the same way `marketplace.visual.spec.ts` pins it.
const FROZEN_NOW = new Date('2026-09-17T18:00:00.000Z')

type Reading = {
  outerLefts: number[]
  nestedLefts: number[]
  outerCopyRight: number
  nestedCopyRight: number
}

function readTables(page: Page) {
  return page.evaluate<Reading>(() => {
    const left = (el: Element) => el.getBoundingClientRect().left
    const right = (el: Element) => el.getBoundingClientRect().right
    const outer = document.querySelector('[data-testid="offers-table"] table')!
    const nested = document.querySelector('[data-testid="other-networks"] table')!
    // The outer table's own rows: the disclosure's colSpan row CONTAINS the
    // nested table, so skip any `tr` that holds one.
    const outerRow = [...outer.querySelectorAll('tbody > tr')].find(
      (tr) => !tr.querySelector('[data-testid="other-networks"]'),
    )!
    const nestedRow = nested.querySelector('tbody > tr')!
    const copyButton = (row: Element) =>
      [...row.querySelectorAll('button')].find((b) => /^Copy prompt for /.test(b.getAttribute('aria-label') ?? ''))!
    return {
      outerLefts: [...outerRow.querySelectorAll(':scope > td')].map(left),
      nestedLefts: [...nestedRow.querySelectorAll(':scope > td')].map(left),
      outerCopyRight: right(copyButton(outerRow)),
      nestedCopyRight: right(copyButton(nestedRow)),
    }
  })
}

test.describe('offers-table alignment measure (#4008)', () => {
  test('the nested "Other networks" table shares the outer table\'s column layout at 1280', async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    await serveAddFundsAccount(page, 84532)
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.setViewportSize({ width: DESKTOP, height: 800 })
    await page.goto(`/marketplace/${ampersendDemoApi.slug}`)

    const table = page.getByTestId('offers-table')
    await expect(table).toBeVisible()
    // The disclosure row is the LAST `tr` of the outer table (after the two
    // on-network offers) and its nested table holds the hidden Quote row.
    await expect(table.getByTestId('offer-row-offer-ampersend-quote')).toHaveCount(1)
    await table.getByTestId('other-networks').locator('summary').click()
    await expect(table.getByTestId('offer-row-offer-ampersend-quote').locator('visible=true')).toHaveCount(1)

    const reading = await readTables(page)
    expect(reading.outerLefts).toHaveLength(4)
    expect(reading.nestedLefts).toHaveLength(4)
    for (let i = 0; i < 4; i += 1) {
      const drift = Math.abs(reading.outerLefts[i]! - reading.nestedLefts[i]!)
      expect(
        drift,
        `column ${i}: outer left ${reading.outerLefts[i]!.toFixed(1)} vs nested ${reading.nestedLefts[i]!.toFixed(1)} — ` +
          `the nested table is not sharing the outer table's fixed column layout`,
      ).toBeLessThanOrEqual(1)
    }
    const copyDrift = Math.abs(reading.outerCopyRight - reading.nestedCopyRight)
    expect(
      copyDrift,
      `Copy button right edge: outer ${reading.outerCopyRight.toFixed(1)} vs nested ${reading.nestedCopyRight.toFixed(1)}`,
    ).toBeLessThanOrEqual(1)
  })
})
