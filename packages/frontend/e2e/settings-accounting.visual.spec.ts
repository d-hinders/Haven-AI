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
 * Baselines are Linux-rendered by the "Update visual baselines" dispatch;
 * none are hand-made here.
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  accountingConnection,
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
} from './fixtures/haven-api'

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
    await expect(card.getByText(/\(companyinformation, archive\)/)).toHaveCount(1)
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
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveCount(1)
    await expect(dialog.getByRole('heading', { name: 'Include earlier payments?' })).toHaveCount(1)
    await expect(dialog.getByRole('radio', { name: /Feed from now/ })).toBeChecked()
    await expect(dialog).toHaveScreenshot('settings-accounting-backfill-dialog-desktop.png', SNAPSHOT_OPTIONS)
  })
})
