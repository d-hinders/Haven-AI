import type { ReactNode } from 'react'

/**
 * A dialog screen's action pair: secondary then primary, in markup order, each
 * taking half the body width — the one footer rule for a multi-screen dialog
 * (`docs/product/design-system.md` § Dialog actions).
 *
 * - From `sm` up: one row, equal halves, aligned to the body edges, secondary
 *   left and primary right.
 * - Below `sm`: stacked, primary on top and both full width. Two 140px halves
 *   at 375px wrapped labels like "Set agent budget" onto two lines; stacking
 *   gives every label the full width. `flex-col-reverse` puts the primary on
 *   top without reordering the markup, so the desktop Tab order (secondary,
 *   then primary) still matches what is on screen there. Below `sm` Tab and
 *   reading order reach the lower secondary first — the accepted cost, since
 *   reordering the markup would break the desktop order instead.
 *
 * Children are `Button`s at the default `md` size (40px) with `flex-1`; this
 * owns only the layout. A screen with a single action renders a full-width
 * primary instead and does not need this.
 *
 * Below `sm` the children are reset to `flex-none`: in a column, `flex-1`'s
 * zero basis is a zero HEIGHT, and with no free space to grow into it
 * collapsed the 40px buttons to their text line (caught in the 375px render).
 * The column's default stretch gives them the full width.
 */
export function DialogActions({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div data-dialog-actions="" className={`flex flex-col-reverse gap-3 max-sm:[&>*]:flex-none sm:flex-row sm:items-center ${className}`}>
      {children}
    </div>
  )
}
