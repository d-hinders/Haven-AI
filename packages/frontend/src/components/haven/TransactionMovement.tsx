import type { ReactNode } from 'react'

/**
 * "From <a> → To <b>" — the shared movement line for a payment.
 *
 * The arrow is BOUND to the `From` half rather than being a wrap opportunity
 * of its own (#1774). Three sibling flex items give the browser two wrap
 * points, and below roughly 150px of container the second one is the only one
 * that fits — so the arrow landed alone on its own line, between the two
 * things it exists to join:
 *
 *     From Operating          From Operating wallet →
 *     →                 ->    To api.vendor.com
 *     To api.example.dev
 *
 * Measured before the change: `/transactions` at 390px rendered the movement
 * in a 106px activity cell as 3 lines / 72px with the arrow alone at y=453;
 * the `/design-system` showcase rows were worse still (3 lines / 176px). It is
 * NOT a viewport problem — the same shape appears at a 1280px viewport in the
 * showcase's 137.8px `From / To` column — so it is deliberately fixed with
 * nesting rather than a `sm:`/`md:` breakpoint, which cannot see the container.
 *
 * The nested wrapper is a flex ROW with the default `flex-nowrap`, so the
 * arrow and the `From` text can never be separated onto different lines, while
 * `gap-x-2` inside it reproduces the outer gap exactly — at any width wide
 * enough for one line the rendering is unchanged, pixel for pixel.
 */
export function TransactionMovement({
  from,
  to,
  bare = false,
}: {
  from: ReactNode
  to: ReactNode
  /**
   * Drop the visible "From"/"To" words (#4266): a ledger subline reads
   * "My account → Reserve" after the actor, where the words would repeat
   * what the arrow says. The arrow then carries the direction for screen
   * readers too, as an sr-only "to"; the wrap binding is unchanged.
   */
  bare?: boolean
}) {
  if (bare) {
    return (
      // Each name may shrink to an ellipsis (#4266 design review): the
      // ledger's compact subline is a one-line `truncate` box, and an
      // inline box that cannot shrink is hard-clipped there, mid-word.
      <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="flex min-w-0 max-w-full items-end gap-x-1.5">
          <span className="min-w-0 truncate">{from}</span>
          <span aria-hidden="true" className="shrink-0">
            →
          </span>
          <span className="sr-only">to</span>
        </span>
        <span className="min-w-0 max-w-full truncate">{to}</span>
      </span>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {/* `items-end`, not `items-center`: when the container is too narrow to
          hold `From <a> →` on one line the `From` half wraps internally, and a
          centred arrow then floats at the mid-height of a two-line block with
          nothing beside it. Aligned to the end it sits next to the last line
          of the value it points away from. On a single line both are
          identical — the two items have the same line box — so nothing moves
          at any width wide enough not to wrap. */}
      <span className="flex min-w-0 items-end gap-x-2">
        <span className="min-w-0">
          <span className="text-[var(--v2-ink-3)]">From </span>
          <span className="font-medium text-[var(--v2-ink)]">{from}</span>
        </span>
        {/* `shrink-0` so the arrow keeps its own width in a starved row rather
            than being squeezed to a sliver — the `w-8`/width-0 trap from
            #1749. It is decorative: `From` and `To` carry the direction in
            words, which is why hiding it was an option and why losing it to a
            shrink would be silent rather than obviously broken. */}
        <span aria-hidden="true" className="shrink-0 text-[var(--v2-ink-3)]">
          →
        </span>
      </span>
      <span className="min-w-0">
        <span className="text-[var(--v2-ink-3)]">To </span>
        <span className="font-medium text-[var(--v2-ink)]">{to}</span>
      </span>
    </span>
  )
}
