import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

test.describe('Connect Agent 2 setup acceptance', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('keeps the old flow reachable and reaches connected-local without exposing secrets', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/agents')
    await dismissMobileSidebar(page)

    await expect(page.getByRole('button', { name: 'Connect agent', exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Connect agent 2' }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Agent name').fill('Research Agent')
    await dialog.getByRole('button', { name: 'Set agent budget' }).click()
    await dialog.getByPlaceholder('Amount').fill('10')
    await dialog.getByRole('button', { name: 'Add budget' }).click()
    await dialog.getByRole('button', { name: 'Review agent rules' }).click()
    await dialog.getByRole('button', { name: 'Create setup prompt' }).click()

    await expect(dialog.getByText('Connect your agent')).toBeVisible()
    await expect(dialog.getByText(/hv_setup_e2e123/).first()).toBeVisible()
    await expect(dialog).not.toContainText(/delegate_key|private_key|privateKey|HAVEN_DELEGATE_KEY/)

    await expect(dialog.getByText('Local connection ready')).toBeVisible()
    await expect(dialog.getByText('Connected locally')).toBeVisible()
    await expect(dialog.getByText('Wallet approval unavailable')).toBeVisible()
    await expect(dialog.getByText(/Connect a wallet or use a passkey/i)).toBeVisible()
    await expect(dialog).not.toContainText(/delegate_key|private_key|privateKey|HAVEN_DELEGATE_KEY/)

    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
