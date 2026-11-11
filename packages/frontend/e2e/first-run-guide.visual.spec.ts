/**
 * Visual regression for the first-run guide (#3818): the four states the
 * issue names — no funds, funded, an agent waiting for setup, set up — each
 * as an ELEMENT-SCOPED clip of the card the state lives in. Element-scoped so
 * the money panel's figures and the page around it cannot leak into a clip;
 * the full-page dashboard baselines in `product-routes.visual.spec.ts` carry
 * the finished state in context.
 *
 * #4707: the finished state's surface is no longer the Needs attention card.
 * The first agent payment gets its OWN card, so `set-up` clips THAT card —
 * found by its own heading, never by widening the Needs attention selector.
 * The other three states still clip the Needs attention card (titled "Get
 * started" while setup is in progress).
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
  // 0.01, not 0.02 (#3910 design review): at 0.02 pixelmatch tolerates a
  // YIQ delta of ~14, and the card's old `anchor` tint vs the flat page
  // surface is ~8.5 — every body pixel "matched", so the crops could not tell
  // the old card from the new one and `mode=changed` never refreshed them.
  // 0.01 (~3.5) catches a surface change; `maxDiffPixels` absorbs antialiasing.
  threshold: 0.01,
} as const

/** The same frozen clock the other dashboard visual specs use. */
const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')

/**
 * `region` names WHICH card the state lives in. `set-up` is the milestone card
 * (#4707); the rest are the Needs attention card.
 */
const STATES: ReadonlyArray<{
  state: FirstRunState
  anchor: RegExp
  region: 'needs-attention' | 'milestone'
}> = [
  { state: 'no-funds', anchor: /Add USDC to your account/, region: 'needs-attention' },
  { state: 'funded', anchor: /Your account holds USDC\./, region: 'needs-attention' },
  { state: 'agent-needs-setup', anchor: /Finish setting up Connecting agent/, region: 'needs-attention' },
  { state: 'set-up', anchor: /made its first payment/, region: 'milestone' },
]

function card(page: Page) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name: /^(Get started|Needs attention)$/ }) })
}

/** #4707: the milestone card, found by its own heading. */
function milestoneCard(page: Page) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name: /made its first payment$/ }) })
}

test.describe('first-run guide states (#3818)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  for (const vp of VIEWPORTS) {
    for (const { state, anchor, region } of STATES) {
      test(`${state} — ${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height })
        await page.clock.setFixedTime(FROZEN_NOW)
        await mockHavenApi(page)
        await serveFirstRunOverview(page, () => state)
        await seedAuthenticatedSession(page)

        await page.goto('/dashboard')
        await dismissMobileSidebar(page)
        const clip = region === 'milestone' ? milestoneCard(page) : card(page)
        await expect(clip.getByText(anchor)).toBeVisible({ timeout: 60_000 })
        await expect(clip.locator('.animate-pulse')).toHaveCount(0)
        await page.evaluate(() => document.fonts.ready)
        await page.waitForLoadState('networkidle')
        await expect(clip).toHaveScreenshot(`first-run-${state}-${vp.name}.png`, SNAPSHOT_OPTIONS)
      })
    }
  }
})
