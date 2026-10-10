/**
 * Visual regression for the first-run guide (#3818): the four states the
 * issue names — no funds, funded, an agent waiting for setup, set up — each
 * as an ELEMENT-SCOPED clip of the card the guide lives in (the Needs you
 * card, titled "Get started" while setup is in progress). Element-scoped so
 * the money panel's figures and the page around it cannot leak into a clip;
 * the full-page dashboard baselines in `product-routes.visual.spec.ts` carry
 * the finished state in context.
 *
 * States come from `support/first-run-states.ts`, the same overlays the
 * behaviour spec `first-run-guide.spec.ts` walks. The operation gate resolves
 * `ready` on the shared fixtures (the signer-set handler answers a passkey),
 * so the guide renders — `passkey_on_other_device` is the one gate that hides
 * it.
 *
 * Captured at desktop and 390 mobile, light. Baselines are Linux-rendered by
 * the *Update visual baselines* dispatch with `expected=` naming the eight
 * clips; none are hand-made. Kept to `toHaveScreenshot` plus structural waits
 * (`update-visual-baselines.yml` aborts on any other failed assertion).
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
import { serveFirstRunOverview, type FirstRunState } from './support/first-run-states'
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

const STATES: ReadonlyArray<{ state: FirstRunState; anchor: RegExp }> = [
  { state: 'no-funds', anchor: /Add USDC to your account/ },
  { state: 'funded', anchor: /Funded — your agents can spend\./ },
  { state: 'agent-needs-setup', anchor: /Finish setting up Connecting agent/ },
  { state: 'set-up', anchor: /You’re set up/ },
]

function card(page: Page) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name: /^(Get started|Needs you)$/ }) })
}

test.describe('first-run guide states (#3818)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  for (const vp of VIEWPORTS) {
    for (const { state, anchor } of STATES) {
      test(`${state} — ${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height })
        await page.clock.setFixedTime(FROZEN_NOW)
        await mockHavenApi(page)
        await serveFirstRunOverview(page, () => state)
        await seedAuthenticatedSession(page)

        await page.goto('/dashboard')
        await dismissMobileSidebar(page)
        const region = card(page)
        await expect(region.getByText(anchor)).toBeVisible({ timeout: 60_000 })
        await expect(region.locator('.animate-pulse')).toHaveCount(0)
        await page.evaluate(() => document.fonts.ready)
        await page.waitForLoadState('networkidle')
        await expect(region).toHaveScreenshot(`first-run-${state}-${vp.name}.png`, SNAPSHOT_OPTIONS)
      })
    }
  }
})
