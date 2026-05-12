import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
} from './fixtures/haven-api'

test.describe('authentication flows', () => {
  test('redirects protected routes to login when there is no session', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/dashboard')

    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    expect(browserErrors).toEqual([])
  })

  test('logs in with mocked backend data and lands on the dashboard', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)
    await mockHavenApi(page)

    await page.goto('/login')
    await page.getByLabel('Email').fill('ada@haven.test')
    await page.getByLabel('Password').fill('correct horse battery staple')
    await page.getByRole('button', { name: 'Log in' }).click()

    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText('$1,250.00')).toBeVisible()
    await expect(page.getByRole('link', { name: /Research agent Connected/ })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open approvals' })).toBeVisible()
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    expect(browserErrors).toEqual([])
  })

  test('renders an authenticated dashboard session without signing in again', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)

    await page.goto('/dashboard')

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText('Total balance')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Receive' })).toBeVisible()
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    expect(browserErrors).toEqual([])
  })
})
