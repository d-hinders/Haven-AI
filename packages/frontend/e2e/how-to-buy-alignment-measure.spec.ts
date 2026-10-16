/**
 * #4014: the "How to buy" panel's hairlines stay inside its card, and every
 * step keeps its vertical padding.
 *
 * WHAT WAS BROKEN. On `origin/dev` @ `d04617e82` the panel's card was `p-5`
 * and each step sat alone in a default `Card.Section`, whose `-mx-5
 * md:-mx-6` bleed assumes a `p-5 md:p-6` parent. From `md` up the `-mx-6`
 * against `p-5` pushed every section's top border 4px past the padding edge
 * — 3px past the card's border box, since the card has a 1px border and no
 * `overflow-hidden`. And each `StepRow` was `py-3 first:pt-0 last:pb-0`
 * while being the only child of its section, so both paddings went and the
 * step titles sat flush against the hairline above them.
 *
 * THE FIX, and why it is measured. One `Card.Section divided` holds the
 * three rows in an unpadded card, and the rows own their padding. The
 * assertions read the elements that DRAW the hairlines — anything inside the
 * panel with a top border — not the step rows, which sat inside the card
 * even with the bug. A screenshot could absorb a 3px overshoot inside its
 * pixel budget; these read the geometry. The fixture is the
 * `offers-table-alignment-measure.spec.ts` one.
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, serveAddFundsAccount } from './fixtures/haven-api'
import { ampersendDemoApi } from './fixtures/marketplace'

const FROZEN_NOW = new Date('2026-09-17T18:00:00.000Z')
// The step title must clear the divider above it by at least this much: the
// rows are `py-3` (12px), so 8px leaves room for sub-pixel rounding and
// still fails the flush (0px) case by a wide margin.
const MIN_TITLE_GAP = 8

type Rect = { top: number; right: number; bottom: number; left: number }
type Reading = {
  card: Rect
  hairlines: Array<Rect & { label: string }>
  titleGaps: Array<{ step: number; gap: number | null }>
}

function readPanel(page: Page) {
  return page.evaluate<Reading>(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left }
    }
    const panel = document.querySelector('[data-testid="how-to-buy-panel"]')!
    const card = panel.firstElementChild!
    const hairlineEls = [...card.querySelectorAll('*')].filter(
      (el) => parseFloat(getComputedStyle(el).borderTopWidth) > 0,
    )
    const hairlines = hairlineEls.map((el) => ({
      ...rect(el),
      label: `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`,
    }))
    const titleGaps = [1, 2, 3].map((step) => {
      const row = panel.querySelector(`[data-testid="how-to-buy-step-${step}"]`)!
      const title = row.querySelector('p')!
      const titleTop = title.getBoundingClientRect().top
      // The divider above a title is the nearest DIVIDER — a top border with
      // no bottom border, which leaves out the step dots' full outlines —
      // whose top edge is above it; the hairline is drawn at that top.
      const above = hairlineEls
        .filter((el) => parseFloat(getComputedStyle(el).borderBottomWidth) === 0)
        .map((el) => el.getBoundingClientRect().top)
        .filter((t) => t <= titleTop)
      return { step, gap: above.length ? titleTop - Math.max(...above) : null }
    })
    return { card: rect(card), hairlines, titleGaps }
  })
}

for (const { name, width } of [
  { name: 'desktop', width: 1280 },
  { name: 'mobile', width: 390 },
]) {
  test.describe(`how-to-buy panel alignment measure (#4014) — ${name}`, () => {
    test(`hairlines stay inside the card and steps keep their padding at ${width}`, async ({ page }) => {
      await mockHavenApi(page)
      await seedAuthenticatedSession(page)
      await serveAddFundsAccount(page, 84532)
      await page.clock.setFixedTime(FROZEN_NOW)
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/marketplace/${ampersendDemoApi.slug}`)

      const panel = page.getByTestId('how-to-buy-panel')
      await expect(panel.getByTestId('how-to-buy-step-3')).toBeVisible()

      const reading = await readPanel(page)
      // The instrument can say yes: the panel draws at least the two
      // dividers between its three steps.
      expect(reading.hairlines.length, 'no hairlines found inside the panel').toBeGreaterThanOrEqual(2)
      for (const h of reading.hairlines) {
        expect(
          h.left,
          `${h.label} left ${h.left.toFixed(1)} is outside the card's left edge ${reading.card.left.toFixed(1)}`,
        ).toBeGreaterThanOrEqual(reading.card.left - 1)
        expect(
          h.right,
          `${h.label} right ${h.right.toFixed(1)} is outside the card's right edge ${reading.card.right.toFixed(1)}`,
        ).toBeLessThanOrEqual(reading.card.right + 1)
      }
      for (const { step, gap } of reading.titleGaps) {
        expect(gap, `step ${step} has no divider above it`).not.toBeNull()
        expect(gap!, `step ${step}'s title sits ${gap!.toFixed(1)}px below its divider`).toBeGreaterThanOrEqual(
          MIN_TITLE_GAP,
        )
      }
    })
  })
}
