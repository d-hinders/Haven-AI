/**
 * A move between two of the user's own accounts in the dashboard's Activity
 * card (#4268): ONE row, "Moved between your accounts", the neutral two-way
 * mark, "<from> → <to>" drawn by the shared `TransactionMovement`, and an
 * unsigned amount.
 *
 * A route override, not the shared default fixture: adding a group to
 * `dashboardOverview.activity` would move every dashboard baseline that
 * photographs the card (`dashboard-*`, `currency-sek-dashboard-*`,
 * `balance-freshness-dashboard-desktop`, `first-run-set-up-*`). Here the
 * override serves exactly one folded group, and the capture is clipped to
 * the card, so nothing else on the page can drift this baseline.
 *
 * The group's amount is its OWN (`approxAmount` below): the shared fixture's
 * `withServedApprox` re-prices every default group to 12.5, and this override
 * bypasses it, so the row shows what the group carries.
 *
 * The clock is frozen and the zone and locale are pinned, and the relative
 * time is ASSERTED, not assumed: the row renders `timeAgo(latestAt)`, and a
 * capture taken against the real clock flips the day it is photographed on
 * (the `agent-panel-states` failure #4275 fixed).
 *
 * BASELINES ARE LINUX-RENDERED: compared only under `VISUAL_REGRESSION=1`.
 * `VISUAL_STRUCTURE_ONLY=1` runs every assertion here without the pixels.
 * Regenerate through the *Update visual baselines* dispatch, naming the
 * baselines in `expected` (docs/contributing/ship-playbooks/frontend.md §4).
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { dashboardOverview, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
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

/** The same frozen clock the other dashboard visual specs use. */
const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')
/** Two hours before the frozen clock: `timeAgo` must read exactly "2h ago". */
const LATEST_AT = new Date(FROZEN_NOW.getTime() - 2 * 60 * 60 * 1000).toISOString()

/** One folded move, as `GET /dashboard/overview` serves it (#4268). */
const MOVE_GROUP = {
  count: 1,
  sumAtomic: '25000000',
  tokenSymbol: 'USDC',
  decimals: 6,
  latestAt: LATEST_AT,
  agentId: null,
  agentName: null,
  source: null,
  x402ResourceUrl: null,
  to: '0x2222222222222222222222222222222222222222',
  // An unfolded send would carry these; a folded one keeps them (#4268 § Wire).
  merchantName: 'Reserve',
  fromAccountName: 'Operations',
  ownTransfer: { fromAccountName: 'Operations', toAccountName: 'Reserve' },
  activityType: null,
  direction: 'out',
  status: 'confirmed',
  approxAmount: '25.0000',
  approxCurrency: 'USD',
} as const

async function serveOneMove(page: Page) {
  await page.route('**/api/dashboard/overview*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...dashboardOverview, activity: [MOVE_GROUP] }),
    })
  })
}

test.describe('the dashboard Activity card shows an own-account move as one row (#4268)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)
  test.use({ timezoneId: 'UTC', locale: 'en-US' })

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}: one move row, Operations → Reserve, unsigned`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      // BEFORE `goto`: the page reads `Date.now()` during its first render.
      await page.clock.setFixedTime(FROZEN_NOW)
      await mockHavenApi(page)
      await serveOneMove(page)
      await seedAuthenticatedSession(page)

      await page.goto('/dashboard')
      const card = page.getByTestId('dashboard-activity')
      await expect(card.getByText('Moved between your accounts')).toBeVisible({ timeout: 60_000 })

      // The frozen clock is in effect: a clock that stopped working fails here
      // by name instead of as a pixel diff weeks from now.
      await expect(card.getByText('2h ago'), 'the frozen clock is not in effect').toBeVisible()
      // One row, the movement line, and no "From <account>" subtitle.
      await expect(card.getByText('Moved between your accounts')).toHaveCount(1)
      await expect(card.getByText('Operations', { exact: true })).toBeVisible()
      await expect(card.getByText('Reserve', { exact: true })).toBeVisible()
      await expect(card.getByText(/^From /)).toHaveCount(0)
      // The group's own amount (not the shared fixture's 12.5 re-price), unsigned.
      const amount = card.locator('.v2-tabular').first()
      await expect(amount).toContainText('25.00')
      await expect(amount).not.toHaveText(/^[-+−]/)

      // The arrow sits on the line of the names it joins (#1774): bound to
      // them, never stranded on a line of its own.
      const arrow = card.getByText('→', { exact: true })
      const arrowBox = await arrow.boundingBox()
      const toBox = await card.getByText('Reserve', { exact: true }).boundingBox()
      expect(arrowBox, 'the movement arrow did not render').not.toBeNull()
      expect(toBox).not.toBeNull()
      expect(Math.abs((arrowBox!.y + arrowBox!.height / 2) - (toBox!.y + toBox!.height / 2))).toBeLessThan(4)

      await expect(card.locator('.animate-pulse')).toHaveCount(0)
      await page.evaluate(() => document.fonts.ready)
      await expect(card).toHaveScreenshot(`dashboard-activity-own-transfer-${viewport.name}.png`, SNAPSHOT_OPTIONS)
    })
  }

  test('375px: the movement line keeps its arrow beside the names', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.clock.setFixedTime(FROZEN_NOW)
    await mockHavenApi(page)
    await serveOneMove(page)
    await seedAuthenticatedSession(page)

    await page.goto('/dashboard')
    const card = page.getByTestId('dashboard-activity')
    await expect(card.getByText('Moved between your accounts')).toBeVisible({ timeout: 60_000 })
    const arrowBox = await card.getByText('→', { exact: true }).boundingBox()
    const fromBox = await card.getByText('Operations', { exact: true }).boundingBox()
    const toBox = await card.getByText('Reserve', { exact: true }).boundingBox()
    expect(arrowBox && fromBox && toBox, 'the movement line did not render').toBeTruthy()
    const mid = (b: { y: number; height: number }) => b.y + b.height / 2
    expect(Math.abs(mid(arrowBox!) - mid(fromBox!))).toBeLessThan(4)
    expect(Math.abs(mid(arrowBox!) - mid(toBox!))).toBeLessThan(4)
  })
})
