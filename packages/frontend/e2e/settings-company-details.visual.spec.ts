/**
 * Visual regression for Settings → Company details (#3332): the owner
 * company-details + VIES section, behind `HAVEN_OWNER_COMPANY_DETAILS`.
 *
 * Two states, light + dark (desktop only — no mobile dark baseline exists
 * for this spec, same convention `marketplace.visual.spec.ts` follows):
 * empty (nothing saved yet — the purpose text and blank fields) and filled
 * with a VIES-`valid` VAT number (the "checked against VIES on <date>" line,
 * never "verified").
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
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
 * The mobile clip's own height (#3332 design review 1, round 2 fix). The
 * form stacks all four fields at 390px width (below the `sm:grid-cols-2`
 * breakpoint), which makes the card taller than the committed 844px mobile
 * viewport, so a TALL viewport is still needed: tall enough that the whole
 * card fits inside one viewport with nothing left to scroll to, so the fixed
 * mobile tab bar (`Sidebar`'s `fixed bottom-…`) never has anything left
 * below the fold to paint over.
 *
 * The height alone is NOT sufficient, though (round 1's mistake): Settings
 * renders several cards above this one, so the PAGE is taller than
 * `MOBILE_CAPTURE_HEIGHT` even though the CARD on its own is not, and
 * Playwright's element-screenshot scroll (`scrollIntoViewIfNeeded`, run
 * before every actionability-gated call, including `toHaveScreenshot`)
 * aligns to whichever edge needs the LEAST scrolling — here, the bottom edge
 * — which lands the card's bottom flush with the bottom of the viewport,
 * exactly where the fixed tab bar sits, painting over Save/Remove. `card`
 * below is explicitly scrolled to the TOP of the scroll area first, so the
 * whole card (which fits inside `MOBILE_CAPTURE_HEIGHT`) renders above the
 * tab bar instead. The clip filenames are unchanged — height is not part of
 * their identity, only the width class (`-mobile`) is.
 */
const MOBILE_CAPTURE_HEIGHT = 2000

/**
 * #3332 review round 2, design 1: scrolls `card` to the TOP of its scroll
 * area (`#main-content`, `AuthenticatedShell`'s `overflow-y-auto` region) —
 * not merely "into view", which `scrollIntoViewIfNeeded` already does and
 * bottom-aligns when that is the shorter scroll, landing the card under the
 * fixed mobile tab bar. `block: 'start'` forces the far edge instead.
 */
async function scrollCardToTop(card: Locator) {
  await card.evaluate((el) => el.scrollIntoView({ block: 'start' }))
}

const EMPTY_DETAILS = null

const FILLED_DETAILS = {
  legal_name: 'Ada Lovelace AB',
  country: 'SE',
  org_number: '556677-8899',
  vat_number: 'SE556677889901',
  vies_status: 'valid',
  vies_checked_at: '2026-09-20T10:00:00.000Z',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-20T10:00:00.000Z',
}

async function serveCompanyDetails(page: Page, body: unknown, status = 200) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/user/company-details') {
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      return
    }
    await route.fallback()
  })
}

async function openSettings(page: Page) {
  await page.goto('/settings')
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('button[aria-label="User menu"]')).toHaveCount(1)
  await dismissMobileSidebar(page)
  const heading = page.getByRole('heading', { name: 'Company details', exact: true })
  const card = page.locator('section', { has: heading })
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId('company-details-form')).toHaveCount(1)
  return card
}

test.describe('settings company details', () => {
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
  })

  for (const vp of VIEWPORTS) {
    test(`empty — purpose text, blank fields (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: vp.name === 'mobile' ? MOBILE_CAPTURE_HEIGHT : vp.height })
      await serveCompanyDetails(page, EMPTY_DETAILS, 200)
      const card = await openSettings(page)
      await expect(card.getByLabel('Legal name')).toHaveValue('')
      await expect(card.getByTestId('company-details-purpose')).toContainText('personal identity number')
      await scrollCardToTop(card)
      await expect(card).toHaveScreenshot(
        `settings-company-details-empty-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    test(`filled — VIES checked against VIES, never "verified" (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: vp.name === 'mobile' ? MOBILE_CAPTURE_HEIGHT : vp.height })
      await serveCompanyDetails(page, FILLED_DETAILS)
      const card = await openSettings(page)
      await expect(card.getByLabel('Legal name')).toHaveValue('Ada Lovelace AB')
      await expect(card.getByText('VAT number checked against VIES on 20 September 2026')).toHaveCount(1)
      await expect(card.getByText(/verified/i)).toHaveCount(0)
      await expect(card.getByRole('button', { name: 'Remove company details' })).toHaveCount(1)
      await scrollCardToTop(card)
      await expect(card).toHaveScreenshot(
        `settings-company-details-filled-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })
  }
})
