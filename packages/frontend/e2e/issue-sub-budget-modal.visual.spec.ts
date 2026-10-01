/**
 * Visual regression for the "Issue sub-budget" modal (#3506).
 *
 * Three states, each an ELEMENT-SCOPED clip of the modal PANEL
 * (`data-testid="issue-sub-budget-modal"` — the `role="dialog"` wrapper is the
 * whole viewport) at both shared evidence viewports:
 *
 *  - `empty`    — the untouched form: the parent budget as the ceiling, the
 *                 agent picker, amount, end date, recipient, label.
 *  - `refusal`  — the API refuses a slice wider than the parent budget
 *                 (`sub_budget_wider_than_parent` / `amount`); the form stays
 *                 and the plain-words sentence shows.
 *  - `pending`  — the 201: the sub-budget is PENDING until the sharing agent
 *                 signs, and the copy says what to tell it.
 *
 * Route: `/agents/agent-research` via `serveAgentDetailResponses` (#2733); its
 * seeded ACTIVE budget (250 USDC per week, until 2027-06-02) is the parent.
 * The POST is answered here, AFTER the shared fixtures (later routes win).
 * The clock is frozen so the ceiling/min-date text cannot drift.
 *
 * Baselines are Linux-rendered by the dispatch workflow — none are committed
 * from a developer machine. No dark baseline: this file is deliberately not in
 * `chromium-desktop-dark`'s `testMatch`.
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

const PIXEL_THRESHOLD = 0.02
const ANCHOR_TIMEOUT_MS = 60_000
const FROZEN_NOW = new Date('2026-09-17T18:00:00.000Z')
const AGENT_ID = 'agent-research'
const OTHER_AGENT_ID = 'agent-e2e'

type Outcome = 'refusal' | 'created'

/** Answer the issue POST — AFTER the shared fixtures so this registration wins. */
async function serveIssueResponse(page: Page, outcome: Outcome) {
  await page.route(`**/api/agents/${AGENT_ID}/sub-budgets`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    if (outcome === 'refusal') {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'The requested period amount exceeds the parent budget delegation period amount',
          error_code: 'sub_budget_wider_than_parent',
          reason: 'amount',
        }),
      })
    }
    const row = (id: string, agentId: string) => ({
      id,
      agent_id: agentId,
      status: 'pending',
      period_amount_atomic: '25000000',
      // 2027-01-15 end of day, UTC — what the form asked for.
      expires_at: 1800057599,
    })
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        sub_budget: row('sb-grant', OTHER_AGENT_ID),
        parent_child_sub_budget: row('sb-parent-child', AGENT_ID),
        next_action: 'agent_signs_then_submits',
        sign_targets: [
          { sub_budget_id: 'sb-parent-child', who: 'delegating_agent', what: 'parent-child' },
          { sub_budget_id: 'sb-grant', who: 'delegating_agent', what: 'grant' },
        ],
      }),
    })
  })
}

async function openModal(page: Page) {
  await page.goto(`/agents/${AGENT_ID}`)
  await expect(page.getByRole('heading', { name: 'Research agent', exact: true })).toBeVisible({
    timeout: ANCHOR_TIMEOUT_MS,
  })
  await dismissMobileSidebar(page)
  const entry = page.getByRole('button', { name: 'Issue sub-budget', exact: true })
  await expect(entry).toBeVisible()
  await entry.click()
  const dialog = page.getByRole('dialog', { name: 'Issue sub-budget' })
  await expect(dialog).toHaveCount(1)
  const panel = page.getByTestId('issue-sub-budget-modal')
  await expect(panel).toHaveCount(1)
  return { dialog, panel }
}

// The refusal enters more than the 250 USDC per week ceiling, so the
// "more than … allows" copy matches what the form shows (#3506 design review).
async function fillForm(page: Page, amount = '25') {
  const dialog = page.getByRole('dialog', { name: 'Issue sub-budget' })
  await dialog.getByLabel('Agent to share with').selectOption(OTHER_AGENT_ID)
  await dialog.getByLabel('Sub-budget amount').fill(amount)
  await dialog.getByLabel('Ends on').fill('2027-01-15')
  await dialog.getByLabel('Label').fill('Weekly research')
}

async function capture(page: Page, panel: ReturnType<Page['getByTestId']>, name: string) {
  await page.evaluate(() => document.fonts.ready)
  await expect(panel).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixels: 50,
    threshold: PIXEL_THRESHOLD,
  })
}

test.describe('issue sub-budget modal visual regression (#3506)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  for (const vp of VIEWPORTS) {
    test.describe(vp.name, () => {
      test.beforeEach(async ({ page }) => {
        await mockHavenApi(page)
        // AFTER `mockHavenApi` — later-registered routes win (#2733).
        await serveAgentDetailResponses(page, AGENT_ID, { otherAgentName: 'Booking agent' })
        await seedAuthenticatedSession(page)
        await page.clock.setFixedTime(FROZEN_NOW)
        await page.setViewportSize({ width: vp.width, height: vp.height })
      })

      test('empty form', async ({ page }) => {
        const { dialog, panel } = await openModal(page)
        await expect(dialog.getByTestId('sub-budget-ceiling')).toContainText('250 USDC per week')
        await capture(page, panel, `agents-issue-sub-budget-empty-${vp.name}.png`)
      })

      test('refusal: wider than the parent budget', async ({ page }) => {
        await serveIssueResponse(page, 'refusal')
        const { dialog, panel } = await openModal(page)
        await fillForm(page, '300')
        await dialog.getByRole('button', { name: 'Issue sub-budget', exact: true }).click()
        await expect(dialog.getByRole('alert')).toContainText('more than')
        await capture(page, panel, `agents-issue-sub-budget-refusal-${vp.name}.png`)
      })

      test('success: pending until the agent signs', async ({ page }) => {
        await serveIssueResponse(page, 'created')
        const { dialog, panel } = await openModal(page)
        await fillForm(page)
        await dialog.getByRole('button', { name: 'Issue sub-budget', exact: true }).click()
        await expect(dialog.getByTestId('sub-budget-pending')).toBeVisible()
        await capture(page, panel, `agents-issue-sub-budget-pending-${vp.name}.png`)
      })
    })
  }
})
