import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

test.describe('Connect agent setup acceptance', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('keeps the old flow reachable and reaches connected-local without exposing secrets', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/agents')
    await dismissMobileSidebar(page)

    // "Connect agent" is now the primary CTA and opens ConnectAgentModal directly.
    await expect(page.getByRole('button', { name: 'Connect agent', exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Connect agent', exact: true }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Agent name').fill('Research Agent')
    await dialog.getByRole('button', { name: 'Set agent budget' }).click()
    await dialog.getByPlaceholder('Amount').fill('10')
    await dialog.getByRole('button', { name: 'Review agent budget' }).click()
    await dialog.getByRole('button', { name: 'Create setup prompt' }).click()

    await expect(dialog.getByText('Connect your agent')).toBeVisible()
    await expect(dialog.getByText(/hv_setup_e2e123/).first()).toBeVisible()
    await expect(dialog).not.toContainText(/delegate_key|private_key|privateKey|HAVEN_DELEGATE_KEY/)

    // Pre-approval screen collapses to a single anchor Card: rules +
    // verification check inline, no separate green callout / awaiting-approval
    // budget card / "Ready for Haven approval" table / restart banner.
    //
    // #1684: the gate is named ONCE per viewport, by the modal SUBTITLE. The
    // summary card used to repeat it as a heading ~40px below — the same
    // sentence twice on the screen that grants spend authority — so this
    // asserts the subtitle and the absence of that heading, not the heading.
    // `exact` matters: a substring match also catches the block reason's
    // "…to approve the agent budget" and trips strict mode.
    await expect(dialog.getByText('Approve the agent budget', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Approve agent budget' })).toHaveCount(0)
    // ...and the verification proof is ONE row: the check and the truncated
    // delegate address ARE the disclosure trigger, with the address visible
    // while collapsed (the user's only check that the delegate about to get a
    // budget is the one on their own machine).
    await expect(dialog.getByText(/Local connection verified/i)).toBeVisible()
    await expect(dialog.getByText('Verification details')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await expect(dialog.getByText('Approval unavailable')).toBeVisible()
    await expect(dialog.getByText(/Connect a wallet or use a passkey/i)).toBeVisible()
    await expect(dialog).not.toContainText(/delegate_key|private_key|privateKey|HAVEN_DELEGATE_KEY/)

    // Measures `/agents` BEHIND the dialog, not the dialog. A fixed-position
    // overlay contributes to neither scroll box — see the blind spot noted on
    // `expectNoHorizontalOverflow` (#1771). Checking the dialog's own box is
    // #1773.
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({
      hasOverflow: false,
      contentRegionFound: true,
    })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
