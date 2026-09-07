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

// Automates the UI half of the x402 end-to-end checklist (#420): an x402
// payment "displays correctly in the UI (history + detail panel)". The
// on-chain settlement half stays manual (real chain/merchant). Locks in the
// CSV export (#411) and the per-type detail panel (#412) against regressions.
test.describe('transaction history — x402 display + detail panel', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('shows an x402 payment in history and opens its detail panel', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/transactions')
    await dismissMobileSidebar(page)

    // History renders the row and the export affordance.
    await expect(page.getByRole('heading', { name: 'Transaction history' })).toBeVisible()
    // #2357: the row title is user-facing copy now — the protocol name moved
    // to the detail drawer's section heading, asserted below.
    await expect(page.getByText('Agent payment').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeEnabled()

    // Clicking the row opens the per-type detail panel.
    await page.getByRole('button', { name: /View details for/ }).first().click()

    const panel = page.getByRole('dialog')
    await expect(panel).toBeVisible()
    // x402-specific body: resource hostname (not the full URL) + merchant.
    // The section heading carries the protocol name since #2357; the panel's
    // own title is the row's user-facing "Agent payment by …".
    await expect(panel.getByText('x402 payment', { exact: true })).toBeVisible()
    await expect(panel.getByText('Resource', { exact: true })).toBeVisible()
    await expect(panel.getByText('research.example')).toBeVisible()
    await expect(panel.getByText('Merchant', { exact: true })).toBeVisible()
    // The always-present on-chain section with an explorer link for the tx hash.
    await expect(panel.getByText('On-chain', { exact: true })).toBeVisible()
    await expect(panel.getByRole('link', { name: /0xabab/i })).toBeVisible()

    // No secrets ever surface in the UI.
    await expect(panel).not.toContainText(/delegate_key|private_key|privateKey/)
    // This used to be described as "and the panel doesn't break layout". It
    // never checked the panel: a fixed-position overlay contributes to neither
    // scroll box, so this measures `/transactions` BEHIND the panel (#1771).
    // Kept — the page behind is real content and this is a real assertion at
    // desktop width — but described accurately now. The panel's own box is
    // asserted separately below (#1773).
    //
    // #1772 is the mobile-width clipping of this same table. It does not fire
    // here: at 1280px the table fits, and the mobile project asserts the route
    // separately with that defect exempted by name.
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({
      hasOverflow: false,
      contentRegionFound: true,
    })
    // ...and now the assertion the comment above used to be mistaken for: the
    // PANEL's own layout (#1773).
    //
    // This is the call site that proves the subtree scan was necessary. The
    // panel is a `ui/SidePanel`, whose `role="dialog"` node wraps a
    // `flex-1 overflow-y-auto` body; per CSS Overflow §3 that body's
    // `overflow-x` computes to `auto`, so it is itself a horizontal scroll box
    // and swallows the overflow. Under a 120vw mutation the dialog node's own
    // `scrollWidth - clientWidth` stayed at 0 while the body's read 1129.
    // Measuring only the dialog node — the shape #1773 proposed — would have
    // left this spec green.
    const detailOverlay = await measureDialogOverflow(page)
    expect(detailOverlay, `detail panel overflows: ${JSON.stringify(detailOverlay)}`).toMatchObject({
      dialogFound: true,
      // See dashboard.spec.ts — pins WHICH overlay was measured.
      dialogCount: 1,
      overlayOverflows: false,
    })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
