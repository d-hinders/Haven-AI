/**
 * AttentionList titles and subtitles: two lines, then an ellipsis, at every
 * width (#3861, then #3876).
 *
 * #3861 — rows passed `whitespace-normal line-clamp-2 sm:whitespace-nowrap
 * sm:line-clamp-none` to `Row`'s title, which always carries `truncate`.
 * Tailwind's `line-clamp-none` sets `overflow: visible`, and `text-overflow:
 * ellipsis` paints nothing without a hidden overflow — so on desktop a long
 * title ran under the trailing badge and was cut mid-word by the row's edge,
 * with no `…`. The fix scoped the clamp `max-sm:`, leaving a one-line
 * ellipsis from `sm` up.
 *
 * #3876 — that one line still hid the item: in the narrow desktop Needs-you
 * panel a title read "Haven paused spon…" and the subtitle truncated too, so
 * the full text was on screen nowhere. The owner chose a two-line clamp
 * everywhere, for the title AND the subtitle (2026-10-10), over a hover-only
 * `title` attribute. The old desktop arm here ("one line ending in an
 * ellipsis") is that rule reversed, so it was rewritten, not deleted.
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT. The /design-system AttentionList clip
 * carries text that fits, and a class assertion cannot see this either —
 * #3861 was a class string that read correctly. So each arm writes text far
 * longer than two lines into one rendered paragraph and reads what the
 * browser computes. Every arm first proves the text really overflows
 * (`scrollHeight > clientHeight`) — without that, a clamp that never engages
 * passes — and keeps `overflow-x: hidden`, the #3861 guard.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

// At least 3x the widest body column the sample renders at 1280 (~700px), so
// it overflows two lines at both measured widths, for the 14px title and the
// 12px subtitle alike.
const LONG_TEXT = Array.from(
  { length: 4 },
  () => 'Research agent reached its budget for this period and approves nothing further until you raise or clear it.',
).join(' ')

// The title is Row's `font-medium` paragraph; the subtitle is its `text-xs`
// one. Separate locators, so the subtitle arm cannot measure the title twice.
const PARTS = {
  title: 'li p.font-medium',
  subtitle: 'li p.text-xs',
} as const

interface Metrics {
  overflowX: string
  whiteSpace: string
  lineClamp: string
  scrollHeight: number
  clientHeight: number
  height: number
  lineHeight: number
}

async function lengthen(page: Page, part: keyof typeof PARTS): Promise<Metrics> {
  const sample = page.getByTestId('ds-attention-list')
  await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(4)
  return sample
    .locator(PARTS[part])
    .first()
    .evaluate((el, text) => {
      el.textContent = text
      const cs = getComputedStyle(el)
      return {
        overflowX: cs.overflowX,
        whiteSpace: cs.whiteSpace,
        lineClamp: cs.getPropertyValue('-webkit-line-clamp'),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(cs.lineHeight),
      }
    }, LONG_TEXT)
}

const WIDTHS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile width', width: 390, height: 844 },
]

test.describe('AttentionList text overflow (#3861, #3876)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const vp of WIDTHS) {
    for (const part of ['title', 'subtitle'] as const) {
      test(`${vp.name}: a long ${part} wraps and clamps to two lines`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height })
        await page.goto('/design-system')
        const m = await lengthen(page, part)
        // The text really runs past two lines — otherwise the clamp is untested.
        expect(m.scrollHeight).toBeGreaterThan(m.clientHeight)
        expect(m.whiteSpace).toBe('normal')
        expect(m.lineClamp).toBe('2')
        // `text-overflow` needs a hidden overflow to paint: the #3861 defect was `visible` here.
        expect(m.overflowX).toBe('hidden')
        expect(m.height).toBeGreaterThan(m.lineHeight * 1.5)
        expect(m.height).toBeLessThan(m.lineHeight * 2.5)
      })
    }
  }
})

/**
 * First-line alignment (#3880). With both lines clamped to two, a row body
 * runs to four lines; the leading icon — and, beside the body from `sm` up,
 * the dismiss — must be centred on the title's FIRST line, not on the body.
 * The arm first makes the body at least two lines taller than the 32px icon:
 * the unmodified sample rows (~38px bodies) would pass by accident, ~3px off.
 */
const FIRST_LINE_TOLERANCE_PX = 2

test.describe('AttentionList first-line alignment (#3880)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const vp of WIDTHS) {
    test(`${vp.name}: the icon${vp.width >= 640 ? ' and the dismiss' : ''} sit on the title's first line`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      const sample = page.getByTestId('ds-attention-list')
      await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(4)
      const m = await sample
        .locator('li')
        .first()
        .evaluate((li, text) => {
          const title = li.querySelector('p.font-medium') as HTMLElement
          const subtitle = li.querySelector('p.text-xs') as HTMLElement
          title.textContent = text
          subtitle.textContent = text
          const icon = li.querySelector('span[aria-hidden="true"]') as HTMLElement
          const dismiss = li.querySelector('[data-attention-dismiss]') as HTMLElement
          const t = title.getBoundingClientRect()
          const s = subtitle.getBoundingClientRect()
          const i = icon.getBoundingClientRect()
          const d = dismiss.getBoundingClientRect()
          const lineHeight = parseFloat(getComputedStyle(title).lineHeight)
          return {
            bodyHeight: s.bottom - t.top,
            iconHeight: i.height,
            lineHeight,
            firstLineCentre: t.top + lineHeight / 2,
            iconCentre: i.top + i.height / 2,
            dismissCentre: d.top + d.height / 2,
            dismissBesideBody: d.top < s.bottom,
          }
        }, LONG_TEXT)
      // Precondition: the body is far taller than the icon, so centring on
      // the body and centring on the first line give different answers.
      expect(m.bodyHeight).toBeGreaterThanOrEqual(m.iconHeight + 2 * m.lineHeight)
      expect(Math.abs(m.iconCentre - m.firstLineCentre)).toBeLessThanOrEqual(FIRST_LINE_TOLERANCE_PX)
      if (vp.width >= 640) {
        expect(m.dismissBesideBody, 'from sm up the dismiss sits beside the body').toBe(true)
        expect(Math.abs(m.dismissCentre - m.firstLineCentre)).toBeLessThanOrEqual(FIRST_LINE_TOLERANCE_PX)
      }
    })
  }

  // The narrow desktop Needs-you panel wraps the controls of most rows onto
  // their own line. Aligning controls that sit BESIDE the body must not pull
  // wrapped ones toward the text: the #3880 code review caught a `-mt-1.5`
  // version shrinking this gap from Row's 12px to 6px on three of the four
  // dashboard rows.
  test('desktop: controls that wrap onto their own line keep the row gap', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/design-system')
    const sample = page.getByTestId('ds-attention-list')
    await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(4)
    const m = await sample.evaluate((el) => {
      const li = el.querySelector('li') as HTMLElement
      const subtitle = li.querySelector('p.text-xs') as HTMLElement
      const trailing = (li.querySelector('[data-attention-dismiss]') as HTMLElement).closest('div.flex-shrink-0') as HTMLElement
      // Narrow the sample until the controls cannot sit beside the body (the
      // dashboard panel wraps rows with an action the same way): leave room
      // for the icon and gaps but not for the trailing slot.
      ;(el as HTMLElement).style.width = `${Math.ceil(trailing.getBoundingClientRect().width) + 40}px`
      const rowGap = parseFloat(getComputedStyle(trailing.parentElement as HTMLElement).rowGap)
      return {
        gap: trailing.getBoundingClientRect().top - subtitle.getBoundingClientRect().bottom,
        rowGap,
        wrapped: trailing.getBoundingClientRect().top >= subtitle.getBoundingClientRect().bottom,
      }
    })
    expect(m.wrapped, 'the narrowed row wraps its controls under the body').toBe(true)
    expect(Math.abs(m.gap - m.rowGap)).toBeLessThanOrEqual(1)
  })
})
