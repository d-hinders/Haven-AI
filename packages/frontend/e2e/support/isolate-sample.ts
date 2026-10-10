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
 * Only preceding siblings, and only in parents that stack vertically:
 * following siblings never move the sample, and a sibling in a row (flex row,
 * grid) sets the sample's WIDTH and x position, which hiding it would change.
 * Widths are untouched — the sample renders exactly as it does in the page,
 * only higher up. The scroll root is reset to the top afterwards so the
 * capture never inherits a fractional scroll offset.
 *
 * Call it AFTER the sample's named-cause assertions (some read siblings the
 * walk hides) and BEFORE `assertFitsViewport` and the capture.
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
        ((cs.display === 'flex' || cs.display === 'inline-flex') && cs.flexDirection.startsWith('column'))
      if (stacksVertically) {
        let sibling = node.previousElementSibling
        while (sibling) {
          ;(sibling as HTMLElement).style.setProperty('display', 'none', 'important')
          sibling = sibling.previousElementSibling
        }
      }
      node = parent
    }
    root.scrollTop = 0
  })
}
