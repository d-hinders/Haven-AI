import type { ReactNode } from 'react'

/**
 * The heading block of a detail-page section (#4475): the `v2-text-h3` title
 * ABOVE the card, an optional description and note under it, and an optional
 * trailing `action` on the heading's own line.
 *
 * The detail-page section rule (`docs/product/design-system.md` § *Detail-page
 * section rule*) put a heading and a one-line description above the card with
 * no action slot, and `SettingsSection` took `title` / `description` / `note`
 * only. The account Security tab (#4474) needs one section whose heading
 * carries a link to the fuller surface ("View all"), so the slot lands here
 * once and `SettingsSection` composes it — settings call sites are unchanged.
 *
 * `action` is a LINK, not a button: it navigates to the fuller surface, it
 * never acts on the section's content. The caller passes a Next `Link` styled
 * as a text link (`text-sm font-medium text-[var(--v2-brand)] hover:underline`
 * plus the one focus ring from § *Focus rings*); the primitive holds no copy
 * and no href of its own.
 *
 * Layout: the heading and the link share one `flex-wrap` row, baseline
 * aligned, with the link trailing. Below `sm` — or whenever the heading is
 * long enough to fill the row — the link wraps onto its own line under the
 * heading, left aligned, so a phone never squeezes the heading to make room.
 *
 * The heading keeps the heading-to-card gap (`mb-3`) when there is no prose
 * (#4476); a description or note supplies it with its own `mb-3` instead. The
 * component renders a FRAGMENT, not a wrapper: the heading, the prose and the
 * card stay siblings inside the caller's `<section>`, which is what the
 * settings e2e specs and `screenshot.mjs` locate by.
 */
export function SectionHeading({
  title,
  description,
  note,
  action,
}: {
  title: string
  description?: string
  /** A quieter second paragraph under the description — a responsibility line, not a second description. */
  note?: string
  /** A trailing link on the heading's line — navigation to the fuller surface, never a button. */
  action?: ReactNode
}) {
  const hasProse = Boolean(description || note)
  const heading = (
    <h2 className={`v2-text-h3 text-[var(--v2-ink)]${hasProse ? '' : ' mb-3'}`}>{title}</h2>
  )

  return (
    <>
      {action ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {heading}
          <div className="shrink-0">{action}</div>
        </div>
      ) : (
        heading
      )}
      {description ? (
        <p className="mt-0.5 mb-3 text-sm text-[var(--v2-ink-2)]">{description}</p>
      ) : null}
      {note ? <p className="mt-0.5 mb-3 text-xs text-[var(--v2-ink-3)]">{note}</p> : null}
    </>
  )
}

export default SectionHeading
