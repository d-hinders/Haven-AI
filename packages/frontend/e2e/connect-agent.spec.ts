import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  measureDialogOverflow,
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
    // #2264: the DELEGATION-rail step 4 (`DelegationApprovalStep`) is a signed
    // budget grant: the primary
    // action NAMES what it grants (#1684), which is the assertion worth having
    // on the screen that confers spend authority.
    await expect(dialog.getByRole('button', { name: 'Approve budget' })).toBeVisible()
    await expect(dialog.getByText('Approval unavailable')).toHaveCount(0)
    await expect(dialog).not.toContainText(/delegate_key|private_key|privateKey|HAVEN_DELEGATE_KEY/)

    // Measures `/agents` BEHIND the dialog, not the dialog. A fixed-position
    // overlay contributes to neither scroll box — see the blind spot noted on
    // `expectNoHorizontalOverflow` (#1771). The dialog's own box is asserted
    // separately below (#1773).
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({
      hasOverflow: false,
      contentRegionFound: true,
    })
    // ...and now the dialog's OWN layout (#1773). Asserted on the LAST screen
    // of the flow on purpose: this is where the modal carries a setup prompt,
    // a delegate address and a budget summary — the long unbreakable strings
    // that make a modal overflow in the first place.
    //
    // `ui/Modal` puts `role="dialog"` on the `fixed inset-0` container, whose
    // `clientWidth` is the whole viewport, and its body is
    // `min-h-0 flex-1 overflow-y-auto`. So the dialog node's own scroll box is
    // doubly blind here: it is viewport-sized AND the body absorbs the
    // overflow. Under a 120vw mutation the dialog node read 0 and the body
    // read 1010 — see the helper's JSDoc table.
    const connectOverlay = await measureDialogOverflow(page)
    expect(connectOverlay, `connect modal overflows: ${JSON.stringify(connectOverlay)}`).toMatchObject({
      dialogFound: true,
      // See dashboard.spec.ts — pins WHICH overlay was measured.
      dialogCount: 1,
      overlayOverflows: false,
    })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
