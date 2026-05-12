import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
  testSafeAddress,
} from './fixtures/haven-api'

test.describe('dashboard browser UX', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('opens the receive flow with clear account and network context', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Receive' }).click()

    await expect(page.getByRole('heading', { name: 'Receive funds' })).toBeVisible()
    await expect(page.getByText('Operations').last()).toBeVisible()
    await expect(page.getByText('Gnosis Chain', { exact: true })).toBeVisible()
    await expect(page.getByText(testSafeAddress)).toBeVisible()
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    expect(browserErrors).toEqual([])
  })

  test('keeps the approval path reachable from the dashboard alert', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/dashboard')
    await page.getByRole('link', { name: 'Open approvals' }).click()

    await expect(page).toHaveURL(/\/approvals$/)
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()
    await expect(page.getByText('Research agent', { exact: true })).toBeVisible()
    await expect(page.getByText('12.50 USDC')).toBeVisible()
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    expect(browserErrors).toEqual([])
  })
})
