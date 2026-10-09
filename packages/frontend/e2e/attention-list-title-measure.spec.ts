/**
 * AttentionList titles: one line with an ellipsis from `sm` up, a two-line
 * clamp below it (#3861).
 *
 * WHAT WAS BROKEN. Rows passed `whitespace-normal line-clamp-2
 * sm:whitespace-nowrap sm:line-clamp-none` to `Row`'s title, which always
 * carries `truncate`. Tailwind's `line-clamp-none` sets `overflow: visible`,
 * and `text-overflow: ellipsis` paints nothing without a hidden overflow — so
 * on desktop a long title ran under the trailing badge and was cut mid-word
 * by the row's edge, with no `…` ("Research agent reached its budge"). The
 * clamp is now scoped `max-sm:`, leaving `Row`'s plain `truncate` from `sm` up.
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT. The /design-system AttentionList clip
 * carries short titles, so it never overflows and no baseline could see this;
 * a class assertion cannot either — the bug was a class string that read
 * correctly. So this spec lengthens one rendered title and reads what the
 * browser actually computes: the title overflows its own box, and the box
 * hides that overflow behind an ellipsis on one line (desktop) or clamps it
 * to two lines (mobile width).
 */
import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

const LONG_TITLE =
  'Research agent reached its budget for this period and approves nothing further until you raise or clear it'

interface TitleMetrics {
  overflowX: string
  textOverflow: string
  whiteSpace: string
  lineClamp: string
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
  height: number
  lineHeight: number
}

async function lengthenFirstTitle(page: import('@playwright/test').Page): Promise<TitleMetrics> {
  const sample = page.getByTestId('ds-attention-list')
  await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(4)
  return sample.locator('li p.font-medium').first().evaluate((el, title) => {
    el.textContent = title
    const cs = getComputedStyle(el)
    return {
      overflowX: cs.overflowX,
      textOverflow: cs.textOverflow,
      whiteSpace: cs.whiteSpace,
      lineClamp: cs.getPropertyValue('-webkit-line-clamp'),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(cs.lineHeight),
    }
  }, LONG_TITLE)
}

test.describe('AttentionList title overflow (#3861)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('from sm up a long title is one line ending in an ellipsis', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/design-system')
    const m = await lengthenFirstTitle(page)
    // The title really is longer than its box — otherwise nothing below is tested.
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth)
    expect(m.whiteSpace).toBe('nowrap')
    // The pair `text-overflow` needs to paint: the #3861 defect was `visible` here.
    expect(m.overflowX).toBe('hidden')
    expect(m.textOverflow).toBe('ellipsis')
    expect(m.height).toBeLessThan(m.lineHeight * 1.5)
  })

  test('below sm a long title wraps and clamps to two lines', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/design-system')
    const m = await lengthenFirstTitle(page)
    // The title really runs past two lines — otherwise the clamp is untested.
    expect(m.scrollHeight).toBeGreaterThan(m.clientHeight)
    expect(m.whiteSpace).toBe('normal')
    expect(m.lineClamp).toBe('2')
    expect(m.overflowX).toBe('hidden')
    expect(m.height).toBeGreaterThan(m.lineHeight * 1.5)
    expect(m.height).toBeLessThan(m.lineHeight * 2.5)
  })
})
