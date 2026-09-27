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
import { expect, test, type Page } from '@playwright/test'
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
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await serveCompanyDetails(page, EMPTY_DETAILS, 200)
      const card = await openSettings(page)
      await expect(card.getByLabel('Legal name')).toHaveValue('')
      await expect(card.getByTestId('company-details-purpose')).toContainText('personal identity number')
      await expect(card).toHaveScreenshot(
        `settings-company-details-empty-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    test(`filled — VIES checked against VIES, never "verified" (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await serveCompanyDetails(page, FILLED_DETAILS)
      const card = await openSettings(page)
      await expect(card.getByLabel('Legal name')).toHaveValue('Ada Lovelace AB')
      await expect(card.getByText('VAT number checked against VIES on September 20, 2026')).toHaveCount(1)
      await expect(card.getByText(/verified/i)).toHaveCount(0)
      await expect(card.getByRole('button', { name: 'Remove company details' })).toHaveCount(1)
      await expect(card).toHaveScreenshot(
        `settings-company-details-filled-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })
  }
})
