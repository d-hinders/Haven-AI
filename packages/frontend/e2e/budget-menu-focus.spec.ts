/**
 * The budget ⋯ menus' focus chain, in a real browser (#4261).
 *
 * jsdom asserts the WIRING (DelegationBudgetCard.test.tsx); it cannot prove a
 * real menu hands focus to a real field, that a real modal returns it to the
 * trigger that opened it, or that nothing ever lands on <body>. This spec is
 * the part of #4261's focus contract that is not describing its own fixture
 * back to itself.
 *
 * The shared fixture serves one ACTIVE delegation (250 USDC/week, hash
 * `0x4d…`), so every trigger here is the budget row's own ⋯ menu.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  serveAgentDetailResponses,
  testRecipientAddress,
  testSafe,
} from './fixtures/haven-api'

const AGENT = 'agent-research'
const ANCHOR_TIMEOUT_MS = 60_000

/** The budget card's row-menu trigger — the row's identity lives on its aria-label. */
function menuTrigger(page: Page) {
  return page.locator('#delegation-budget-card').getByRole('button', { name: /^Budget options/ })
}

test.describe('budget ⋯ menu focus (#4261)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    // AFTER `mockHavenApi` — later-registered routes win (#2733).
    await serveAgentDetailResponses(page, AGENT)
    await seedAuthenticatedSession(page)
  })

  async function openAgentPage(page: Page, search = '') {
    await page.goto(`/agents/${AGENT}${search}`)
    await expect(page.getByRole('heading', { name: 'Research agent', exact: true })).toBeVisible({
      timeout: ANCHOR_TIMEOUT_MS,
    })
    await dismissMobileSidebar(page)
    await expect(menuTrigger(page)).toBeVisible()
  }

  test('Add budget moves focus to the amount field; Cancel returns it to the opening trigger', async ({
    page,
  }) => {
    await openAgentPage(page)
    // The old Add budget button is gone — the menu item replaced it.
    await expect(page.getByRole('button', { name: 'Add budget' })).toHaveCount(0)

    await menuTrigger(page).click()
    await page.getByRole('menuitem', { name: 'Add budget' }).click()
    await expect(page.getByLabel('Budget amount')).toBeFocused()

    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(menuTrigger(page)).toBeFocused()
  })

  test('Edit budget moves focus into the modal and back to the trigger on close', async ({ page }) => {
    await openAgentPage(page)

    await menuTrigger(page).click()
    await page.getByRole('menuitem', { name: 'Edit budget' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit budget' })
    await expect(dialog).toBeVisible()
    // Focus is INSIDE the dialog, never on <body>.
    const focusInside = await dialog.evaluate((el) => el.contains(document.activeElement))
    expect(focusInside, 'the edit modal holds focus on open').toBe(true)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(menuTrigger(page)).toBeFocused()
  })

  test('a ?grant= prefill has no origin: Cancel returns focus to the first row trigger', async ({
    page,
  }) => {
    // Serve the active row PLUS a pending build the prefill can land on
    // (later-registered routes win over the shared fixture's list).
    await page.route('**/api/agents/agent-research/delegations*', async (route) => {
      await route.fulfill({
        json: {
          delegations: [
            {
              id: 'dlg-e2e-1',
              chain_id: testSafe.chain_id,
              token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              recipient_address: testRecipientAddress,
              delegation_hash: `0x${'4d'.repeat(32)}`,
              version: 1,
              status: 'active',
              is_live: true,
              budget_atomic: '250000000',
              period_seconds: 604_800,
              start_date: '1780394400',
              expires_at: Math.floor(Date.UTC(2027, 5, 2) / 1000),
              created_at: '2026-06-02T10:00:00.000Z',
            },
            {
              id: 'dlg-e2e-pending',
              chain_id: testSafe.chain_id,
              token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              recipient_address: null,
              delegation_hash: `0x${'cd'.repeat(32)}`,
              version: 1,
              status: 'pending',
              is_live: false,
              budget_atomic: '7000000',
              period_seconds: 86_400,
              start_date: '1780394400',
              expires_at: Math.floor(Date.UTC(2027, 5, 2) / 1000),
              created_at: '2026-06-02T10:00:00.000Z',
            },
          ],
        },
      })
    })

    await openAgentPage(page, `?grant=${'0x' + 'cd'.repeat(32)}`)
    await expect(page.getByLabel('Budget amount')).toHaveValue('7')

    await page.getByRole('button', { name: 'Cancel' }).click()
    // No menu origin, so the collapse falls to the first row's trigger.
    await expect(menuTrigger(page)).toBeFocused()
  })
})
