/**
 * Visual regression for the EditBudgetModal (#3398).
 *
 * One ELEMENT-SCOPED clip (the same scoping `marketplace.visual.spec.ts`
 * uses for its "Fund this merchant" modal clips and
 * `settings-accounting.visual.spec.ts` for its backfill dialog): the
 * modal's FORM step at the 390 px evidence viewport
 * (`scripts/evidence-viewports.mjs`, `-mobile.png` under
 * `chromium-desktop`). No visual spec covered this modal before #3398.
 *
 * What the clip pins: below `sm` the amount row stacks, and the token
 * symbol must stay INSIDE the amount input (the shared `BudgetAmountRow`
 * suffix) — no line holds only the token label, the orphan #3398 fixes.
 * The period select wraps to its own line; the merchant-locked read-only
 * row, hint text and footer buttons complete the step.
 *
 * NO dark baseline exists for this file: the `chromium-desktop-dark`
 * project's `testMatch` (playwright.config.ts) does not include it. A light
 * mobile capture is the whole dispatch.
 *
 * Route and fixtures: `/agents/agent-research` via `serveAgentDetailResponses`
 * (#2733) — the shared fixture falls through on the detail-page reads
 * otherwise. Its seeded ACTIVE delegation (250 USDC per week, recipient-pinned)
 * is the budget the card's Edit button opens; the modal resolves the token
 * symbol "USDC" through the chain registry union (the allowance's own address,
 * labelled from the registry by symbol), so the suffix renders without any
 * fixture change. The dialog carries no wall-clock text, but the clock is
 * frozen anyway — the page behind the dialog renders relative timestamps,
 * and a moving backdrop must never be able to race a capture.
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

/** The frozen clock: any fixed instant; the dialog itself shows no time. */
const FROZEN_NOW = new Date('2026-09-17T18:00:00.000Z')

/**
 * Open the agent's budget card and click its Edit affordance. The card's
 * Edit button names the budget it edits (`Edit budget 250 USDC per week`,
 * DelegationBudgetCard) — matched by prefix so a viem formatting nit in the
 * amount cannot rename the test's anchor out from under it.
 */
async function openEditBudgetModal(page: Page) {
  await page.goto('/agents/agent-research')
  await expect(page.getByRole('heading', { name: 'Research agent', exact: true })).toBeVisible({
    timeout: ANCHOR_TIMEOUT_MS,
  })
  await dismissMobileSidebar(page)

  const editButton = page.getByRole('button', { name: /^Edit budget / })
  await expect(editButton).toBeVisible()
  await editButton.click()
  const dialog = page.getByRole('dialog', { name: 'Edit budget' })
  await expect(dialog).toHaveCount(1)
  return dialog
}

test.describe('edit budget modal visual regression (#3398)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    // AFTER `mockHavenApi` — later-registered routes win (#2733).
    await serveAgentDetailResponses(page, 'agent-research')
    await seedAuthenticatedSession(page)
  })

  test('edit budget modal form step renders pixel-stable (mobile)', async ({ page }) => {
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.setViewportSize({ width: MOBILE!.width, height: MOBILE!.height })

    const dialog = await openEditBudgetModal(page)
    // The amount row: the input is prefilled with the budget's amount and the
    // token symbol rides INSIDE it as the suffix (`aria-hidden` — exactly one
    // exact-text "USDC" node in the dialog, the suffix; the intro sentence's
    // "250 USDC per week" is a different node and not an exact match).
    const amountInput = dialog.getByLabel('Budget amount')
    await expect(amountInput).toBeVisible()
    await expect(amountInput).toHaveValue('250')
    await expect(dialog.getByText('USDC', { exact: true })).toHaveCount(1)
    // The period select is the row's second control, labelled on its own.
    await expect(dialog.getByLabel('Period')).toHaveCount(1)
    // Prefilled = unchanged, so Review changes is offered disabled.
    await expect(dialog.getByRole('button', { name: 'Review changes' })).toBeDisabled()

    await page.evaluate(() => document.fonts.ready)
    await expect(dialog).toHaveScreenshot('agents-edit-budget-modal-mobile.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 50,
      threshold: PIXEL_THRESHOLD,
    })
  })
})
