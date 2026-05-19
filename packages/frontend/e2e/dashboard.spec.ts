import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
  testSafeAddress,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

test.describe('dashboard browser UX', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('opens the receive flow with clear account and network context', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/dashboard')
    await dismissMobileSidebar(page)
    // The hero CTA renders as "Receive" for funded accounts and "Receive funds"
    // only after the dashboard knows the account is unfunded. The onboarding
    // checklist can also expose "Receive funds", so pin to the first exact
    // match in DOM order.
    await page
      .getByRole('button', { name: /^Receive( funds)?$/ })
      .first()
      .click()

    const modal = page.getByRole('dialog', { name: 'Receive funds' })
    await expect(modal).toBeVisible()
    await expect(modal.getByText('Operations')).toBeVisible()
    await expect(modal.getByText('Gnosis Chain', { exact: true })).toBeVisible()
    await expect(modal.getByText(testSafeAddress)).toBeVisible()
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  test('keeps the approval path reachable from the dashboard alert', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/dashboard')
    await dismissMobileSidebar(page)
    await page.getByRole('link', { name: 'Open approvals' }).click()

    await expect(page).toHaveURL(/\/approvals$/)
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()
    await expect(page.getByText('Research agent', { exact: true })).toBeVisible()
    await expect(page.getByText('12.50 USDC')).toBeVisible()
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
