import type { ReactNode } from 'react'

export type DetailListItem = {
  /** The row's label — the `dt`, ink-3, one tier quieter than the value. */
  label: string
  /** The row's value — the `dd`, ink, medium weight. */
  value: ReactNode
  /** An optional helper line under the value, ink-3 (the form steps' field-helper tier, #1431). */
  helper?: string
  /** Optional trailing actions for the row — a Remove, an Edit, a link. */
  actions?: ReactNode
}

/**
 * The divided label/value detail list (#4475): rows of label, value and
 * optional trailing actions, hairline-divided, with the label column stacking
 * over the value below `sm`.
 *
 * This is an EXTRACTION, not an invention. `components/haven/AgentRulesSummary`
 * already shipped exactly this `dl` — `grid gap-1 sm:grid-cols-[160px_1fr]`
 * (`[120px_1fr]` when compact), `divide-y divide-[var(--v2-border)]`, ink-3
 * `dt` over an ink value with an optional ink-3 helper — and the account
 * Security tab (#4474) needs the same list with a trailing-actions column. The
 * owner rule is build once, consume: `AgentRulesSummary` renders through this
 * component, and a third hand-rolled `dl` is not an option.
 *
 * The trailing-actions column is the one thing the extraction adds. It is a
 * third grid track (`auto`) at `sm` and up, right aligned, so the actions sit
 * on the value's line; below `sm` the whole row is one column, so the actions
 * stack under the value with the label above it — the same phone behaviour the
 * label/value pair already had.
 *
 * `density="compact"` narrows the label track to 120px and tightens the row
 * padding — the connect flow's approval step uses it inside a modal.
 *
 * The list owns no outer margin: the caller spaces it (`className`), because
 * the same list sits under a card title in `AgentRulesSummary` and directly in
 * a card elsewhere.
 */
export function DetailList({
  items,
  density = 'normal',
  className = '',
}: {
  items: DetailListItem[]
  density?: 'normal' | 'compact'
  className?: string
}) {
  const compact = density === 'compact'

  return (
    <dl className={`${className ? `${className} ` : ''}divide-y divide-[var(--v2-border)]`}>
      {items.map((item) => {
        // ONE grid-template class per row, never two: two `sm:grid-cols-[…]`
        // utilities on the same element resolve by their order in the compiled
        // stylesheet, not by their order in the class string, so the compact
        // label track would silently lose to the actions track.
        const columns = item.actions
          ? compact
            ? 'sm:grid-cols-[120px_1fr_auto]'
            : 'sm:grid-cols-[160px_1fr_auto]'
          : compact
            ? 'sm:grid-cols-[120px_1fr]'
            : 'sm:grid-cols-[160px_1fr]'
        return (
          <div
            key={item.label}
            className={`${compact ? 'py-2' : 'py-3'} ${columns} grid gap-1 first:pt-0 last:pb-0 sm:gap-4`}
          >
            <dt className="text-xs font-medium text-[var(--v2-ink-3)]">{item.label}</dt>
            <dd>
              <div className="text-sm font-medium text-[var(--v2-ink)]">{item.value}</div>
              {/* Row helpers are ink-3, matching the form steps' field-helper tier
                  (#1431) — the connect Review screen renders both one screen
                  apart. The top DESCRIPTION paragraph stays ink-2: that is body
                  copy, not a helper. */}
              {item.helper && (
                <p className={`${compact ? 'mt-0.5' : 'mt-1'} text-xs leading-relaxed text-[var(--v2-ink-3)]`}>
                  {item.helper}
                </p>
              )}
            </dd>
            {item.actions ? (
              <div className="flex items-center gap-2 sm:justify-end">{item.actions}</div>
            ) : null}
          </div>
        )
      })}
    </dl>
  )
}

export default DetailList
