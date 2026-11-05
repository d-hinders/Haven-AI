import type { Locator } from '@playwright/test'

/**
 * Hide the page behind a `ui/Modal` before a clip of its panel, so the baseline
 * can only move when the modal moves (#3872).
 *
 * ── Why a panel clip is not all panel ─────────────────────────────────────────
 *
 * The panel is opaque, but its clip is a rectangle and the panel is not:
 *
 *   - its 14 px rounded corners (168 px outside the arc) always show the
 *     translucent `v2-modal-backdrop` over whatever page is behind the modal;
 *   - a content-height panel lands on a fractional height, Playwright's element
 *     clip rounds out to whole pixel rows, and the clip's first and last rows are
 *     then not panel paint either.
 *
 * Measured on `agents-issue-sub-budget-empty-desktop` (714.75 px, a 448x716 clip):
 * the leaked bottom row carried the agent page's "Confirming" status badge, so a
 * change to that page's table (#3811's counterparty rules) re-rendered the MODAL
 * baseline with the modal itself byte-identical: 23–78 antialiased pixels at
 * y 703–715, none inside the modal.
 *
 * ── What this does ────────────────────────────────────────────────────────────
 *
 * `ui/Modal` renders IN PLACE (no portal, its ancestor chain runs through `main`),
 * so "hide the page" cannot be one `visibility` on an ancestor: every ancestor of
 * the `role="dialog"` wrapper carries the rest of the page as its other children.
 * Those are what gets hidden, at every level from the wrapper's parent up to, but
 * not including, `<body>`. The backdrop then blends over the ancestors' uniform
 * backgrounds, and the clip's edge pixels carry only the modal's own overlay stack.
 *
 *   - `visibility`, not `display`, so nothing reflows under the fixed dialog.
 *   - The modal's own path is never touched, so the panel, backdrop and scroll cue
 *     keep rendering.
 *   - `<body>`'s direct children stay, because that is where `ui/Combobox` portals
 *     its list from `sm` up. A clip of the open list inside a dialog needs it.
 *
 * What still reaches the edge pixels is the ancestors' own background (the page's
 * base surface token) and the backdrop's own colour. Both are a change to every
 * modal, not to the page behind one.
 *
 * It throws rather than hiding nothing, or the wrong thing, on a dialog of another
 * shape: a wrapper that is a direct child of `<body>` would hide nothing and leave
 * the leak in place, and a panel that carries `role="dialog"` itself
 * (`ReceiveDialog`, `ui/SidePanel`) would lose its own backdrop. An assertion
 * failing here aborts `update-visual-baselines.yml` before its commit step
 * (#3441), which is the point.
 *
 * Call it last, right before the shutter: it edits the page.
 *
 * @param panel the bordered box (`panelTestId`), never the `role="dialog"` wrapper,
 *   which is `fixed inset-0` and so a clip of the whole viewport (#2903).
 */
export async function hidePageBehindModal(panel: Locator): Promise<void> {
  await panel.evaluate((element) => {
    const label = element.getAttribute('data-testid') ?? element.tagName
    const wrapper = element.parentElement?.closest('[role="dialog"]')
    if (!wrapper) {
      throw new Error(`hidePageBehindModal: no role="dialog" wrapper above ${label}, so it is not a ui/Modal panel`)
    }

    let hidden = 0
    let onPath: Element = wrapper
    let ancestor = wrapper.parentElement
    while (ancestor && ancestor !== document.body) {
      for (const sibling of Array.from(ancestor.children)) {
        if (sibling !== onPath && sibling instanceof HTMLElement) {
          sibling.style.visibility = 'hidden'
          hidden += 1
        }
      }
      onPath = ancestor
      ancestor = ancestor.parentElement
    }

    if (hidden === 0) {
      throw new Error(`hidePageBehindModal: nothing hidden behind ${label}; was its wrapper portaled to <body>?`)
    }
  })
}
