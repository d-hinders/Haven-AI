/**
 * Visual regression for the budget end date (#4350).
 *
 * Three ELEMENT-SCOPED clips at the 390 px evidence viewport
 * (`scripts/evidence-viewports.mjs`, `-mobile.png` under `chromium-desktop`),
 * the same scoping `edit-budget-modal.visual.spec.ts` uses:
 *
 * 1. The AGENT PAGE GRANT FORM with the end-date choice — the shared
 *    `BudgetEndDateSelect` with its resulting day, and the pre-sign helper
 *    naming the date.
 * 2. The EDIT modal's REVIEW step after choosing a new end — the old and new
 *    end dates side by side.
 * 3. The AGENT-PAGE CAPTION with its "ends <date>" segment — the row meter's
 *    caption names the end even when a refill comes first.
 *
 * NO dark baselines: the `chromium-desktop-dark` project's `testMatch`
 * (playwright.config.ts) does not include this file — a light mobile capture
 * is the whole dispatch, like the edit-budget spec.
 *
 * Route and fixtures: `/agents/agent-research` via `serveAgentDetailResponses`
 * (#2733). The clock is FROZEN before anything renders — the caption, the
 * select's date line and the helper copy all derive from `Date.now()`, and a
 * moving clock must never be able to race a capture (#3806's rule).
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  serveAgentDetailResponses,
} from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: string; width: number; height: number }>
const MOBILE = VIEWPORTS.find((vp) => vp.name === 'mobile')

/** The 390 px evidence viewport must exist — the capture is named after it. */
if (!MOBILE) {
  throw new Error('visual gate: evidence-viewports.mjs carries no "mobile" viewport')
}

const PIXEL_THRESHOLD = 0.02
const ANCHOR_TIMEOUT_MS = 60_000

/** The frozen clock: any fixed instant; every rendered date derives from it. */
const FROZEN_NOW = new Date('2026-09-17T18:00:00.000Z')

const SNAPSHOT = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  maxDiffPixels: 50,
  threshold: PIXEL_THRESHOLD,
}

async function openAgentPage(page: Page) {
  await page.goto('/agents/agent-research')
  await expect(page.getByRole('heading', { name: 'Research agent', exact: true })).toBeVisible({
    timeout: ANCHOR_TIMEOUT_MS,
  })
  await dismissMobileSidebar(page)
}

test.describe('budget end date visual regression (#4350)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    // AFTER `mockHavenApi` — later-registered routes win (#2733).
    await serveAgentDetailResponses(page, 'agent-research')
    await seedAuthenticatedSession(page)
  })

  test('the grant form with the end-date choice renders pixel-stable (mobile)', async ({ page }) => {
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.setViewportSize({ width: MOBILE!.width, height: MOBILE!.height })
    await openAgentPage(page)

    // #4261: with a budget listed, the form opens from a row's ⋯ menu —
    // "Add budget". The shared end-date control rides inside it.
    await page.getByRole('button', { name: /^Budget options/ }).first().click()
    await page.getByRole('menuitem', { name: 'Add budget' }).click()
    const form = page.getByRole('button', { name: 'Set budget' }).locator('../../..')
    await expect(form.getByLabel('Ends — how long the budget lasts')).toBeVisible()
    await expect(form.getByTestId('budget-end-date')).toBeVisible()

    await page.evaluate(() => document.fonts.ready)
    const section = page.locator('section[aria-label="Budgets"]')
    await expect(section).toHaveScreenshot('agents-budget-grant-form-end-date-mobile.png', SNAPSHOT)
  })

  test('the edit review with an end-date change renders pixel-stable (mobile)', async ({ page }) => {
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.setViewportSize({ width: MOBILE!.width, height: MOBILE!.height })
    await openAgentPage(page)

    await page.getByRole('button', { name: /^Budget options/ }).first().click()
    await page.getByRole('menuitem', { name: 'Edit budget' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit budget' })
    await expect(dialog).toHaveCount(1)
    // The renewal: same terms, a new end — 180 days. The review then shows
    // the old and the new end date side by side.
    await dialog.getByLabel('Ends — how long the budget lasts').selectOption('180')
    await dialog.getByRole('button', { name: 'Review changes' }).click()
    const afterBlock = dialog.getByText(/After you approve/).locator('..')
    await expect(afterBlock).toBeVisible()
    await expect(afterBlock).toContainText('· ends ')

    await page.evaluate(() => document.fonts.ready)
    await expect(dialog).toHaveScreenshot('agents-edit-budget-review-end-date-mobile.png', SNAPSHOT)
  })

  test('the agent-page caption names the end date, pixel-stable (mobile)', async ({ page }) => {
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.setViewportSize({ width: MOBILE!.width, height: MOBILE!.height })
    await openAgentPage(page)

    // The shared fixture's researched agent answers its delegations read
    // WITHOUT the remaining-this-period fields, so its row renders no meter
    // (and no caption) at all. A LATER-registered route (later routes win,
    // #2733) answers THIS capture only, with the same row plus the remaining
    // fields — a mid-period read whose period_end is ahead of the frozen
    // clock keeps the meter kind. No other baseline may move for a fixture
    // the whole suite shares, so the shared fixture is left untouched.
    await page.route('**/api/agents/agent-research/delegations*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          delegations: [
            {
              id: 'dlg-e2e-1',
              chain_id: 84532,
              token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              recipient_address: '0x000000000000000000000000000000000000dEaD',
              delegation_hash: `0x${'4d'.repeat(32)}`,
              version: 1,
              status: 'active',
              is_live: true,
              budget_atomic: '250000000',
              period_seconds: 604_800,
              start_date: '1780394400',
              expires_at: Math.floor(Date.UTC(2027, 5, 2) / 1000),
              created_at: '2026-06-02T10:00:00.000Z',
              // A mid-period read: the budget mostly intact, refilling after
              // the frozen clock's current period ends.
              remaining_atomic: '200000000',
              remaining_from_chain: true,
              period_end: '2026-09-21T10:00:00.000Z',
            },
          ],
        },
      })
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Research agent', exact: true })).toBeVisible({
      timeout: ANCHOR_TIMEOUT_MS,
    })

    // The first budget row's caption line: refill wording plus the absolute
    // "ends <date>" segment (#4350). Clip the ROW, not the whole section, so
    // the capture pins the caption alone — the row is the flex container that
    // holds this budget's meter.
    const row = page
      .locator('div.flex.items-start.justify-between')
      .filter({ has: page.getByRole('progressbar', { name: 'USDC budget used' }) })
      .first()
    await expect(row).toBeVisible()
    await expect(row).toContainText('ends ')

    await page.evaluate(() => document.fonts.ready)
    await expect(row).toHaveScreenshot('agents-budget-caption-ends-mobile.png', SNAPSHOT)
  })
})
