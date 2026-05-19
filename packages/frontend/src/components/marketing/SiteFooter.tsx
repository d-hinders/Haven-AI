import Link from 'next/link'
import { HavenMark } from '@/components/brand/HavenMark'

const COLS = [
  {
    heading: 'Product',
    links: [
      { label: 'How it works', href: '/how-it-works' },
      { label: 'x402', href: '/protocols/x402' },
      { label: 'MPP', href: '/protocols/mpp' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { label: 'About', href: '#' },
      { label: 'Contact', href: '#' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy', href: '#' },
      { label: 'Terms', href: '#' },
    ],
  },
]

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]">
      <div className="max-w-6xl mx-auto px-6 py-14 grid grid-cols-2 md:grid-cols-4 gap-10">
        <div className="col-span-2 md:col-span-1">
          <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold text-[var(--v2-ink)]">
            <HavenMark />
            Haven
          </Link>
          <p className="mt-3 text-[13px] text-[var(--v2-ink-3)] leading-relaxed max-w-[220px]">
            Agent payments within your rules.
          </p>
        </div>

        {COLS.map((col) => (
          <div key={col.heading}>
            <div className="text-[12px] font-medium text-[var(--v2-ink)] mb-3">{col.heading}</div>
            <ul className="space-y-2">
              {col.links.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-[13px] text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--v2-border)]">
        <div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between text-[12px] text-[var(--v2-ink-3)]">
          <span>© {new Date().getFullYear()} Haven Labs</span>
          <span>Built for agent commerce</span>
        </div>
      </div>
    </footer>
  )
}
