import type { Locator } from '@playwright/test'

/**
 * Hide the page behind a modal before a clip of its panel, so the baseline
 * can only move when the modal moves (#3872).
 *
 * ── Why a panel clip is not all panel ─────────────────────────────────────────
 *
 * The panel is opaque, but its clip is a rectangle and the panel is not:
 *
 *   - its rounded corners (14 px on `ui/Modal`, 168 px outside the arc) always show
 *     the translucent `v2-modal-backdrop` over whatever page is behind the modal;
 *   - a content-height panel lands on a fractional height, Playwright's element
 *     clip rounds out to whole pixel rows, and the clip's first and last rows are
 *     then not panel paint either.
 *
 * When #3872 was measured, `agents-issue-sub-budget-empty-desktop` was a 714.75 px
 * panel in a 448x716 clip: the leaked bottom row carried the agent page's
 * "Confirming" status badge, so a change to that page's table (#3811's counterparty
 * rules) re-rendered the MODAL baseline with the modal itself byte-identical: 23–78
 * antialiased pixels at y 703–715, none inside the modal.
 *
 * ── What this does ────────────────────────────────────────────────────────────
 *
 * Both modal shapes render IN PLACE (no portal, their ancestor chain runs through
 * `main`), so "hide the page" cannot be one `visibility` on an ancestor: every
 * ancestor of the modal's overlay carries the rest of the page as its other
 * children. Those are what gets hidden, at every level from the overlay's parent up
 * to, but not including, `<body>`. Each of those ancestors then stops painting its
 * own box too, since `SetBudgetDialog`, `EditBudgetModal`, `IssueSubBudgetModal` and
 * `BackfillDialog` mount inside a card, and that card's border and shadow otherwise
 * run behind the panel's corners and move with the page's layout.
 *
 *   - `visibility` and transparent paint, not `display`, so nothing reflows under
 *     the fixed dialog.
 *   - The overlay's own subtree is never touched, so the panel, backdrop and scroll
 *     cue keep rendering.
 *   - `<body>`'s direct children stay, because that is where `ui/Combobox` portals
 *     its list from `sm` up. A clip of the open list inside a dialog needs it.
 *
 * The overlay is found from the panel, for either shape:
 *
 *   - `ui/Modal`: the `role="dialog"` wrapper above the panel.
 *   - `ReceiveDialog`, `ui/SidePanel`: the panel carries `role="dialog"` itself, so
 *     the overlay is its parent, the element that also holds `.v2-modal-backdrop`.
 *
 * What still reaches the edge pixels is `<body>`'s background (the page's base
 * surface token) and the backdrop's own colour. Both are a change to every modal,
 * not to the page behind one.
 *
 * It is a snapshot of the DOM at the call. A node added to an on-path level after it,
 * or a descendant with an explicit `visibility: visible`, would still paint.
 *
 * It throws rather than hiding nothing, or the wrong thing, on a dialog of another
 * shape: an overlay that is a direct child of `<body>` would hide nothing and leave
 * the leak in place, and a `role="dialog"` panel with no backdrop beside it has no
 * overlay to keep. An assertion failing here aborts `update-visual-baselines.yml`
 * before its commit step (#3441), which is the point.
 *
 * Call it last, right before the shutter: it edits the page.
 *
 * @param panel the bordered box, never a `ui/Modal`'s `role="dialog"` wrapper, which
 *   is `fixed inset-0` and so a clip of the whole viewport (#2903). On `ui/Modal` that
 *   is its `panelTestId`; on `ReceiveDialog` it is `getByRole('dialog')`.
 */
export async function hidePageBehindModal(panel: Locator): Promise<void> {
  await panel.evaluate((element) => {
    const label = element.getAttribute('data-testid') ?? element.tagName
    const parent = element.parentElement
    const overlay =
      parent?.closest('[role="dialog"]') ??
      (element.matches('[role="dialog"]') && parent?.querySelector(':scope > .v2-modal-backdrop') ? parent : null)
    if (!overlay) {
      throw new Error(
        `hidePageBehindModal: ${label} has no role="dialog" wrapper above it, and is not a role="dialog" panel beside its own backdrop`,
      )
    }

    let hidden = 0
    let onPath: Element = overlay
    let ancestor = overlay.parentElement
    while (ancestor && ancestor !== document.body) {
      for (const sibling of Array.from(ancestor.children)) {
        if (sibling !== onPath && sibling instanceof HTMLElement) {
          sibling.style.visibility = 'hidden'
          hidden += 1
        }
      }
      if (ancestor instanceof HTMLElement) {
        ancestor.style.background = 'transparent'
        ancestor.style.borderColor = 'transparent'
        ancestor.style.boxShadow = 'none'
      }
      onPath = ancestor
      ancestor = ancestor.parentElement
    }

    if (hidden === 0) {
      throw new Error(`hidePageBehindModal: nothing hidden behind ${label}; was its overlay portaled to <body>?`)
    }
  })
}
