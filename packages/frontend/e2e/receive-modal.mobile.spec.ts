/**
 * The dialog overflow guard, at the viewport where it matters (#1797).
 *
 * `measureDialogOverflow` shipped with #1773 and was mutation-proven three
 * times — all three at 1280px, because its three call sites
 * (`dashboard.spec.ts`, `connect-agent.spec.ts`, `transactions-detail.spec.ts`)
 * are not `*.mobile.spec.ts` and so run only under `chromium-desktop`. The
 * helper is viewport-agnostic and correct; the COVERAGE was upside down. A
 * receive panel carrying a 42-character address, a QR code and a row of
 * buttons is not what breaks at 1280px — it is what breaks at 393px. So the
 * guard demonstrably fired, but only in the viewport where the defect it
 * guards against is least likely.
 *
 * Same shape as the gap #1768 closed one level up: a check that exists and
 * gates, but not where the risk is.
 *
 * ## Why the receive modal and not one of the other two
 *
 * The narrowest thing that puts `measureDialogOverflow` in the
 * `chromium-mobile` project at all, per the issue's own direction. Its flow is
 * two clicks with no multi-step wizard to drive, and — unlike the other two —
 * its `role="dialog"` node IS the visual panel rather than a `fixed inset-0`
 * wrapper, which is what makes the viewport-absolute assertion below possible.
 * Widening to the connect modal and the x402 side panel is worth doing and is
 * not this issue.
 *
 * ## The viewport-absolute fields ARE asserted here, unlike at desktop
 *
 * `measureDialogOverflow` reports `dialogLeft` / `dialogRight` rather than
 * asserting them because its three desktop call sites disagree: at 1280px the
 * centred modal spans 384→896, the side panel 834→1282, and the `ui/Modal`
 * overlay 0→1280. No single anchor holds for all three.
 *
 * One call site knowing its own geometry is a different question, and #1797
 * asked it to be checked here rather than assumed. Checked: at 393px the panel
 * is `mx-4 w-full max-w-lg`, so `max-w-lg` (512px) stops binding and the panel
 * is viewport-width minus the two 16px margins — **16 → 377**, measured. That
 * is the mobile-only reading the desktop specs structurally cannot make, where
 * the same panel is centred at 384 → 896 by `max-w-lg`.
 *
 * ## Mutation proof — both assertions, at 393px, and neither transfers
 *
 * Per #1779: an anchor is only real once the mutation turned THAT spec red.
 * Both were run against a real Pixel 5 emulation on this branch.
 *
 * 1. **`w-[120vw]` block inside the modal body** → `overlayOverflows` red:
 *    `dialogScrollWidth: 496` against `dialogClientWidth: 359`, so
 *    `overlayOverflowBy: 137`, `offenderCount: 2`, worst offender the dialog
 *    panel itself, `contentMaxRight: 513` against a 393px viewport.
 *
 *    Note the number: **137 here, against #1773's 1026 for the same mutation
 *    at 1280px.** `120vw` is viewport-relative and the panel's own scroll box
 *    clamps it, so the overflow this guard sees at mobile width is roughly an
 *    eighth the size of the desktop one. That is the concrete reason #1773's
 *    proof does not transfer, rather than a procedural objection to reusing it.
 *
 * 2. **`mx-4` → `mx-0` on the panel** → `dialogLeft` red, expected 16, got 0,
 *    with `overlayOverflows` still false. So the viewport-absolute pins fail
 *    on a defect the overflow metric cannot see at all — a panel flush against
 *    both bezels overflows nothing and fits perfectly. This is #1779's point
 *    reproduced one layer down: `scrollWidth` vs `clientWidth` compares a box
 *    to itself and cannot see the box move.
 *
 * Restored between and after; the restore run is green, which is the half that
 * says the guard fired for the right reason rather than merely fired.
 *
 * ## Why pinning exact pixels here is not the flake the sibling helper warns of
 *
 * `expectNoHorizontalOverflow`'s JSDoc records that the desktop side panel's
 * rounded `right` read 1280, 1281 and 1282 across three runs, which is why the
 * viewport-absolute fields are reported and not asserted there. Two reasons
 * that does not transfer to this call site, and the second is the one that
 * matters:
 *
 * - **The arithmetic is all-integer.** 393 viewport, `mx-4` = 16px each side,
 *   `max-w-lg` (512) not binding, no percentage or transform centring — so
 *   16 and 377 fall out exactly, with no fractional input to round. The side
 *   panel's flush-right edge had sub-pixel layout to round.
 * - **Observed, not just derived.** These same two pins were asserted green on
 *   three separate runs of this spec (first run, pre-mutation baseline, and
 *   the post-mutation restore), and read identically each time. Raised by
 *   review as "single-run evidence for a pinned pixel"; it is three, and that
 *   is the sibling helper's own bar.
 */
import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  expectNoHorizontalOverflow,
  measureDialogOverflow,
  mockHavenApi,
  openReceiveFundsModal,
  seedAuthenticatedSession,
  testSafeAddress,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

test.describe('receive dialog at a mobile viewport', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('the receive panel fits inside a 393px viewport', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    const modal = await openReceiveFundsModal(page)
    await expect(modal).toBeVisible()
    // The content most likely to burst a 393px panel: a full 42-character
    // address. Asserted visible so the measurement below is taken with the
    // panel's widest element actually rendered, not before it paints.
    await expect(modal.getByText(testSafeAddress)).toBeVisible()

    // The page behind the overlay, for the same reason `dashboard.spec.ts`
    // takes it: a fixed-position dialog contributes to neither scroll box, so
    // this reading and the one below are about different things and neither
    // substitutes for the other.
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({
      hasOverflow: false,
      contentRegionFound: true,
    })

    const overlay = await measureDialogOverflow(page)
    expect(overlay, `receive modal overflows at mobile width: ${JSON.stringify(overlay)}`).toMatchObject({
      dialogFound: true,
      dialogCount: 1,
      overlayOverflows: false,
    })

    // Pixel 5 emulation, pinned so a project misconfiguration that silently
    // ran this file at 1280px fails here instead of passing as "mobile".
    expect(overlay.viewportWidth).toBe(393)
    // `mx-4 w-full` with `max-w-lg` no longer binding — see the docblock.
    expect(overlay.dialogLeft).toBe(16)
    expect(overlay.dialogRight).toBe(377)

    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
