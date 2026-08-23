/**
 * The clip guard: how much of a capture target is hidden below the fold.
 *
 * Extracted verbatim from `screenshot.mjs` by #1886 so that it can be imported
 * — and therefore ASSERTED AGAINST — from a Playwright spec. `screenshot.mjs`
 * is an on-demand evidence CLI that CI never runs, so for as long as the guard
 * lived inside it, nothing re-ran the proof: #1879 corrected it by a manual,
 * one-off mutation and the correction had no durable gate. Its horizontal twin
 * `measureDialogOverflow` (`e2e/fixtures/haven-api.ts`) is asserted against in
 * real specs on every pull request; that asymmetry was the finding.
 *
 * Nothing about the measurement changed in the move. The gate lives in
 * `e2e/clip-guard.spec.ts`, which drives this exact function over a synthetic
 * `page.setContent()` fixture under a real layout engine — deliberately NOT
 * over an app route, so that a layout change (#1887) cannot redden it and it
 * answers only "did the guard stop working", never "are these captures still
 * clipped". See that spec's header for why the other two instruments were not
 * chosen.
 *
 * **This must not be tested in jsdom.** jsdom performs no layout, so every box
 * reports `scrollHeight === clientHeight === 0` and every assertion built on
 * them passes against every input — including a guard that returns a constant.
 * That suggestion was made on #1879 and declined for exactly this reason.
 */

/**
 * Sub-pixel layout rounding tolerance for the clip guard, in CSS pixels.
 *
 * Deliberately left at the value the guard shipped with. The measured
 * shortfalls this change exists to catch are 17-1060px (see #1879), so the
 * tolerance is nowhere near the decision boundary for a real defect — and
 * raising it to shorten the newly-honest report would be papering over exactly
 * the truncations the fix is for.
 */
export const CLIP_TOLERANCE_PX = 4

/**
 * How much of `target` is hidden below the fold — measured on the deepest
 * scrolling box in its SUBTREE, not on `target` itself (#1879).
 *
 * `shoot()` has no selector of its own; it measures whatever locator the caller
 * hands it, and 19 of its call sites hand it `page.getByRole('dialog')`. That
 * role sits on `ui/Modal`'s `fixed inset-0` wrapper (`Modal.tsx:109`), which is
 * viewport-sized and never scrolls: its `scrollHeight - clientHeight` is 0 no
 * matter how much the nested `min-h-0 flex-1 overflow-y-auto` body at `:153` is
 * hiding. Instrumented across ten dialog stages, the wrapper read 0px in all
 * ten while six had genuinely hidden content, up to 1060px. `ui/SidePanel` has
 * the same nested-scroller shape, and the two `card` call sites benefit for
 * free — which is why the fix is to change WHAT is measured rather than which
 * element the call sites hand in. A selector swap would have missed both.
 *
 * This is the vertical twin of `measureDialogOverflow` in
 * `e2e/fixtures/haven-api.ts`, and `ship-playbooks/frontend.md` §4 already
 * states the rule it encodes: measure the whole subtree, not the dialog node.
 *
 * Three exclusions, all structural or geometric rather than by class name, for
 * the reason the e2e twin records: a class-name rule silently exempts a real
 * defect that happens to carry the class.
 *
 * - `display: none` / `visibility: hidden` boxes are not laying out.
 * - A box 1px tall or shorter is not laying out real content either. Tailwind's
 *   `sr-only` idiom is `width: 1px; height: 1px; overflow: hidden`, so its
 *   `scrollHeight` is the full height of the screen-reader text while its
 *   `clientHeight` is 1 — every such element would report a large "overflow"
 *   that is the utility working as intended. This is the horizontal helper's
 *   measured false positive, transposed.
 * - A DESCENDANT whose computed `overflow-y` is `visible` **hides nothing**, so
 *   it is not measured. This is the one exclusion that needed measuring rather
 *   than reasoning, and it is the opposite of the rule the horizontal twin
 *   rejects. That one refuses to exempt `auto`/`scroll` boxes — the scrollers,
 *   which are exactly where the defect lives. This exempts `visible` boxes,
 *   which by definition do not clip: their overflow paints and propagates
 *   outward to the nearest clipping ancestor, and that ancestor reports it.
 *
 *   Measured across the four scenarios that newly reported (#1879): every
 *   genuine offender was `overflow-y: auto` (89-1060px), and every box in the
 *   2-5px noise band was `overflow-y: visible` — `<button>` at
 *   `clientHeight: 34, scrollHeight: 39`, flex rows at 40 vs 42. Six captures
 *   were flagged on nothing but a 5px button. Widening the tolerance past 5
 *   would have hidden them AND started hiding real 5px shortfalls; excluding
 *   boxes that cannot clip removes them for the right reason and leaves the
 *   tolerance alone.
 *
 * The TARGET itself is measured unconditionally, `overflow-y` and all. An
 * element screenshot captures the target's bounding box, so content overflowing
 * a non-clipping TARGET really is cut from the PNG — and that is precisely what
 * the guard measured before this change. Exempting it would have narrowed
 * existing coverage while fixing the nested case, which is a trade nobody asked
 * for. This way the measurement is a strict superset of the old one.
 *
 * Returns the worst offender's shortfall plus how many boxes report one.
 * `offenderCount` is NOT a count of distinct defects: one overflowing leaf
 * registers at every clipping ancestor that does not absorb it.
 *
 * **What this still cannot see**, named because the exclusion list above
 * otherwise reads as a complete account of the blind spots (#1879 review):
 * `scrollHeight` is a LAYOUT measurement, so anything that hides content
 * without changing a layout box is invisible to it — a `transform:
 * translateY()` that moves a child out of view, a `clip-path`, and `contain:
 * paint`. `querySelectorAll('*')` does not pierce shadow roots either; nothing
 * in this app uses them today, which is exactly why it would be a silent gap.
 * None of these are new here — they are inherent to measuring scroll boxes, and
 * the horizontal twin has them too — but a guard's docstring claiming three
 * exclusions and no limits is how the next person over-trusts it.
 */
export async function measureHiddenBelowFold(target) {
  return target
    .evaluate((root) => {
      const describe = (el) => {
        const cls = (el.getAttribute('class') ?? '').trim().replace(/\s+/g, ' ')
        const id = el.id ? `#${el.id}` : ''
        const testId = el.getAttribute('data-testid')
        return `${el.tagName.toLowerCase()}${id}${testId ? `[data-testid=${testId}]` : ''}${
          cls ? `.${cls.slice(0, 100)}` : ''
        }`
      }

      let hidden = 0
      let offender = null
      let offenderCount = 0

      const consider = (el, isRoot) => {
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return
        // `visible` is the only value that does not clip. `hidden` and `clip`
        // are deliberately IN — a box that truncates without even offering a
        // scrollbar is the worst version of this defect, not an exempt one.
        if (!isRoot && style.overflowY === 'visible') return
        const clientHeight = el.clientHeight
        if (clientHeight <= 1) return
        const by = el.scrollHeight - clientHeight
        if (by <= 1) return
        offenderCount += 1
        if (by > hidden) {
          hidden = by
          offender = describe(el)
        }
      }

      // The target itself first, measured exactly as it was before this change:
      // the two `card` call sites and `ReceiveFundsModal`, whose `role="dialog"`
      // sits on the scrolling content panel rather than on a wrapper.
      consider(root, true)
      for (const el of Array.from(root.querySelectorAll('*'))) consider(el, false)

      return { hidden, offender, offenderCount }
    })
    .catch(() => ({ hidden: 0, offender: null, offenderCount: 0 }))
}
