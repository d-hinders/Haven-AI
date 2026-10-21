/**
 * The summary card's three columns end at about the same height (#4166).
 *
 * WHAT WAS BROKEN. The card followed mockup v9's anatomy — Holdings as a
 * header row with right-aligned amounts, Money in and Money out side by
 * side — but nothing measured the owner's acceptance bar: at 1280 px the
 * three columns' content blocks must differ by at most 24 px, so no column
 * leaves the others with dead space under them (the owner's "unbalanced…
 * not like in the mockup", on #4093).
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT — the same reason as
 * `transaction-amount-wrap.spec.ts`: the committed pixel baselines carried
 * the layout, so a screenshot gate is definitionally unable to catch the
 * shape; and the bar is stated in pixels, not in a screenshot's diff budget.
 * Heights come from `getBoundingClientRect` per column, exactly the
 * criterion's own instrument.
 *
 * The shared fixture is the measured state: ONE priced token (the
 * single-token rule shows no value line), so the Holdings column carries the
 * header row plus one mark row — the standard render's shape. A degraded or
 * multi-token read grows the column with real content; the bar here is about
 * the standard layout, not a state's own weight.
 *
 * The stacking half of the criterion is structural: below the `md` stacking
 * breakpoint the three sections must STACK (no side-by-side columns), which
 * is asserted geometrically — each section starts below the previous one's
 * bottom edge.
 *
 * #4197 adds the one-row bar for Last 30 days: the column reads as the title
 * plus ONE row — an inline in-arrow and the Money-in figure, then the
 * out-arrow pair — replacing #4166's label row. At 1280 px the two pairs
 * share a line; at 375 px they fit that line or wrap cleanly with no
 * clipping. Same reason as the height bar: geometry, not a screenshot.
 */
import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

test.beforeEach(async ({ page }) => {
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
})

/** The summary card's three column sections, keyed by their aria-labels. */
const SECTIONS = ['Balance', 'Holdings', 'Last 30 days'] as const

/** The acceptance bar, verbatim from #4166. */
const MAX_HEIGHT_DIFF_PX = 24

test('the three summary columns end within 24px of each other at 1280', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/accounts/safe-main')

  // Wait for the card to render its real content, not a skeleton.
  await expect(page.getByRole('region', { name: 'Holdings' })).toBeVisible()
  await expect(page.locator('.animate-pulse')).toHaveCount(0)

  const heights = await page.evaluate((labels: string[]) => {
    const read = (label: string) => {
      const section = document.querySelector(`section[aria-label="${label}"]`)
      if (!section) return null
      const box = section.getBoundingClientRect()
      const style = getComputedStyle(section)
      // The column's CONTENT block: the section box minus its own padding —
      // the criterion's "content block", immune to a padding-only change.
      return box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    }
    return Object.fromEntries(labels.map((label) => [label, read(label)]))
  }, [...SECTIONS])

  for (const label of SECTIONS) {
    expect(heights[label], `${label} column did not render`).not.toBeNull()
  }
  const values = SECTIONS.map((label) => heights[label] as number)
  const diff = Math.max(...values) - Math.min(...values)
  expect(
    diff,
    `column content heights ${JSON.stringify(heights)} differ by ${diff.toFixed(1)}px`,
  ).toBeLessThanOrEqual(MAX_HEIGHT_DIFF_PX)
})

test('below the stacking breakpoint the three columns stack', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/accounts/safe-main')

  await expect(page.getByRole('region', { name: 'Holdings' })).toBeVisible()
  await expect(page.locator('.animate-pulse')).toHaveCount(0)

  const boxes = await page.evaluate((labels: string[]) =>
    labels.map((label) => {
      const section = document.querySelector(`section[aria-label="${label}"]`)
      const box = section?.getBoundingClientRect()
      return { label, top: box?.top, bottom: box?.bottom, left: box?.left }
    }), [...SECTIONS])

  for (let i = 1; i < boxes.length; i += 1) {
    const prev = boxes[i - 1]!
    const cur = boxes[i]!
    expect(
      cur.top,
      `${cur.label} must stack below ${prev.label} on a phone`,
    ).toBeGreaterThanOrEqual(prev.bottom!)
    // Same left edge: a stacked column, not a side-by-side remainder.
    expect(Math.abs(cur.left! - prev.left!), `${cur.label} shares ${prev.label}'s left edge`).toBeLessThan(1)
  }
})

test('Last 30 days is the title plus ONE row — the two icon-and-figure pairs on a line at 1280 (#4197)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/accounts/safe-main')

  const section = page.getByRole('region', { name: 'Last 30 days' })
  await expect(section).toBeVisible()
  await expect(page.locator('.animate-pulse')).toHaveCount(0)

  const geo = await page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Last 30 days"]')
    if (!section) return null
    // The shared fixture has no freshness, unpriced or partial notes, so the
    // section's elements are exactly the title and the one row.
    const row = section.querySelector('div.flex-wrap')
    const pairRects = row ? Array.from(row.children).map((el) => el.getBoundingClientRect()) : []
    return {
      elementCount: section.children.length,
      pairCount: pairRects.length,
      tops: pairRects.map((r) => r.top),
      inArrowPresent: Boolean(section.querySelector('svg.lucide-arrow-down')),
      outArrowPresent: Boolean(section.querySelector('svg.lucide-arrow-up')),
    }
  })
  expect(geo).not.toBeNull()
  // Title + one content row: #4166's label row is gone.
  expect(geo!.elementCount, 'the column is the title plus one row, nothing else').toBe(2)
  expect(geo!.pairCount).toBe(2)
  expect(geo!.inArrowPresent).toBe(true)
  expect(geo!.outArrowPresent).toBe(true)
  // One line: the two pairs share the same vertical band.
  expect(
    Math.abs(geo!.tops[0]! - geo!.tops[1]!),
    `the in and out pairs must share a line (tops ${geo!.tops.join(' / ')})`,
  ).toBeLessThan(1)
})

test('at 375px the Last 30 days pairs fit one line or wrap cleanly with no clipping (#4197)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 })
  await page.goto('/accounts/safe-main')

  const section = page.getByRole('region', { name: 'Last 30 days' })
  await expect(section).toBeVisible()
  await expect(page.locator('.animate-pulse')).toHaveCount(0)

  const geo = await page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Last 30 days"]')
    const row = section?.querySelector('div.flex-wrap')
    if (!row) return null
    const rowRect = row.getBoundingClientRect()
    const rects = Array.from(row.children).map((el) => el.getBoundingClientRect())
    return {
      rights: rects.map((r) => r.right),
      rowScrollWidth: row.scrollWidth,
      rowClientWidth: row.clientWidth,
      rowRight: rowRect.right,
      innerWidth: window.innerWidth,
    }
  })
  expect(geo).not.toBeNull()
  expect(geo!.rights.length).toBe(2)
  // No clipping: each pair ends inside the viewport, the wrapping row never
  // overflows itself, and the page gains no horizontal scroll from the row.
  for (const right of geo!.rights) {
    expect(right, 'a pair must not run past the viewport').toBeLessThanOrEqual(geo!.innerWidth)
  }
  expect(
    geo!.rowScrollWidth,
    'the wrapping row must not overflow its own box',
  ).toBeLessThanOrEqual(geo!.rowClientWidth + 1)
  expect(geo!.rowRight).toBeLessThanOrEqual(geo!.innerWidth)
})
