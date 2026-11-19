/**
 * Visual regression for turning Sales on (#4904, epic #4885): the Settings →
 * Business card and the dialog the approved mockup (#4894, 2026-11-16) draws.
 *
 * ## What is captured, and why these states
 *
 * - **The card, never on** — the state every user starts in: the purpose line
 *   and the one control. This is the card's default render, so it is the one
 *   most likely to drift.
 * - **The card, off** — the state after turning Sales off: the account and its
 *   network are kept, and the documented Detail list row says the keys are not
 *   accepted while off (owner decision 5 on #4894).
 * - **The dialog, first turn-on** — the network choice, the "cannot be changed
 *   later" line, and the facts. No name field (the server names the account
 *   "Sales").
 * - **The card, on, with Stripe deposit addresses (#4954)** — the section
 *   under the account rows: the one "not verified" notice, an active address
 *   and a retired one that stays listed, each labelled "registered by you, not
 *   verified by Haven" (`salesDepositAddresses`, `fixtures/haven-api.ts`).
 * - **The register dialog (#4954)** — the address field and its label.
 * - **The dialog, result** — `DialogResult` and the **Open Sales** action, which
 *   goes to `/sales`. No backup copy on any screen (#4984, reversing the
 *   #4894 drawing's `NoticeRow`). Reached by turning Sales back ON, which
 *   needs no passkey prompt (owner decision 5), so the capture never depends
 *   on a WebAuthn stub.
 *
 * ## Why the clips are the card and the panel, not the page
 *
 * A page-level capture of `/settings?tab=business` would fail on any unrelated
 * card change — the #2318 "green tick read wider than the thing it measured"
 * shape. The card is a `<section data-testid="sales-card">` (Card does not
 * forward `data-testid`), and the dialog's clip is `Modal`'s `panelTestId`,
 * which is the bordered box rather than the `fixed inset-0` wrapper (a
 * baseline of the wrapper is a screenshot of the page behind the modal).
 *
 * ## Dark
 *
 * The card and the dialog are theme-aware surfaces, so both schemes are
 * captured on desktop. Mobile is light-only, the same convention
 * `settings-company-details.visual.spec.ts` follows (no mobile dark baseline
 * for this spec).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  dismissMobileSidebar,
  mockHavenApi,
  salesDepositAddresses,
  seedAuthenticatedSession,
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
 * The mobile clip's own height: the card sits below Company details and the
 * Accounting connections, so the page is taller than the committed viewport.
 * The card is scrolled to the TOP of the scroll area first (the same fix
 * `settings-company-details.visual.spec.ts` needed), so the fixed mobile tab
 * bar never paints over it.
 */
const MOBILE_CAPTURE_HEIGHT = 2000

const SALES_ACCOUNT = {
  id: 'account-sales',
  account_address: '0x5555555555555555555555555555555555555555',
  chain_id: 8453,
  name: 'Sales',
  created_at: '2026-05-04T09:00:00.000Z',
}

const OFF_NEVER_ON = {
  enabled: false,
  enabled_at: null,
  disabled_at: null,
  merchant_account: null,
}

const OFF_WITH_ACCOUNT = {
  enabled: false,
  enabled_at: '2026-05-04T09:00:00.000Z',
  disabled_at: '2026-05-06T12:00:00.000Z',
  merchant_account: SALES_ACCOUNT,
}

const ON = {
  enabled: true,
  enabled_at: '2026-05-04T09:00:00.000Z',
  disabled_at: null,
  merchant_account: SALES_ACCOUNT,
}

/**
 * Serve the merchant-services route. `post` is the answer a turn-on gets; the
 * default is the ON state with `created: true`.
 */
async function serveMerchantServices(
  page: Page,
  get: unknown,
  post: unknown = { ...ON, created: true },
) {
  await page.route('**/api/merchant-services', async (route) => {
    const method = route.request().method()
    if (method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(get) })
      return
    }
    if (method === 'POST') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(post) })
      return
    }
    await route.fallback()
  })
}

/** #4954: serve the registered Stripe deposit addresses (Playwright runs the latest route first). */
async function serveDepositAddresses(page: Page) {
  await page.route('**/api/merchant-deposit-addresses', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ verification: 'Registered by you, not verified by Haven.', addresses: salesDepositAddresses }),
    })
  })
}

async function openBusiness(page: Page) {
  await page.goto('/settings?tab=business')
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('button[aria-label="User menu"]')).toHaveCount(1)
  await dismissMobileSidebar(page)
  const card = page.getByTestId('sales-card')
  await expect(card).toHaveCount(1)
  return card
}

async function scrollCardToTop(card: Locator) {
  await card.evaluate((el) => el.scrollIntoView({ block: 'start' }))
}

test.describe('settings sales card and dialog (#4904)', () => {
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
    test(`card — never on: the purpose line and the one control (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: vp.name === 'mobile' ? MOBILE_CAPTURE_HEIGHT : vp.height })
      await serveMerchantServices(page, OFF_NEVER_ON)
      const card = await openBusiness(page)

      await expect(card.getByRole('heading', { name: 'Sales' })).toHaveCount(1)
      await expect(card.getByRole('button', { name: 'Turn on Sales' })).toHaveCount(1)
      await expect(card.getByText('Sales account')).toHaveCount(0)
      await scrollCardToTop(card)
      await expect(card).toHaveScreenshot(
        `settings-sales-card-never-on-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    test(`card — off: the account is kept and the keys are refused (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: vp.name === 'mobile' ? MOBILE_CAPTURE_HEIGHT : vp.height })
      await serveMerchantServices(page, OFF_WITH_ACCOUNT)
      const card = await openBusiness(page)

      await expect(card.getByText('Off', { exact: true })).toHaveCount(1)
      await expect(card.getByText('Keys not accepted while off')).toHaveCount(1)
      await expect(card.getByRole('link', { name: /Sales/ })).toHaveCount(1)
      await scrollCardToTop(card)
      await expect(card).toHaveScreenshot(
        `settings-sales-card-off-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    test(`card — on: Stripe deposit addresses, active and retired (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: vp.name === 'mobile' ? MOBILE_CAPTURE_HEIGHT : vp.height })
      await serveMerchantServices(page, ON)
      await serveDepositAddresses(page)
      const card = await openBusiness(page)

      const section = card.getByTestId('sales-deposit-addresses')
      await expect(section).toHaveCount(1)
      await expect(section.getByTestId('sales-deposit-address')).toHaveCount(2)
      await expect(section.getByText('Not verified by Haven', { exact: true })).toHaveCount(2)
      await expect(section.getByText('Retired', { exact: true })).toHaveCount(1)
      await expect(section.getByRole('button', { name: /^Retire / })).toHaveCount(1)
      await scrollCardToTop(card)
      await expect(card).toHaveScreenshot(
        `settings-sales-card-on-stripe-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    test(`dialog — register a Stripe deposit address (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: vp.name === 'mobile' ? MOBILE_CAPTURE_HEIGHT : vp.height })
      await serveMerchantServices(page, ON)
      await serveDepositAddresses(page)
      const card = await openBusiness(page)

      await card.getByRole('button', { name: 'Register address' }).click()
      const panel = page.getByTestId('register-deposit-address-dialog')
      await expect(panel).toHaveCount(1)
      await expect(panel.getByLabel('Deposit address')).toHaveCount(1)
      await expect(panel.getByText('Registered by you, not verified by Haven.', { exact: true })).toHaveCount(1)
      await expect(panel).toHaveScreenshot(
        `settings-sales-dialog-register-address-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })

    test(`dialog — first turn-on: the network choice, and it cannot change later (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: vp.name === 'mobile' ? MOBILE_CAPTURE_HEIGHT : vp.height })
      await serveMerchantServices(page, OFF_NEVER_ON)
      const card = await openBusiness(page)

      await card.getByRole('button', { name: 'Turn on Sales' }).click()
      const panel = page.getByTestId('turn-on-sales-dialog')
      await expect(panel).toHaveCount(1)
      await expect(panel.getByLabel('Network')).toHaveCount(1)
      await expect(panel.getByText('The network cannot be changed later.')).toHaveCount(1)
      // No name field: the server names the account "Sales".
      await expect(panel.getByLabel('Account name')).toHaveCount(0)
      // #4984: no backup copy on the ask screen either.
      await expect(panel.getByText(/backup/i)).toHaveCount(0)
      await expect(panel).toHaveScreenshot(
        `settings-sales-dialog-form-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
        SNAPSHOT_OPTIONS,
      )
    })
  }

  test('dialog — result: the account is on, and Open Sales goes to the Sales page', async ({ page }, testInfo) => {
    const scheme = schemeOf(testInfo)
    await page.setViewportSize({ width: 1280, height: 720 })
    // Turning Sales back ON needs no network and no passkey (owner decision 5),
    // so the result screen is reachable without a WebAuthn stub.
    await serveMerchantServices(page, OFF_WITH_ACCOUNT, { ...ON, created: false })
    const card = await openBusiness(page)

    await card.getByRole('button', { name: 'Turn on Sales' }).click()
    const panel = page.getByTestId('turn-on-sales-dialog')
    await expect(panel).toHaveCount(1)
    await panel.getByRole('button', { name: 'Turn on Sales' }).click()

    await expect(panel.getByText('Sales is on')).toHaveCount(1)
    // #4984: the backup push is gone, and the guard is flipped rather than deleted.
    await expect(panel.getByText(/Add a backup/)).toHaveCount(0)
    await expect(panel.getByRole('link', { name: /Add backup/ })).toHaveCount(0)
    await expect(panel.getByText(/backup/i)).toHaveCount(0)
    await expect(panel.getByRole('link', { name: 'Open Sales' })).toHaveAttribute('href', '/sales')
    await expect(panel).toHaveScreenshot(
      `settings-sales-dialog-result-desktop${scheme === 'dark' ? '-dark' : ''}.png`,
      SNAPSHOT_OPTIONS,
    )
  })
})
