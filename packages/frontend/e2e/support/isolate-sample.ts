import type { Locator } from '@playwright/test'

/**
 * Take a `/design-system` showcase sample out of the page's flow-above, so its
 * clip cannot move when unrelated content above it changes height (#3441).
 *
 * ── Why the clips moved ───────────────────────────────────────────────────────
 *
 * Every showcase clip sits below a long page of other samples. An edit to any
 * of them that changes the page height by a fraction of a pixel — a wrapped
 * line, a CodeBlock — starts the sample at a different subpixel offset, and
 * the clip rounds to a different whole pixel: the content moves 1px inside an
 * otherwise identical image, and its anti-aliasing re-rasterises. That flipped
 * the StackedBarChart baselines in #3198, #3312 and #3437, and #3805's
 * AttentionList and sparkline clips in #3877. A whole-pixel snap of the
 * sample's own position was tried first (paused branch
 * `fix/3441-stacked-bar-clip-stability`, `d33ec57b`); it held on macOS but not
 * on Linux CI.
 *
 * ── What this does instead ────────────────────────────────────────────────────
 *
 * It walks from the sample up to the shell's inner scroll root
 * (`#main-content`) and sets `display: none` on every PRECEDING sibling at
 * each level of a block or column-flex parent — the page header, the
 * sections above, the sample's own section heading. Content above the sample
 * then contributes no layout at all, whatever its height, so the sample's
 * position is fixed by the shell's own padding and margins. That makes the
 * stability a property of construction rather than of rounding.
 *
 * Only preceding siblings, and only in parents that stack vertically (block,
 * or a `column` flex — not `column-reverse`, whose preceding siblings render
 * below): following siblings never move the sample, and a sibling in a row
 * (flex row, grid) can set the sample's width and x position, which hiding it
 * would change. In a grid or row parent a preceding sibling is hidden only
 * when it sits wholly above the sample in the same column — a grid that
 * collapsed to one column, like the activity-row sample's below `lg`, where
 * `WalletIdentityBlock` stacks above it (#3441 design review: left visible,
 * it pushed the mobile clip under the fixed tab bar). A sibling beside the
 * sample stays. Every current sample's ancestors take their width from their
 * parent, so widths are untouched; a sample under a content-sized ancestor
 * would need a second look. The scroll root is reset to the top afterwards so the capture never
 * inherits a fractional scroll offset.
 *
 * Call it through the spec's `expectShowcaseClip`, AFTER the sample's
 * named-cause assertions (some read siblings the walk hides).
 */
export async function isolateShowcaseSample(sample: Locator): Promise<void> {
  await sample.evaluate((el) => {
    const root = document.getElementById('main-content')
    if (!root) throw new Error('isolateShowcaseSample: no #main-content scroll root')
    let node: Element | null = el
    while (node && node !== root) {
      const parent: Element | null = node.parentElement
      if (!parent) break
      const cs = getComputedStyle(parent)
      const stacksVertically =
        cs.display === 'block' ||
        cs.display === 'flow-root' ||
        ((cs.display === 'flex' || cs.display === 'inline-flex') && cs.flexDirection === 'column')
      // In a grid or row parent only a sibling that sits wholly ABOVE this
      // node, in the same column (same x and width), is hidden: that is a
      // grid collapsed to one column, where the sibling stacks like a block.
      // A sibling beside the node sets its track, so it stays. Measured
      // before anything at this level is hidden.
      const box = node.getBoundingClientRect()
      const toHide: HTMLElement[] = []
      let sibling = node.previousElementSibling
      while (sibling) {
        const b = sibling.getBoundingClientRect()
        const sameColumn = Math.abs(b.left - box.left) < 0.5 && Math.abs(b.width - box.width) < 0.5
        if (stacksVertically || (b.bottom <= box.top + 0.5 && sameColumn)) toHide.push(sibling as HTMLElement)
        sibling = sibling.previousElementSibling
      }
      for (const el of toHide) el.style.setProperty('display', 'none', 'important')
      node = parent
    }
    root.scrollTop = 0
  })
}
