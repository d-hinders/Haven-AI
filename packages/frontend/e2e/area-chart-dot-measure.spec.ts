/**
 * `ui/AreaChart` dot geometry, measured in rendered CSS px (#3903).
 *
 * WHAT WAS BROKEN. AreaChart drew its dots as `<circle>`s inside an svg that
 * stretches with `preserveAspectRatio="none"`, so every dot rendered as an
 * OVAL wherever the box's aspect differs from the viewBox's — measured
 * ~3.5 × 5.5 CSS px on the dashboard money card's sparkline and ~7.0 × 4.5 px
 * on the desktop analytics balance chart. The fix renders the dots as HTML
 * elements positioned like the chart's labels (a percentage of the viewBox
 * for the full chart, CSS px for the sparkline), so they are round at every
 * width; the sparkline's box takes a CSS-px inset so the round end dot stays
 * INSIDE the box — #3902's containment guarantee, restated in CSS px, which
 * the old viewBox-unit check cannot carry for an HTML dot.
 *
 * WHY GEOMETRY AND NOT A SCREENSHOT. The dot is 6 px; no pixel budget
 * measures its shape, and the oval's asymmetry is largest at exactly the
 * widths the baselines render. `getBoundingClientRect` measures it directly.
 * This spec FAILS on the pre-#3903 `<circle>` implementation — its rects are
 * ovals at these widths, and its 0-value end dot straddles the box's bottom
 * edge — because the combined selectors below match the dot under BOTH
 * implementations (an svg `<circle>` or the HTML span), so the probe is the
 * same element before and after the fix.
 *
 * PROJECT. `chromium-desktop` — the 390 arm here therefore measures at DSF 1.
 * `area-chart-dot.mobile.spec.ts` is the DSF 2.75 arm (Pixel 5), where the
 * true phone rendering lives.
 */
import { expect, test, type Page } from '@playwright/test'
import { dashboardOverview, dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
import { analyticsOverview } from './fixtures/analytics-overview'

/** The issue's acceptance bound: |width − height| ≤ 0.25 px on the dot's
 *  rect. An svg circle's rect excludes its stroke and an HTML dot's includes
 *  its (borderless) box — the probe compares the SAME element's rect either
 *  way, so like is compared with like. */
const ROUNDNESS_TOLERANCE_PX = 0.25

/** The sparkline's end dot, under both implementations. */
const SPARKLINE_DOT =
  '[data-testid="area-chart-sparkline"] circle, [data-testid="area-chart-sparkline-dot"]'
/** The sparkline's box — the containment bound (#3903 replaces the old
 *  viewBox-unit check, which an HTML dot does not carry). */
const SPARKLINE_BOX = '[data-testid="area-chart-sparkline"]'
/** Every full-chart point dot, under both implementations. */
const PLOT_DOTS =
  '[data-testid="chart-plot"] circle, [data-testid="chart-plot"] [data-testid="area-point-dot"]'

type Rect = { x: number; y: number; width: number; height: number }

async function rectsOf(page: Page, selector: string): Promise<Rect[]> {
  return page
    .evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).map((el) => {
        const b = el.getBoundingClientRect()
        // A display:none half of a desktop/narrow pair measures 0 × 0 — not
        // a rendered dot, and not measurable either; drop it.
        if (b.width === 0 || b.height === 0) return null
        return { x: b.x, y: b.y, width: b.width, height: b.height }
      })
    }, selector)
    .then((rs) => rs.filter((r): r is Rect => r !== null))
}

function expectRound(rects: Rect[], label: string) {
  expect(
    rects.length,
    `${label}: no dot was rendered to measure`,
  ).toBeGreaterThanOrEqual(1)
  for (const [i, r] of rects.entries()) {
    expect(
      Math.abs(r.width - r.height),
      `${label}: dot ${i} measured ${r.width.toFixed(3)} × ${r.height.toFixed(
        3,
      )} CSS px — an oval, not a round dot`,
    ).toBeLessThanOrEqual(ROUNDNESS_TOLERANCE_PX)
  }
}

function expectContained(dot: Rect, box: Rect, label: string) {
  const edges: Array<[string, number, number]> = [
    ['left', dot.x, box.x],
    ['top', dot.y, box.y],
    ['right', box.x + box.width, dot.x + dot.width],
    ['bottom', box.y + box.height, dot.y + dot.height],
  ]
  for (const [edge, bound, value] of edges) {
    expect(
      value,
      `${label}: the dot crosses the box's ${edge} — dot ${edge} ${value.toFixed(
        3,
      )} against bound ${bound.toFixed(3)}`,
    ).toBeLessThanOrEqual(bound)
  }
}

/**
 * The dashboard fixture with the LAST balance day set to `lastUsd`, so the
 * containment arms can drive the two extreme cases the issue names: a last
 * value of 0 and of the maximum. Registered AFTER `mockHavenApi`, so it wins
 * the route for this path alone (Playwright matches the most recent route
 * first) and every other endpoint still falls through to the standard
 * fixture.
 */
async function serveOverviewWithLastBalance(page: Page, lastUsd: number) {
  const body = JSON.parse(JSON.stringify(dashboardOverview)) as typeof dashboardOverview
  const days = body.spend.balance_by_day
  days[days.length - 1].totalUsd = lastUsd
  // Trailing `*`: glob patterns must match the whole URL including any query
  // string, and these reads carry one.
  await page.route('**/api/dashboard/overview*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  )
}

/** The analytics fixture, served verbatim (the populated scenario's body). */
async function serveAnalyticsOverview(page: Page) {
  await page.route('**/api/analytics/overview*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(analyticsOverview),
    }),
  )
}

test.beforeEach(async ({ page }) => {
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
})

for (const width of [1280, 390]) {
  test(`the dashboard money card's sparkline end dot is round at ${width} (DSF 1)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/dashboard')
    await expect
      .poll(async () => (await rectsOf(page, SPARKLINE_DOT)).length)
      .toBeGreaterThanOrEqual(1)
    expectRound(await rectsOf(page, SPARKLINE_DOT), `dashboard sparkline end dot @ ${width}`)
  })
}

for (const width of [1280, 390]) {
  test(`the analytics balance chart's point dots are round at ${width} (DSF 1)`, async ({
    page,
  }) => {
    await serveAnalyticsOverview(page)
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/analytics')
    await dismissMobileSidebar(page)
    await expect
      .poll(async () => (await rectsOf(page, PLOT_DOTS)).length)
      .toBeGreaterThanOrEqual(1)

    // Every base dot — one per point, all drawn by the same element shape.
    expectRound(await rectsOf(page, PLOT_DOTS), `analytics point dots @ ${width}`)

    // And the ACTIVE dot (radius × 1.6): caret to the last day and measure
    // again, so the enlarged state is round too, not just the resting one.
    // Scoped to the balance section — the page also renders the spend chart,
    // desktop and narrow halves both.
    await page
      .getByTestId('analytics-balance-section')
      .locator('[data-testid="chart-plot"] svg')
      .first()
      .focus()
    await page.keyboard.press('End')
    expectRound(
      await rectsOf(page, PLOT_DOTS),
      `analytics point dots incl. the active dot @ ${width}`,
    )
  })
}

for (const width of [1280, 390]) {
  for (const arm of [
    { name: 'a last value of 0', lastUsd: 0 },
    // Strictly the series maximum: every other day is ~1,225–1,261.
    { name: 'a last value of the maximum', lastUsd: 5000 },
  ]) {
    test(`the sparkline end dot stays inside its box for ${arm.name} at ${width}`, async ({
      page,
    }) => {
      await serveOverviewWithLastBalance(page, arm.lastUsd)
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/dashboard')
      await expect
      .poll(async () => (await rectsOf(page, SPARKLINE_DOT)).length)
      .toBeGreaterThanOrEqual(1)

      const dots = await rectsOf(page, SPARKLINE_DOT)
      const boxes = await rectsOf(page, SPARKLINE_BOX)
      expect(dots, `${arm.name} @ ${width}: no end dot rendered`).toHaveLength(1)
      expect(boxes, `${arm.name} @ ${width}: no sparkline box rendered`).toHaveLength(1)
      expectContained(dots[0], boxes[0], `${arm.name} @ ${width}`)
    })
  }
}
