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
}: {
  from: ReactNode
  to: ReactNode
}) {
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
