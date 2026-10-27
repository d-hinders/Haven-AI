import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Icon } from '@haven_ai/ui/Icon'

/**
 * An account-link pill (#4472): an outline `rounded-full` pill wrapping a
 * Next `Link`, with a trailing lucide `ArrowRight` — the shape the approved
 * Settings mockup (epic #4356, Security tab, note 4) draws for each account a
 * passkey approves. It is a NAVIGATION link to an object, so it carries no
 * status and no copy of its own: the caller passes `href` and the visible
 * label as `children`, and the accessible name is exactly that text (the
 * arrow is decorative, `aria-hidden` through `Icon`'s default).
 *
 * Why it is its own primitive rather than a `Link` around a `StatusBadge`
 * (`AccountingBadge`, `components/accounting/AccountingBadge.tsx`): that one
 * is a filled STATUS pill — the tint says what state the payment is in — and
 * it is not a documented pattern. The other pills in the system are not
 * controls either: `LabelChip` is a filled categorisation pill, and
 * `FilterPill` / `ListToolbar`'s status-row chips are filter toggles. This is
 * the one outline pill that navigates. Recorded in
 * `docs/product/design-system.md` § *Account link pill* and on
 * `/design-system`.
 *
 * The arrow comes from lucide through `Icon`, never a raw `→`
 * (design-system.md § *Arrows*: the raw-arrow allowlist holds exactly one
 * file). `truncate` keeps a long account name inside the pill instead of
 * turning the stadium into a wrapped blob — the same rule `StatusBadge`
 * carries (#2147) — and the icon is `shrink-0` so it never collapses.
 */
export function LinkChip({
  href,
  children,
  className = '',
}: {
  href: string
  children: ReactNode
  className?: string
}) {
  return (
    <Link
      href={href}
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border border-[var(--v2-border)] px-2.5 py-1 text-xs font-medium text-[var(--v2-ink-2)] transition-colors hover:border-[var(--v2-border-strong)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 ${className}`}
    >
      {children}
      <Icon icon={ArrowRight} className="h-3 w-3 shrink-0" />
    </Link>
  )
}

export default LinkChip
