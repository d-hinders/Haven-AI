/**
 * Visual regression for the budget card on a RETIRED agent (#3549).
 *
 * A revoked or removed (archived) agent can still hold an active budget —
 * the half-revoked state #3542 describes. Its budget card must offer nothing
 * that grants authority (no grant form, no Edit, no Issue sub-budget) and
 * keep the read-only row plus Stop, with a one-line reason where the form
 * was. These clips pin that card state.
 *
 * ELEMENT-SCOPED to the card's anchor (`#delegation-budget-card`), the same
 * scoping `edit-budget-modal.visual.spec.ts` uses, at the 390 px evidence
 * viewport (`scripts/evidence-viewports.mjs`). One clip, REVOKED: a revoked
 * agent still holding an active budget is reachable (`POST /revoke` flips
 * status only). Archived is not pictured: ARCHIVE_AGENT_SQL archives a
 * delegator-account agent only once it is revoked AND holds no live budget,
 * so "archived with an active row" cannot exist, and revoked+archived renders
 * the revoked copy (unit-tested). No dark baseline: the
 * `chromium-desktop-dark` project's `testMatch` (playwright.config.ts) does
 * not include this file.
 *
 * Route and fixtures: `/agents/agent-research` via `serveAgentDetailResponses`
 * with `agentOverrides` revoking the agent; its seeded ACTIVE delegation
 * (250 USDC per week, recipient-pinned) is the row the card still lists.
 * Clock frozen so the page around the card cannot race a capture.
 */
import { expect, test } from '@playwright/test'
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
const FROZEN_NOW = new Date('2026-09-17T18:00:00.000Z')

const STATES = [
  {
    name: 'revoked',
    overrides: { status: 'revoked' as const },
    reason: /This agent has been revoked, so its budgets can only be stopped/,
  },
]

test.describe('retired agent budget card visual regression (#3549)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  for (const state of STATES) {
    test(`${state.name} agent budget card renders pixel-stable (mobile)`, async ({ page }) => {
      await mockHavenApi(page)
      // AFTER `mockHavenApi` — later-registered routes win (#2733).
      await serveAgentDetailResponses(page, 'agent-research', { agentOverrides: state.overrides })
      await seedAuthenticatedSession(page)
      await page.clock.setFixedTime(FROZEN_NOW)
      await page.setViewportSize({ width: MOBILE!.width, height: MOBILE!.height })

      await page.goto('/agents/agent-research')
      await expect(page.getByRole('heading', { name: 'Research agent', exact: true })).toBeVisible({
        timeout: ANCHOR_TIMEOUT_MS,
      })
      await dismissMobileSidebar(page)

      const card = page.locator('#delegation-budget-card')
      await expect(card).toHaveCount(1)
      // The active budget is still listed, and Stop still ends it.
      await expect(card.getByText(/250 USDC per week/)).toBeVisible()
      // The row button's accessible name is its aria-label ("Stop budget 250
      // USDC per week"), so an exact-text match can never resolve; anchor on
      // the label prefix instead (CI #3721: toHaveCount received 0).
      await expect(card.getByRole('button', { name: /^Stop budget/ })).toHaveCount(1)
      // Nothing that grants authority.
      await expect(card.getByText(state.reason)).toBeVisible()
      await expect(card.getByRole('button', { name: 'Set budget' })).toHaveCount(0)
      // #3695: a live agent with a budget shows "Add budget", not "Set budget",
      // so "Set budget" absent alone no longer proves the retired gate.
      await expect(card.getByRole('button', { name: 'Add budget' })).toHaveCount(0)
      await expect(card.getByRole('button', { name: /^Edit budget / })).toHaveCount(0)
      await expect(card.getByRole('button', { name: 'Issue sub-budget' })).toHaveCount(0)
      await expect(card.getByLabel('Budget amount')).toHaveCount(0)

      await page.evaluate(() => document.fonts.ready)
      await expect(card).toHaveScreenshot(`agents-retired-budget-card-${state.name}-mobile.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: 50,
        threshold: PIXEL_THRESHOLD,
      })
    })
  }
})
