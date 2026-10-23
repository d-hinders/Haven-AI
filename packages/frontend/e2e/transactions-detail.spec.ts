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
    // #4266: the page is the shared ledger now, not a table. The row title is
    // WHO WAS PAID — the x402 resource host, never "Agent payment" or an
    // address — and the drawer calls it a "Paid request" (#4267), asserted
    // below. Scoped to the ledger so the document <title> ("Haven,
    // agent payments within your rules"), which Next's dev server renders
    // into <body>, can never be what a text locator resolves to (#2834).
    // The fixture serves TWO x402 rows (recorded + unrecorded eip3009
    // settlement, #3763); the row under test is the FIRST, which the click
    // below also anchors on.
    const ledger = page.getByTestId('transactions-ledger')
    await expect(ledger.getByText('research.example').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeEnabled()

    // Clicking the row opens the per-type detail panel.
    await ledger.locator('[role="button"][aria-haspopup="dialog"]').first().click()

    const panel = page.getByRole('dialog')
    await expect(panel).toBeVisible()
    // #4267: the panel leads with the answer. Its title is the row's — the
    // resource host — and the kind reads in words ("Paid request"), never the
    // protocol name ("x402 payment") or a raw proof value.
    await expect(panel.getByRole('heading', { name: 'research.example' })).toBeVisible()
    await expect(panel.getByText('Paid request', { exact: true })).toBeVisible()
    await expect(panel.getByText('For', { exact: true })).toBeVisible()
    await expect(panel.getByText('Recorded (verified)', { exact: true })).toBeVisible()
    await expect(panel).not.toContainText(/x402 payment/i)
    await expect(panel).not.toContainText('protocol_receipt_attached')

    // Technical details: closed by default, opened from the keyboard (a
    // native <summary> — jsdom cannot press it, so this is the proof).
    const technical = panel.getByTestId('transaction-technical-details')
    await expect(technical).not.toHaveAttribute('open')
    const summary = technical.locator('summary')
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(technical).toHaveAttribute('open', '')
    await expect(technical.getByText('Merchant address', { exact: true })).toBeVisible()
    await expect(technical.getByText('Settlement transaction', { exact: true })).toBeVisible()
    // The footer links the account's transaction — the eip3009 FUNDING leg.
    await expect(panel.getByRole('link', { name: 'View on explorer' })).toHaveAttribute(
      'href',
      /\/tx\/0x(ab){32}$/,
    )

    // No secrets ever surface in the UI.
    await expect(panel).not.toContainText(/delegate_key|private_key|privateKey/)
    // This used to be described as "and the panel doesn't break layout". It
    // never checked the panel: a fixed-position overlay contributes to neither
    // scroll box, so this measures `/transactions` BEHIND the panel (#1771).
    // Kept — the page behind is real content and this is a real assertion at
    // desktop width — but described accurately now. The panel's own box is
    // asserted separately below (#1773).
    //
    // (#1772 was the mobile clipping of the retired table; the ledger has no
    // table, and navigation.mobile.spec.ts asserts 375px separately.)
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
    // #4267: every address and hash is shortened and stays on one line at
    // 420px, the width the issue's acceptance names (the panel fills the
    // viewport there). Measured last: the checks above are at desktop width.
    await page.setViewportSize({ width: 420, height: 900 })
    const wrapped = await technical.locator('dd .font-mono').evaluateAll((values) =>
      values
        .filter((el) => el.getClientRects().length > 1 || el.getBoundingClientRect().height > 20)
        .map((el) => el.textContent),
    )
    expect(await technical.locator('dd .font-mono').count()).toBeGreaterThan(4)
    expect(wrapped).toEqual([])
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
