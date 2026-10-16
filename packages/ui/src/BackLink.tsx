import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { Icon } from './Icon'

export type BackLinkProps = {
  /** The parent page this link returns to. */
  href: string
  /** The parent's name only — "Agents", never "Back to Agents" (#4027). */
  label: string
  className?: string
}

/**
 * The one way back from a detail page (#4028, epic #4027).
 *
 * It sits above the page title. `PageHeader` renders it for its `back` prop,
 * and a branch that has no `PageHeader` (a loading skeleton, a not-found card,
 * the merchant page's bespoke header) renders it directly, so every state of
 * a detail page has the same way back.
 *
 * Drawn at text height (about 20px) so it costs the title almost no vertical
 * room on a phone. The hit area is extended to 44px by a transparent
 * `::after`, the same mechanism `Button`'s small sizes use (#1726). Vertical
 * only: the label already makes the target wide enough, and nothing sits
 * beside it.
 *
 * `text-[13px]` matches the top-bar back link it replaces, so moving it into
 * the page changes where it is, not how it reads.
 */
export function BackLink({ href, label, className = '' }: BackLinkProps) {
  return (
    <Link
      href={href}
      className={`group relative -ml-1 inline-flex items-center gap-1.5 rounded-md px-1 text-[13px] font-medium leading-5 text-[var(--v2-ink-2)] transition-colors hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] ${className}`}
    >
      <Icon
        icon={ChevronLeft}
        className="h-3.5 w-3.5 text-[var(--v2-ink-3)] transition-colors group-hover:text-[var(--v2-ink-2)]"
      />
      <span>{label}</span>
    </Link>
  )
}

export default BackLink
