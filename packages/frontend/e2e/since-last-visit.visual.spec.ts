/**
 * Visual regression for "Since your last visit" (#4709, epic #4701 decision 4):
 * the one line under the dashboard heading, above the 7-day sentence.
 *
 * The shared fixture answers a FIRST EVER visit (`previous: null`) and an empty
 * window, so no line renders and no existing dashboard baseline moves. This
 * spec overlays the two routes AFTER `mockHavenApi` (later routes win) with a
 * window that has something in it, asserts the exact sentence BEFORE the
 * capture — a locator that drifts is a red test rather than a baseline of the
 * wrong thing — and captures the header at both evidence viewports.
 *
 * The frozen clock is the same `2026-09-01T12:00Z` the other dashboard specs
 * use; the previous entry is 2026-08-31T09:00Z, which is "yesterday" in UTC and
 * in Europe/Stockholm alike, so the time word is stable wherever the browser
 * runs.
 *
 * Baselines are Linux-rendered by the "Update visual baselines" dispatch;
 * none are hand-made here.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: 'desktop' | 'mobile'; width: number; height: number }>

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 50,
  threshold: 0.02,
} as const

const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')
const PREVIOUS_ENTRY = '2026-08-31T09:00:00.000Z'
const CURRENT_ENTRY = '2026-09-01T12:00:00.000Z'

/** The sentence this fixture must produce — asserted before every capture. */
const EXPECTED_LINE = 'Since yesterday, Research agent made 3 payments for $4.20.'

/**
 * Overlay the visit entry and its figures. Registered AFTER `mockHavenApi`, so
 * these two routes win and everything else falls through to the shared fixture.
 */
async function serveSinceLastVisit(page: Page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'POST' && path === '/user/visits') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ previous: PREVIOUS_ENTRY, current: CURRENT_ENTRY }),
      })
      return
    }
    if (request.method() === 'GET' && path === '/dashboard/since') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          after: PREVIOUS_ENTRY,
          through: CURRENT_ENTRY,
          timeWord: 'Since yesterday',
          currency: 'USD',
          payments: 3,
          net: 4.2,
          agents: [{ id: 'agent-e2e', name: 'Research agent', netSpend: 4.2, payments: 3 }],
        }),
      })
      return
    }
    await route.fallback()
  })
}

async function expectNoSkeletons(region: Locator, label: string) {
  await expect(
    region.locator('.animate-pulse'),
    `${label}: still rendering skeleton placeholders — the capture would bake in ` +
      `a mid-load frame and then match it forever`,
  ).toHaveCount(0)
}

async function settleFonts(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForLoadState('networkidle')
}

test.describe('"Since your last visit" renders above the 7-day sentence (#4709)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  test.beforeEach(async ({ page }) => {
    // BEFORE `goto`: the page reads `Date.now()` during its first render.
    await page.clock.setFixedTime(FROZEN_NOW)
    await mockHavenApi(page)
    await serveSinceLastVisit(page)
    await seedAuthenticatedSession(page)
  })

  for (const vp of VIEWPORTS) {
    test(`/dashboard — the line sits above the 7-day sentence (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/dashboard')
      const main = page.locator('#main-content')
      await expect(main).toHaveCount(1)
      await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible({
        timeout: 60_000,
      })

      // The line, in the header's subtitle, ABOVE the 7-day sentence.
      const header = page.locator('header').first()
      await expect(header.getByText(EXPECTED_LINE)).toHaveCount(1)
      const subtitle = header.locator('p').first()
      const lines = await subtitle.locator('span.block').allTextContents()
      expect(lines[0]).toBe(EXPECTED_LINE)
      expect(lines[1]).toContain('in the last 7 days')

      await expectNoSkeletons(main, `${vp.name} dashboard`)
      await settleFonts(page)
      await expect(header).toHaveScreenshot(`since-last-visit-header-${vp.name}.png`, SNAPSHOT_OPTIONS)
    })
  }
})
