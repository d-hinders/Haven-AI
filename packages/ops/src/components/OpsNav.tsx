'use client'

/**
 * The console's primary navigation (#3516). The shell wraps every page, so
 * the nav rides the shell's `children` render — one header, five pages.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { OPS_NAV_ITEMS } from '../lib/nav'

export function OpsNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Console pages" className="flex flex-wrap items-center gap-1 border-b border-[var(--v2-border)]">
      {OPS_NAV_ITEMS.map((item) => {
        const active = item.match(pathname)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`px-3 py-2 text-sm transition-colors ${
              active
                ? 'border-b-2 border-[var(--v2-brand)] font-medium text-[var(--v2-ink)]'
                : 'border-b-2 border-transparent text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]'
            }`}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
