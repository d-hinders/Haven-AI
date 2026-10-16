/**
 * #4016: a default `Card.Section` renders `-mx-5 md:-mx-6 px-5 md:px-6
 * border-t`, so it only lines up inside a Card padded `p-5 md:p-6`. This
 * measure covers the two frontend instances the issue cites, at 1280 and
 * 390px, reading geometry the way `how-to-buy-alignment-measure.spec.ts`
 * (#4014) does — the elements that DRAW the hairlines, not a screenshot.
 *
 * WHAT WAS BROKEN.
 * - `/design-system` showcase (`card-section-default`): the card was `p-5`
 *   while its two default sections bleed `-mx-6` from `md` up, pushing each
 *   hairline 4px past the padding edge — 3px past the card's border box.
 *   Fixed to `p-5 md:p-6`. The measure asserts every top-bordered element
 *   inside the card stays within the card's rect ±1px, that at least one
 *   hairline exists (the sections' `border-t` — the set must not be empty),
 *   and that section content sits at least 16px inside the card's left edge.
 * - `/device` (`DeviceApprovalClient`): a default section sat directly in an
 *   UNPADDED card — the hairline extended 20px (24px at md+) past each side
 *   and the form started at the card edge. The section was DROPPED (a lone
 *   section at the top of a card only draws a hairline on the card's own top
 *   edge) and the card padded `p-5 md:p-6` instead. With no section left the
 *   hairline set may be empty here; the measure asserts the content inset
 *   that replaces it, and still requires every top-bordered element (the
 *   input's border) to stay inside the card.
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

type Rect = { top: number; right: number; bottom: number; left: number }

const MIN_CONTENT_INSET = 16

async function measure(page: Page, cardSelector: string, contentSelector: string) {
  return page.evaluate(
    ({ cardSelector, contentSelector }) => {
      const card = document.querySelector(cardSelector)!
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect()
        return { top: r.top, right: r.right, bottom: r.bottom, left: r.left }
      }
      const hairlines = [...card.querySelectorAll('*')]
        .filter((el) => parseFloat(getComputedStyle(el).borderTopWidth) > 0)
        .map((el) => ({ ...rect(el), label: el.tagName.toLowerCase() }))
      const contents = [...card.querySelectorAll(contentSelector)].map((el) => ({
        ...rect(el),
        label: el.tagName.toLowerCase(),
      }))
      return {
        card: rect(card),
        hairlines,
        contentLeft: contents.length ? Math.min(...contents.map((c) => c.left)) : null,
        contentLabels: contents.map((c) => c.label),
      }
    },
    { cardSelector, contentSelector },
  )
}

for (const { name, width } of [
  { name: 'desktop', width: 1280 },
  { name: 'mobile', width: 390 },
]) {
  test.describe(`card-section default-mode alignment measure (#4016) — ${name}`, () => {
    test(`design-system showcase hairlines stay inside the p-5 md:p-6 card at ${width}`, async ({
      page,
    }) => {
      await mockHavenApi(page)
      await seedAuthenticatedSession(page)
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/design-system')

      const section = page.getByTestId('card-section-default')
      await expect(section).toBeVisible()
      // The Section renders its heading div first, then the Card, then the
      // closing note — the Card is the section's second child.
      const reading = await measure(page, '[data-testid="card-section-default"] > div:nth-child(2)', 'p, dl')

      // The instrument can say yes: the two default sections draw a border-t
      // each, so an empty hairline set can never pass.
      expect(
        reading.hairlines.length,
        'the showcase card should draw at least one section hairline',
      ).toBeGreaterThanOrEqual(1)
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
      // Content, not just hairlines: a flush section (px inset 0) would pass
      // the rect checks above while its text sits on the card edge.
      expect(
        reading.contentLeft! - reading.card.left,
        `section content sits ${reading.contentLeft! - reading.card.left}px inside the card's left edge`,
      ).toBeGreaterThanOrEqual(MIN_CONTENT_INSET)
    })

    test(`device approval card keeps the form inset with no bleeding section at ${width}`, async ({
      page,
    }) => {
      await mockHavenApi(page)
      await seedAuthenticatedSession(page)
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/device')

      const form = page.locator('main form, form').first()
      await expect(form).toBeVisible()
      // The card is the form's parent: the section was dropped, so the card
      // owns the padding directly (#4016).
      const reading = await page.evaluate(() => {
        const form = document.querySelector('main form') ?? document.querySelector('form')!
        const card = form.parentElement!
        const rect = (el: Element) => {
          const r = el.getBoundingClientRect()
          return { top: r.top, right: r.right, bottom: r.bottom, left: r.left }
        }
        const hairlines = [...card.querySelectorAll('*')]
          .filter((el) => parseFloat(getComputedStyle(el).borderTopWidth) > 0)
          .map((el) => ({ ...rect(el), label: el.tagName.toLowerCase() }))
        return { card: rect(card), form: rect(form), hairlines }
      })

      // No section left means no hairline may bleed: any top-bordered element
      // (the input's border) must still sit inside the card's rect ±1px.
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
      // The dropped section's replacement: the form content insets like any
      // p-5 md:p-6 card's content, not at the card edge as the bug had it.
      expect(
        reading.form.left - reading.card.left,
        `the form sits ${reading.form.left - reading.card.left}px inside the card's left edge`,
      ).toBeGreaterThanOrEqual(MIN_CONTENT_INSET)
    })
  })
}
