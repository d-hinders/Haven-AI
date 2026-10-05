import { expect, test } from '@playwright/test'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

// #3554: the Transactions row is a native row whose click is a mouse
// convenience; the title button is the accessible path, and the accounting
// badge and the explorer link are its SIBLINGS. This drives a real pointer
// at each of the three targets and asserts that only the row/title opens the
// drawer — the badge and the explorer link keep their own behaviour.
test.describe('transactions row — pointer activation (#3554)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    await page.goto('/transactions')
    await dismissMobileSidebar(page)
    await expect(page.getByRole('table').getByText('Agent payment').first()).toBeVisible()
  })

  test('clicking the blank area of a row opens the drawer', async ({ page }) => {
    // The direction cell holds no control and is laid out at every width.
    await page.locator('tbody tr').first().locator('td').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('clicking the accounting badge navigates and does not open the drawer', async ({ page }) => {
    await page.locator('tbody tr').first().getByTestId('accounting-badge').click()
    await page.waitForURL('**/accounting**')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('clicking the explorer link opens a popup and does not open the drawer', async ({
    page,
    context,
  }) => {
    const link = page.locator('tbody tr').first().getByRole('link', { name: 'Open externally' })
    const href = await link.getAttribute('href')
    expect(href).toBeTruthy()
    // Never load the real explorer.
    await context.route(`${new URL(href as string).origin}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }),
    )
    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()])
    expect(popup.url()).toBe(href)
    await popup.close()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
