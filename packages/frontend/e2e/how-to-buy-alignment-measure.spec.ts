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
 *
 * #4015: the title became a `Card.Header` band, whose hairline is its
 * BOTTOM border, and the section dropped its own top border so the two do
 * not double. A divider is therefore read as a one-sided border at either
 * edge — a top-only border draws its line at the element's top, a
 * bottom-only border at its bottom — and the spec asserts exactly ONE such
 * line between the band and step 1's title.
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
  dividerCount: number
  titleGaps: Array<{ step: number; gap: number | null }>
  /** Divider lines between the header band's top and step 1's title. */
  linesAboveStep1: number
}

function readPanel(page: Page) {
  return page.evaluate<Reading>(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left }
    }
    const panel = document.querySelector('[data-testid="how-to-buy-panel"]')!
    const card = panel.firstElementChild!
    const topW = (el: Element) => parseFloat(getComputedStyle(el).borderTopWidth)
    const bottomW = (el: Element) => parseFloat(getComputedStyle(el).borderBottomWidth)
    const hairlineEls = [...card.querySelectorAll('*')].filter((el) => topW(el) > 0 || bottomW(el) > 0)
    // A DIVIDER is a one-sided border: the header band's `border-b` (its
    // line at its bottom) and `divide-y`'s top border on rows 2 and 3 (at
    // their tops). The step dots have full outlines, so they are hairline
    // elements but never dividers.
    const dividerLines = hairlineEls.flatMap((el) => {
      const r = el.getBoundingClientRect()
      if (topW(el) > 0 && bottomW(el) === 0) return [r.top]
      if (bottomW(el) > 0 && topW(el) === 0) return [r.bottom]
      return []
    })
    const hairlines = hairlineEls.map((el) => ({
      ...rect(el),
      label: `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`,
    }))
    const titleGaps = [1, 2, 3].map((step) => {
      const row = panel.querySelector(`[data-testid="how-to-buy-step-${step}"]`)!
      const title = row.querySelector('p')!
      const titleTop = title.getBoundingClientRect().top
      // The divider above a title is the nearest divider line above it.
      const above = dividerLines.filter((t) => t <= titleTop)
      return { step, gap: above.length ? titleTop - Math.max(...above) : null }
    })
    const step1TitleTop = panel.querySelector('[data-testid="how-to-buy-step-1"] p')!.getBoundingClientRect().top
    const linesAboveStep1 = dividerLines.filter((t) => t <= step1TitleTop).length
    return { card: rect(card), hairlines, dividerCount: dividerLines.length, titleGaps, linesAboveStep1 }
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
      // The instrument can say yes: one divider above the steps and one
      // between each pair — counted over dividers only, so the step dots'
      // outlines cannot stand in for a missing `divide-y`.
      expect(reading.dividerCount, 'the panel should draw three step dividers').toBeGreaterThanOrEqual(3)
      // #4015: exactly ONE hairline between the header band and step 1 —
      // the band's own `border-b`; a section `border-t` would make it two.
      expect(reading.linesAboveStep1, 'hairlines between the "How to buy" header and step 1').toBe(1)
      for (const h of reading.hairlines) {
        expect(
          h.left,
          `${h.label} left ${h.left.toFixed(1)} is outside the card's left edge ${reading.card.left.toFixed(1)}`,
        ).toBeGreaterThanOrEqual(reading.card.left - 1)
        expect(
          h.right,
          `${h.label} right ${h.right.toFixed(1)} is outside the card's right edge ${reading.card.right.toFixed(1)}`,
        ).toBeLessThanOrEqual(reading.card.right + 1)
        expect(h.top, `${h.label} top is above the card`).toBeGreaterThanOrEqual(reading.card.top - 1)
        expect(h.bottom, `${h.label} bottom is below the card`).toBeLessThanOrEqual(reading.card.bottom + 1)
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
