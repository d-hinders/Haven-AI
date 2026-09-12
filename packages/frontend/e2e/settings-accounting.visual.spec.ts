/**
 * Visual regression for the Settings → Accounting connections card (#2868,
 * epic #2858): one element-scoped clip per connection state, plus the inline
 * feed settings and the backfill choice on a first connect.
 *
 * The five states are spreads off the shared e2e `accountingConnection` row
 * (`fixtures/haven-api.ts`), served by re-routing `GET /accounting/connections`
 * per test. Each test asserts the state's own distinguishing copy AND its
 * action before the capture, and `toHaveCount(1)` on the card, so a locator
 * that drifts is a red test rather than a baseline of the wrong thing.
 *
 * The two feed OFF states (#2869 design review) are clipped at BOTH
 * committed widths: they are the states production shows, and a card with
 * no action has to read right in the stacked mobile layout too.
 *
 * Baselines are Linux-rendered by the "Update visual baselines" dispatch;
 * none are hand-made here.
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  accountingConnection,
  accountingFeedComingSoon,
  accountingFeedSelfHosted,
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  serveAccountingFeedStatus,
} from './fixtures/haven-api'
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

async function serveConnections(page: Page, connections: unknown[]) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/accounting/connections') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections }) })
      return
    }
    await route.fallback()
  })
}

async function openSettings(page: Page, query = '') {
  await page.goto(`/settings${query}`)
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('button[aria-label="User menu"]')).toHaveCount(1)
  await dismissMobileSidebar(page)
  const heading = page.getByRole('heading', { name: 'Accounting', exact: true })
  const card = page.locator('section', { has: heading })
  await expect(card).toHaveCount(1)
  // The rows, not the heading: the card shows a skeleton until both listings answer.
  await expect(card.getByTestId('connection-actions-fortnox')).toHaveCount(1)
  return card
}

test.describe('settings accounting connection states', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('connected — company, last push, Settings + Disconnect', async ({ page }) => {
    const card = await openSettings(page)
    await expect(card.getByText(/Connected to Ada Lovelace AB/)).toHaveCount(1)
    const actions = card.getByTestId('connection-actions-fortnox')
    await expect(actions.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1)
    await expect(actions.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(1)
    await expect(card).toHaveScreenshot('settings-accounting-connected-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('connected — the inline feed settings open', async ({ page }) => {
    const card = await openSettings(page)
    await card.getByTestId('connection-actions-fortnox').getByRole('button', { name: 'Settings', exact: true }).click()
    const form = card.getByTestId('connection-settings-fortnox')
    await expect(form).toHaveCount(1)
    await expect(form.getByText(/It only suggests — it never books/)).toHaveCount(1)
    await expect(form.getByLabel('Suggested account')).toHaveValue('6540')
    await expect(card).toHaveScreenshot('settings-accounting-settings-open-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('needs_reauthorisation — Reconnect', async ({ page }) => {
    await serveConnections(page, [{ ...accountingConnection, status: 'needs_reauthorisation', statusReason: 'refresh token refused by Fortnox' }])
    const card = await openSettings(page)
    await expect(card.getByText('Sign-in expired', { exact: true })).toHaveCount(1)
    await expect(card.getByText(/Your Fortnox sign-in has expired/)).toHaveCount(1)
    await expect(card.getByTestId('connection-actions-fortnox').getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(1)
    await expect(card).toHaveScreenshot('settings-accounting-needs-reauthorisation-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('scope_missing — names the missing scopes, Reconnect', async ({ page }) => {
    await serveConnections(page, [
      { ...accountingConnection, status: 'scope_missing', grantedScope: 'bookkeeping', missingScopes: ['companyinformation', 'archive'] },
    ])
    const card = await openSettings(page)
    await expect(card.getByText('Needs more access', { exact: true })).toHaveCount(1)
    // Human labels for the scope identifiers, never the raw ids (#2903 review).
    await expect(card.getByText(/\(company information, archive\)/)).toHaveCount(1)
    await expect(card.getByText(/companyinformation/)).toHaveCount(0)
    await expect(card.getByTestId('connection-actions-fortnox').getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(1)
    await expect(card).toHaveScreenshot('settings-accounting-scope-missing-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('revoked_at_provider — Reconnect', async ({ page }) => {
    await serveConnections(page, [{ ...accountingConnection, status: 'revoked_at_provider', isActiveDestination: false }])
    const card = await openSettings(page)
    await expect(card.getByText('Access revoked', { exact: true })).toHaveCount(1)
    await expect(card.getByText(/Access was revoked in Fortnox/)).toHaveCount(1)
    await expect(card.getByTestId('connection-actions-fortnox').getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(1)
    await expect(card).toHaveScreenshot('settings-accounting-revoked-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('disconnected — Connect, history stays', async ({ page }) => {
    await serveConnections(page, [
      { ...accountingConnection, status: 'disconnected', isActiveDestination: false, grantedScope: null, tokenExpiresAt: null },
    ])
    const card = await openSettings(page)
    await expect(card.getByText('Not connected', { exact: true })).toHaveCount(1)
    await expect(card.getByText(/What was fed earlier stays in Haven/)).toHaveCount(1)
    const actions = card.getByTestId('connection-actions-fortnox')
    await expect(actions.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(1)
    await expect(actions.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0)
    await expect(card).toHaveScreenshot('settings-accounting-disconnected-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('first connect — the backfill choice on the OAuth return', async ({ page }) => {
    await serveConnections(page, [{ ...accountingConnection, lastPushAt: null, settings: { suggestedAccount: null, autoFeed: true } }])
    await openSettings(page, '?provider=fortnox&connect=connected')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    // The PANEL, not `role="dialog"`: `ui/Modal` puts that role on its
    // `fixed inset-0` wrapper, so a clip of it is the whole page behind the
    // modal (#2903 review). `panelTestId` is the handle for the box itself.
    const dialog = page.getByTestId('backfill-dialog')
    await expect(dialog).toHaveCount(1)
    await expect(dialog.getByRole('heading', { name: 'Include earlier payments?' })).toHaveCount(1)
    await expect(dialog.getByRole('radio', { name: /Feed from now/ })).toBeChecked()
    await expect(dialog.getByRole('button', { name: 'Not now', exact: true })).toHaveCount(1)
    await expect(dialog).toHaveScreenshot('settings-accounting-backfill-dialog-desktop.png', SNAPSHOT_OPTIONS)
  })

  /**
   * The card in the feed's two OFF states (#2869). No `connection-actions-fortnox`
   * to wait on — the point is that no action renders — so these settle on the
   * state's own test id, then assert BY ROLE that no control is reachable and
   * that the neutral description, not the product sentence, sits above the
   * off copy (#2869 design review).
   */
  async function openSettingsOff(page: Page, testId: string) {
    await page.goto('/settings')
    await page.evaluate(() => document.fonts.ready)
    await expect(page.locator('button[aria-label="User menu"]')).toHaveCount(1)
    await dismissMobileSidebar(page)
    const heading = page.getByRole('heading', { name: 'Accounting', exact: true })
    const card = page.locator('section', { has: heading })
    await expect(card).toHaveCount(1)
    await expect(card.getByTestId(testId)).toHaveCount(1)
    for (const name of ['Connect', 'Reconnect', 'Disconnect', 'Settings']) {
      await expect(card.getByRole('button', { name, exact: true })).toHaveCount(0)
    }
    await expect(card.getByText("Your company's accounting tool.", { exact: true })).toHaveCount(1)
    await expect(card.getByText(/Connect the accounting tool your company uses/)).toHaveCount(0)
    return card
  }

  for (const vp of VIEWPORTS) {
    test(`hosted, flag off — every provider Coming soon, no action at all (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await serveConnections(page, [])
      await serveAccountingFeedStatus(page, accountingFeedComingSoon)
      const card = await openSettingsOff(page, 'accounting-coming-soon')
      await expect(card.getByText('Nothing can be connected yet.', { exact: true })).toHaveCount(1)
      await expect(card.getByTestId('connection-row-fortnox').getByText('Coming soon', { exact: true })).toHaveCount(1)
      await expect(card.getByTestId('connection-row-igdrasil')).toHaveCount(1)
      await expect(card).toHaveScreenshot(`settings-accounting-coming-soon-${vp.name}.png`, SNAPSHOT_OPTIONS)
    })

    test(`self-hosted — not available, no providers, never coming soon (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await serveConnections(page, [])
      await serveAccountingFeedStatus(page, accountingFeedSelfHosted)
      const card = await openSettingsOff(page, 'accounting-self-hosted')
      await expect(card.getByText('Not available on self-hosted', { exact: true })).toHaveCount(1)
      await expect(card.getByTestId('connection-row-fortnox')).toHaveCount(0)
      await expect(card.getByText('Coming soon', { exact: false })).toHaveCount(0)
      await expect(card).toHaveScreenshot(`settings-accounting-self-hosted-${vp.name}.png`, SNAPSHOT_OPTIONS)
    })
  }
})
