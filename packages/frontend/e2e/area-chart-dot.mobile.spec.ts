/**
 * `ui/AreaChart` dot geometry at the phone's own rendering (#3903).
 *
 * The desktop twin (`area-chart-dot-measure.spec.ts`) measures its 390 arm at
 * DSF 1; this spec is the arm that runs under device emulation — Pixel 5,
 * 393 × 727, deviceScaleFactor 2.75 — where the app actually renders on a
 * phone. The dot's roundness is a LAYOUT property (it must not depend on the
 * device pixel ratio), so the same 0.25 px bound holds here; measuring at
 * DSF 2.75 proves it survives subpixel snapping.
 *
 * The same combined selectors as the desktop spec: the probe is the dot
 * element under both implementations (svg `<circle>` before #3903, HTML span
 * after), and the spec fails on the pre-fix oval at this width too.
 */
import { expect, test, type Page } from '@playwright/test'
import { dashboardOverview, dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
import { analyticsOverview } from './fixtures/analytics-overview'

const ROUNDNESS_TOLERANCE_PX = 0.25

const SPARKLINE_DOT =
  '[data-testid="area-chart-sparkline"] circle, [data-testid="area-chart-sparkline-dot"]'
const SPARKLINE_BOX = '[data-testid="area-chart-sparkline"]'
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
  expect(rects.length, `${label}: no dot was rendered to measure`).toBeGreaterThanOrEqual(1)
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

async function serveOverviewWithLastBalance(page: Page, lastUsd: number) {
  const body = JSON.parse(JSON.stringify(dashboardOverview)) as typeof dashboardOverview
  body.spend.balance_by_day[body.spend.balance_by_day.length - 1].totalUsd = lastUsd
  await page.route('**/api/dashboard/overview*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  )
}

test.beforeEach(async ({ page }) => {
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
})

test('the dashboard money card sparkline end dot is round and contained at the phone width (DSF 2.75)', async ({
  page,
}) => {
  await page.goto('/dashboard')
  await expect
      .poll(async () => (await rectsOf(page, SPARKLINE_DOT)).length)
      .toBeGreaterThanOrEqual(1)
  const dots = await rectsOf(page, SPARKLINE_DOT)
  const boxes = await rectsOf(page, SPARKLINE_BOX)
  expectRound(dots, 'dashboard sparkline end dot @ Pixel 5')
  expect(dots, 'no end dot rendered').toHaveLength(1)
  expect(boxes, 'no sparkline box rendered').toHaveLength(1)
  expectContained(dots[0], boxes[0], 'dashboard sparkline end dot @ Pixel 5')
})

test('the analytics balance chart point dots are round at the phone width (DSF 2.75)', async ({
  page,
}) => {
  // Trailing `*`: the read carries a query string, and a glob must match the
  // whole URL.
  await page.route('**/api/analytics/overview*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(analyticsOverview),
    }),
  )
  await page.goto('/analytics')
  await dismissMobileSidebar(page)
  await expect
      .poll(async () => (await rectsOf(page, PLOT_DOTS)).length)
      .toBeGreaterThanOrEqual(1)
  expectRound(await rectsOf(page, PLOT_DOTS), 'analytics point dots @ Pixel 5')
  await page
    .getByTestId('analytics-balance-section')
    .locator('[data-testid="chart-plot"] svg')
    .first()
    .focus()
  await page.keyboard.press('End')
  expectRound(
    await rectsOf(page, PLOT_DOTS),
    'analytics point dots incl. the active dot @ Pixel 5',
  )
})

test('the sparkline end dot stays inside its box for a last value of 0 at the phone width (DSF 2.75)', async ({
  page,
}) => {
  await serveOverviewWithLastBalance(page, 0)
  await page.goto('/dashboard')
  await expect
      .poll(async () => (await rectsOf(page, SPARKLINE_DOT)).length)
      .toBeGreaterThanOrEqual(1)
  const dots = await rectsOf(page, SPARKLINE_DOT)
  const boxes = await rectsOf(page, SPARKLINE_BOX)
  expect(dots, 'no end dot rendered').toHaveLength(1)
  expect(boxes, 'no sparkline box rendered').toHaveLength(1)
  expectContained(dots[0], boxes[0], 'last value 0 @ Pixel 5')
})
