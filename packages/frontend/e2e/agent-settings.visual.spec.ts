/**
 * Visual regression for the agent Settings tab (#4871, epic #4868).
 *
 * The tab had no baseline before this slice. #4871 adds the checkout-details
 * sharing row beside the tax declaration row, so this spec pins the whole
 * "This agent" section — heading plus every row — in the state the new row
 * exists for: the company-details feature on, a VIES-valid row saved, the tax
 * declaration switch OFF and the checkout-details switch ON (the two switches
 * are independent, and this is the combination the new row introduces).
 *
 * Light + dark on desktop, light on mobile — the same convention
 * `settings-company-details.visual.spec.ts` follows (no mobile dark baseline).
 *
 * The capture is the SECTION, not the card: the heading is part of the
 * contract (`SettingsSection` renders it above the card), and a card-only
 * clip would let a heading regression pass.
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  serveAgentDetailResponses,
  testAgent,
} from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'
import { THEME_STORAGE_KEY } from '../src/lib/theme-bootstrap'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: 'desktop' | 'mobile'; width: number; height: number }>

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 50,
  threshold: 0.02,
} as const

/**
 * The section is taller than the committed viewport: six rows, two
 * closed-by-default disclosures and the account-level card below. Playwright's
 * element screenshot only paints the part of the element inside the viewport,
 * so the capture height is raised until the whole section fits — the same
 * reason `settings-company-details.visual.spec.ts` raises its own.
 */
const DESKTOP_CAPTURE_HEIGHT = 1600
const MOBILE_CAPTURE_HEIGHT = 2800

const captureHeight = (vp: { name: 'desktop' | 'mobile' }): number =>
  vp.name === 'mobile' ? MOBILE_CAPTURE_HEIGHT : DESKTOP_CAPTURE_HEIGHT

/** The owner's saved company details: VIES valid, receipt email and both addresses. */
const FILLED_DETAILS = {
  legal_name: 'Ada Lovelace AB',
  country: 'SE',
  org_number: '556677-8899',
  vat_number: 'SE556677889901',
  vies_status: 'valid',
  vies_checked_at: '2026-09-20T10:00:00.000Z',
  receipt_email: 'billing@acme.se',
  billing_address: {
    line1: 'Sveavagen 1',
    line2: '4 tr',
    city: 'Stockholm',
    postCode: '111 57',
    country: 'SE',
  },
  shipping_address: { line1: 'Storgatan 2', city: 'Goteborg', country: 'SE' },
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-20T10:00:00.000Z',
}

/**
 * Overlays the two reads this tab's rows depend on, AFTER
 * `serveAgentDetailResponses` (later-registered routes win):
 *
 * - `GET /agents` — the page resolves its agent from the LIST read, and the
 *   two switches ride on it. Tax OFF, checkout sharing ON: the independent
 *   combination this slice introduces.
 * - `GET /user/company-details` — a filled, VIES-valid row, so BOTH toggles
 *   render (the tax toggle requires VIES `valid`; the checkout toggle only
 *   requires the feature to be on).
 */
async function serveSettingsState(page: Page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() !== 'GET') return route.fallback()

    if (path === '/agents') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            {
              ...testAgent,
              tax_declaration_enabled: false,
              checkout_details_sharing_enabled: true,
            },
          ],
        }),
      })
      return
    }

    if (path === '/user/company-details') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FILLED_DETAILS),
      })
      return
    }

    await route.fallback()
  })
}

async function openSettingsTab(page: Page) {
  await page.goto(`/agents/${testAgent.id}?tab=settings`)
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('button[aria-label="User menu"]')).toHaveCount(1)
  await dismissMobileSidebar(page)
  const section = page.getByTestId('agent-settings-card-section')
  await expect(section).toHaveCount(1)
  // The two switches are the rows this slice is about — assert they are
  // present before the capture, so a hidden row fails loudly rather than
  // silently shrinking the baseline.
  await expect(section.getByTestId('tax-declaration-row')).toHaveCount(1)
  await expect(section.getByTestId('checkout-details-sharing-row')).toHaveCount(1)
  await expect(section.getByTestId('checkout-details-sharing-row').getByRole('checkbox')).toBeChecked()
  // Scroll the section to the TOP of the scroll area, so the fixed mobile tab
  // bar never paints over its bottom edge.
  await section.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  return section
}

test.describe('agent settings tab', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  const schemeOf = (testInfo: { project: { name: string } }): 'light' | 'dark' =>
    testInfo.project.name === 'chromium-desktop-dark' ? 'dark' : 'light'

  test.beforeEach(async ({ page }, testInfo) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    if (schemeOf(testInfo) === 'dark') {
      await page.addInitScript((themeKey: string) => {
        window.localStorage.setItem(themeKey, 'dark')
      }, THEME_STORAGE_KEY)
    }
    // The detail page's other reads (passport, delegate balance, activity,
    // stats) come from the shared overlay; the two reads this tab's rows need
    // are overlaid on top of it.
    await serveAgentDetailResponses(page, testAgent.id)
    await serveSettingsState(page)
  })

  for (const vp of VIEWPORTS) {
    test(`This agent — checkout details beside tax declaration (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: captureHeight(vp) })
      const section = await openSettingsTab(page)
      await expect(section).toHaveScreenshot(
        `agent-settings-this-agent-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })
  }
})
