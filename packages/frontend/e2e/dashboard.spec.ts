import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  measureDialogOverflow,
  mockHavenApi,
  openReceiveFundsModal,
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

    // Shared with `receive-modal.mobile.spec.ts` (#1797) — getting to the
    // screen is not viewport-dependent, so a second copy would only let the
    // two drift. The MEASUREMENT below stays written out here; see the
    // helper's JSDoc for why that split is deliberate.
    const modal = await openReceiveFundsModal(page)
    await expect(modal).toBeVisible()
    await expect(modal.getByText('Operations')).toBeVisible()
    await expect(modal.getByText('Base', { exact: true })).toBeVisible()
    await expect(modal.getByText(testSafeAddress)).toBeVisible()
    // Measures the dashboard BEHIND the modal, not the modal. A fixed-position
    // overlay contributes to neither scroll box — see the blind spot noted on
    // `expectNoHorizontalOverflow` (#1771), measured rather than assumed.
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({
      hasOverflow: false,
      contentRegionFound: true,
    })
    // ...and now the modal's OWN layout (#1773), which the assertion above is
    // structurally unable to see. `dialogFound` is asserted because an overlay
    // that is attached but not laid out measures `0 - 0 = 0` and reads as
    // "fits" — the same silent no-op `contentRegionFound` guards against.
    //
    // This is the one dialog of the three whose `role="dialog"` node is the
    // scrolling panel itself, so here `dialogOverflowBy` and
    // `overlayOverflowBy` agree. On the other two the dialog node is blind and
    // only the subtree figure moves; see the helper's JSDoc for the table.
    const receiveOverlay = await measureDialogOverflow(page)
    expect(receiveOverlay, `receive modal overflows: ${JSON.stringify(receiveOverlay)}`).toMatchObject({
      dialogFound: true,
      // Exactly one overlay, so "the dialog measured" is unambiguous. Without
      // this the helper silently measures whichever `[role="dialog"]` comes
      // first in DOM order, and a second one (a nested confirm, a portalled
      // prompt) would go unchecked with nothing going red to say so.
      dialogCount: 1,
      overlayOverflows: false,
    })
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
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({
      hasOverflow: false,
      contentRegionFound: true,
    })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
