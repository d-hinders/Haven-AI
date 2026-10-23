import { expect, test } from '@playwright/test'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

// #3554, retargeted to the ledger rows in #4266: a ledger row is itself the
// control (`role="button"`, `aria-haspopup="dialog"`, tabindex 0) — click,
// Enter or Space opens the drawer — and the accounting badge inside it is a
// plain pill (no nested interactive control). This drives a real pointer and the keyboard at
// each target and asserts that only the row opens the drawer.
//
// The "explorer link opens a popup and does not open the drawer" leg is
// deleted, not retargeted: rows carry no explorer link any more (the detail
// panel has it), so there is no sibling control left to protect.
test.describe('transactions row — activation (#3554, #4266)', () => {
  const ROW = '[data-testid="transactions-ledger"] [role="button"][aria-haspopup="dialog"]'

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    await page.goto('/transactions')
    await dismissMobileSidebar(page)
    await expect(page.locator(ROW).first()).toBeVisible()
  })

  test('clicking the blank area of a row opens the drawer', async ({ page }) => {
    // The row's own padding, away from the title text and any badge.
    await page.locator(ROW).first().click({ position: { x: 4, y: 4 } })
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('the row holds no nested link or button; clicking its accounting badge opens the drawer', async ({
    page,
  }) => {
    // A role="button" row must not contain interactive descendants
    // (nested-interactive ARIA): the accounting badge on a row is a plain
    // pill, and the /accounting link lives in the detail panel's Accounting row.
    const row = page.locator(ROW).first()
    await expect(row.locator('a, button')).toHaveCount(0)
    await row.getByTestId('accounting-badge').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(page).toHaveURL(/\/transactions/)

    const feed = dialog.getByTestId('accounting-badge')
    await expect(feed).toBeVisible()
    await expect(feed).toHaveAttribute('href', /\/accounting/)
  })

  test('Enter on a focused row opens the drawer; Escape closes it and focus returns to the row', async ({
    page,
  }) => {
    const row = page.locator(ROW).first()
    await row.focus()
    await expect(row).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(row).toBeFocused()
  })

  test('Space on a focused row opens the drawer', async ({ page }) => {
    const row = page.locator(ROW).first()
    await row.focus()
    await page.keyboard.press('Space')
    await expect(page.getByRole('dialog')).toBeVisible()
  })
})
