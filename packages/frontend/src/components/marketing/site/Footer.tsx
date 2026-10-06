import Link from 'next/link'
import { HavenMark } from '@/components/brand/HavenMark'
import { SITE_FONT_VARIABLES } from './fonts'
import { SITE_WRAP } from './SiteSection'

/**
 * The public footer (#3573, epic #3572).
 *
 * Every entry has a destination that exists today (epic rule "No dead
 * links"). The mockup's Company column (Contact, Privacy, Terms) is removed
 * until those destinations exist (epic decisions 8 and 9). Protocols joined
 * with its page (#3576); For developers, For agents and npm packages joined
 * with theirs (#3577).
 *
 * `static: true` marks a file served from `public/` or by an API route, not
 * an app route: client-side navigation would 404 it, so it renders as a
 * plain `<a>`.
 *
 * "For agents" points at the new page (#3577). It is one of the landing
 * page's agent-discovery hooks (#2521, #2538): `discovery-surfaces.test.ts`
 * follows it and requires it to reach `/for-agents.md` — now by way of the
 * page, which links the runbook in its hero.
 */
export const SITE_FOOTER_COLUMNS: ReadonlyArray<{
  heading: string
  links: ReadonlyArray<{ label: string; href: string; static?: boolean }>
}> = [
  {
    heading: 'Product',
    links: [
      { label: 'How it works', href: '/how-it-works' },
      { label: 'Protocols', href: '/how-it-works/protocols' },
      { label: 'Create your account', href: '/signup' },
      { label: 'Sign in', href: '/login' },
    ],
  },
  {
    heading: 'Developers',
    links: [
      { label: 'For developers', href: '/developers' },
      { label: 'For agents', href: '/for-agents' },
      { label: 'API reference', href: '/api/openapi.json', static: true },
      { label: 'npm packages', href: '/developers#packages' },
    ],
  },
]

const LINK_CLASS =
  'rounded-[4px] transition-colors hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]'

export function Footer() {
  return (
    <footer
      className={`${SITE_FONT_VARIABLES} border-t border-[var(--v2-border)] bg-[var(--v2-bg)] py-12 text-[13.5px] text-[var(--v2-ink-3)]`}
    >
      <div className={SITE_WRAP}>
        <div className="grid grid-cols-2 gap-8 md:grid-cols-[2fr_1fr_1fr]">
          <div className="col-span-2 md:col-span-1">
            <Link
              href="/"
              className={`inline-flex items-center gap-[9px] [font-family:var(--font-site-display)] text-[17px] font-semibold tracking-[-0.01em] text-[var(--v2-ink)] ${LINK_CLASS}`}
            >
              <HavenMark className="h-6 w-6" />
              Haven
            </Link>
            <p className="mt-3 max-w-[30ch]">Agent payments within your rules.</p>
          </div>

          {SITE_FOOTER_COLUMNS.map((column) => (
            <div key={column.heading}>
              <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--v2-ink-2)]">
                {column.heading}
              </h2>
              <ul className="grid gap-2">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {link.static ? (
                      <a href={link.href} className={LINK_CLASS}>
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href} className={LINK_CLASS}>
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap justify-between gap-2.5 border-t border-[var(--v2-border)] pt-5 text-[12.5px]">
          <span>© {new Date().getFullYear()} Haven Labs</span>
          <span>Non-custodial smart-account software. Haven never holds funds or keys.</span>
        </div>
      </div>
    </footer>
  )
}
