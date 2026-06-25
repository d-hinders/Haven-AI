import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

// Automates the UI half of the x402 end-to-end checklist (#420): an x402
// payment "displays correctly in the UI (history + detail panel)". The
// on-chain settlement half stays manual (real chain/merchant). Locks in the
// CSV export (#411) and the per-type detail panel (#412) against regressions.
test.describe('transaction history — x402 display + detail panel', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('shows an x402 payment in history and opens its detail panel', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/transactions')
    await dismissMobileSidebar(page)

    // History renders the row and the export affordance.
    await expect(page.getByRole('heading', { name: 'Transaction history' })).toBeVisible()
    await expect(page.getByText('x402 payment').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeEnabled()

    // Clicking the row opens the per-type detail panel.
    await page.getByRole('button', { name: /View details for/ }).first().click()

    const panel = page.getByRole('dialog')
    await expect(panel).toBeVisible()
    // x402-specific body: resource hostname (not the full URL) + merchant.
    // `exact` avoids matching the "x402 payment …" heading.
    await expect(panel.getByText('Payment', { exact: true })).toBeVisible()
    await expect(panel.getByText('Resource', { exact: true })).toBeVisible()
    await expect(panel.getByText('research.example')).toBeVisible()
    await expect(panel.getByText('Merchant', { exact: true })).toBeVisible()
    // The always-present on-chain section with an explorer link for the tx hash.
    await expect(panel.getByText('On-chain', { exact: true })).toBeVisible()
    await expect(panel.getByRole('link', { name: /0xabab/i })).toBeVisible()

    // No secrets ever surface in the UI, and the panel doesn't break layout.
    await expect(panel).not.toContainText(/delegate_key|private_key|privateKey/)
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
