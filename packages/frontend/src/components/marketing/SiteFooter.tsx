import Link from 'next/link'

const FOOTER_LINKS = [
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Protocols', href: '/protocols' },
]

export function SiteFooter() {
  return (
    <>
      <div className="border-t border-white/[0.06]" />
      <footer className="max-w-6xl mx-auto px-6 py-8 relative z-10">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <span className="block text-sm font-semibold mb-1 bg-gradient-to-r from-white to-indigo-200 bg-clip-text text-transparent">
              Haven
            </span>
            <span className="text-xs text-zinc-600">© 2026 Haven. Built on Safe & Gnosis Chain.</span>
          </div>
          <div className="flex flex-wrap gap-6">
            {FOOTER_LINKS.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="text-xs text-zinc-500 hover:text-[#ededed] transition-colors duration-200"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </footer>
    </>
  )
}
