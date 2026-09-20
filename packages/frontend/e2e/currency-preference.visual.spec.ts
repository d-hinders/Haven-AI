/**
 * Visual regression for the SEK display currency (#3127 review round 2,
 * finding 8): the served default (SEK, migration 091) actually rendering.
 *
 * Before this file NOTHING rendered SEK: the shared e2e fixture pinned
 * `currency_preference: 'USD'`, no fixture carried a `sek`/`totalSek`/
 * `sekValue` key, and the Settings Preferences card and `/accounts/[id]` had
 * no pixel baseline at all. The green visual-regression and browser-smoke
 * ticks were statements about the unchanged USD render — the exact
 * "green tick read wider than the thing it measured" defect #2318 is about.
 *
 * The session here is the fixture's `testUserSek` (same id, same account,
 * only the preference differs), served by re-routing `GET /auth/me` per
 * suite (`serveSekUser`), registered AFTER `mockHavenApi` so later routes
 * win. Each test asserts the state's own distinguishing SEK copy BEFORE the
 * capture — a locator that drifts is a red test rather than a baseline of
 * the wrong thing — and the dashboard test additionally pins the frozen-clock
 * literal (`3mo ago`), because the recent-transactions row renders through
 * `timeAgo` and an unfrozen baseline here would drift on a calendar boundary
 * exactly like the ones #2318 rejected.
 *
 * Baselines are Linux-rendered by the "Update visual baselines" dispatch;
 * none are hand-made here. Desktop only, deliberately: the finding asks for
 * the surfaces, and every committed baseline is re-blessed forever (#1944).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  mockHavenApi,
  seedAuthenticatedSession,
  serveSekUser,
} from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: 'desktop' | 'mobile'; width: number; height: number }>
const DESKTOP = VIEWPORTS.find((vp) => vp.name === 'desktop')

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 50,
  threshold: 0.02,
} as const

/**
 * The instant the SEK captures render at — the SAME frozen clock
 * `product-routes.visual.spec.ts` uses, chosen just after the fixture
 * timestamps so relative times render in their ordinary months-ago form.
 */
const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')

/**
 * The capture would bake a mid-load frame into the baseline and then match it
 * forever. Same guard `product-routes.visual.spec.ts` runs before its capture.
 */
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

test.describe('currency preference renders SEK (#3127 finding 8)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  test.beforeEach(async ({ page }) => {
    if (!DESKTOP) {
      throw new Error('visual gate: evidence-viewports.mjs carries no "desktop" viewport')
    }
    await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height })
    // BEFORE `goto`: the page reads `Date.now()` during its first render.
    await page.clock.setFixedTime(FROZEN_NOW)
    await mockHavenApi(page)
    // Later routes win: `/auth/me` now answers the SEK user, everything else
    // keeps falling through to the shared fixture.
    await serveSekUser(page)
    await seedAuthenticatedSession(page)
  })

  test('/dashboard — the SEK hero, its change line, and the spend tile', async ({ page }) => {
    await page.goto('/dashboard')
    const main = page.locator('#main-content')
    await expect(main).toHaveCount(1)
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible({ timeout: 60_000 })

    // The hero total is the SEK figure the overview fixture serves
    // (`totals.sek: 13450`), in the sv-SE voice — NOT a USD total wearing a
    // SEK label, and NOT `0,00 kr` (the pre-finding-8 render: no fixture key
    // at all, the hook's `?? 0` answered).
    await expect(main.getByText('13 450,00 kr')).toHaveCount(1)
    // The change line renders the fixture's SEK swing, not the quiet caption
    // — the exact render the PR body must describe (round-2 finding). The
    // percent keeps `formatPercent`'s plain `toFixed` decimal point (the
    // dashboard unit test pins the same mixed voice).
    await expect(main.getByText('+30,00 kr (+0.20%) today')).toHaveCount(1)
    await expect(main.getByText('Across all linked Haven accounts.')).toHaveCount(0)
    // The "Monthly agent spend" tile reads the SEK metric.
    await expect(main.getByText('133,00 kr')).toHaveCount(1)
    // The frozen clock is in effect — the transactions row renders its
    // literal, so the baseline cannot drift on a calendar boundary.
    await expect(main.getByText('3mo ago', { exact: true }).first()).toBeVisible()

    await expectNoSkeletons(main, '/dashboard (SEK)')
    await settleFonts(page)
    await expect(page).toHaveScreenshot('currency-sek-dashboard-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('/settings — the Preferences card with the kr SEK radio active', async ({ page }) => {
    await page.goto('/settings')
    await page.evaluate(() => document.fonts.ready)
    await expect(page.locator('button[aria-label="User menu"]')).toHaveCount(1)
    const heading = page.getByRole('heading', { name: 'Preferences', exact: true })
    const card = page.locator('section', { has: heading })
    await expect(card).toHaveCount(1)

    // The state the capture is OF: SEK selected. Never had a baseline — the
    // green ticks said nothing about this card.
    const currency = card.getByRole('radiogroup', { name: 'Preferred currency' })
    await expect(currency.getByRole('radio', { name: 'kr SEK' })).toHaveAttribute('aria-checked', 'true')
    await expect(currency.getByRole('radio', { name: '$ USD' })).toHaveAttribute('aria-checked', 'false')
    await expect(currency.getByRole('radio', { name: '€ EUR' })).toHaveAttribute('aria-checked', 'false')

    await expectNoSkeletons(card, '/settings Preferences (SEK)')
    await settleFonts(page)
    await expect(card).toHaveScreenshot('currency-sek-settings-preferences-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('/accounts/safe-main — the account priced in SEK', async ({ page }) => {
    await page.goto('/accounts/safe-main')
    const main = page.locator('#main-content')
    await expect(main).toHaveCount(1)
    await expect(page.getByRole('heading', { name: 'Operations', exact: true })).toBeVisible({ timeout: 60_000 })

    // The headline and the token row both price from the portfolio fixture's
    // SEK figures (`totalSek`/`sekValue: 13450`), never a USD value relabelled.
    await expect(main.getByText('13 450,00 kr')).toHaveCount(2)
    await expect(main.getByText('Value (SEK)')).toHaveCount(1)

    await expectNoSkeletons(main, '/accounts/[id] (SEK)')
    await settleFonts(page)
    await expect(page).toHaveScreenshot('currency-sek-account-detail-desktop.png', SNAPSHOT_OPTIONS)
  })
})
