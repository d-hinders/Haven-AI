/**
 * Visual regression for the agent page's no-budget Set budget flow (#4602).
 *
 * Two layout regressions reached `dev` with every check green and only a
 * human design review caught them (PR #4600, epic #4560): the Set budget
 * dialog's Cancel shrank to its label beside a full-width primary, and the
 * Spending card's "No budget yet." sat centred above a left-aligned Set
 * budget button. Neither surface had a desktop baseline — the dialog had only
 * the stacked mobile one (`budget-end-dates.visual.spec.ts`), and no spec
 * rendered the no-budget card at any width. These two clips pin both:
 *
 * 1. The no-budget SPENDING CARD — `EmptyState align="start"`
 *    (`DelegationBudgetCard`), the line on the button's left edge.
 * 2. The SET BUDGET DIALOG PANEL opened from it, titled "Set its first
 *    budget" — the `sm`+ equal split `DialogActions` owns.
 *
 * One `test()` per baseline: two `toHaveScreenshot` calls in one test
 * short-circuit at the first failure (frontend playbook § Visual regression).
 * Desktop (1280 px, `scripts/evidence-viewports.mjs`) because the regressions
 * are `sm`+ only — below `sm` the action pair stacks. NO dark baselines: the
 * `chromium-desktop-dark` project's `testMatch` (playwright.config.ts) does
 * not include this file.
 *
 * Route and fixtures: `/agents/agent-research` via `serveAgentDetailResponses`
 * with its opt-in `noBudget` (no delegation, so no allowances) — the helper's
 * default stays the budgeted agent every other baseline renders. The clock is
 * frozen: the section's "Last 30 days" is time-relative.
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { hidePageBehindModal } from './support/hide-page-behind-modal'
import { mockHavenApi, seedAuthenticatedSession, serveAgentDetailResponses } from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: string; width: number; height: number }>
const DESKTOP = VIEWPORTS.find((vp) => vp.name === 'desktop')

/** The 1280 px evidence viewport must exist — the captures are named after it. */
if (!DESKTOP) {
  throw new Error('visual gate: evidence-viewports.mjs carries no "desktop" viewport')
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

/** Open the agent page and assert the card is in its no-budget state. */
async function openNoBudgetCard(page: Page) {
  await page.clock.setFixedTime(FROZEN_NOW)
  await page.setViewportSize({ width: DESKTOP!.width, height: DESKTOP!.height })
  await page.goto('/agents/agent-research')
  await expect(page.getByRole('heading', { name: 'Research agent', exact: true })).toBeVisible({
    timeout: ANCHOR_TIMEOUT_MS,
  })

  // State before pixels: the no-budget line and its button, and no budget
  // row — a row's ⋯ trigger would mean the fixture served a budget.
  const card = page.locator('#delegation-budget-card')
  await expect(card).toHaveCount(1)
  await expect(card.getByText('No budget yet.')).toBeVisible()
  await expect(card.getByRole('button', { name: /^Budget options/ })).toHaveCount(0)
  const setBudget = card.getByRole('button', { name: 'Set budget' })
  await expect(setBudget).toHaveCount(1)
  return { card, setBudget }
}

test.describe('no-budget Set budget flow visual regression (#4602)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    // AFTER `mockHavenApi` — later-registered routes win (#2733).
    await serveAgentDetailResponses(page, 'agent-research', { noBudget: true })
    await seedAuthenticatedSession(page)
  })

  test('the no-budget Spending card renders pixel-stable (desktop)', async ({ page }) => {
    const { card } = await openNoBudgetCard(page)

    await page.evaluate(() => document.fonts.ready)
    await expect(card).toHaveScreenshot('agents-no-budget-card-desktop.png', SNAPSHOT)
  })

  test('the first Set budget dialog renders pixel-stable (desktop)', async ({ page }) => {
    const { setBudget } = await openNoBudgetCard(page)
    await setBudget.click()

    const dialog = page.getByRole('dialog', { name: 'Set its first budget' })
    await expect(dialog).toHaveCount(1)
    // #4564: clip the PANEL (`panelTestId`), never `getByRole('dialog')` —
    // that wrapper is `fixed inset-0` and would screenshot the page behind it.
    // The panel mounts inside the card's section, so the card's own Set
    // budget button is a second match outside it: scope to the panel.
    const panel = page.getByTestId('set-budget-dialog')
    await expect(panel).toHaveCount(1)
    await expect(panel.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Set budget' })).toBeVisible()
    // The click leaves the pointer over the panel; a hover fill is not in the
    // blessed pixels (the artifact `issue-sub-budget-modal.visual.spec.ts`
    // measured from exactly this click).
    await page.mouse.move(0, 0)

    await page.evaluate(() => document.fonts.ready)
    await hidePageBehindModal(panel)
    await expect(panel).toHaveScreenshot('agents-set-budget-first-dialog-desktop.png', SNAPSHOT)
  })
})
