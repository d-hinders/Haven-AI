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

// Roughly 3x the widest body column the sample renders at 1280 (~700px), so
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
