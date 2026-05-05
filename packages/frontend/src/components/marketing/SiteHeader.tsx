import Link from 'next/link'

const NAV_LINKS = [
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Protocols', href: '/protocols' },
]

export function SiteHeader() {
  return (
    <nav className="sticky top-0 z-50 border-b border-white/[0.06] backdrop-blur-md bg-[#0a0a0a]/80">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link
          href="/"
          className="text-[15px] font-semibold tracking-tight bg-gradient-to-r from-white to-indigo-200 bg-clip-text text-transparent"
        >
          Haven
        </Link>
        <div className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="text-sm text-zinc-500 hover:text-[#ededed] transition-colors duration-200"
            >
              {link.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="text-sm text-zinc-400 hover:text-[#ededed] transition-colors duration-200"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="text-sm px-4 py-1.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
          >
            Get Early Access
          </Link>
        </div>
      </div>
    </nav>
  )
}
