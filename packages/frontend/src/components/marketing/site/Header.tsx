'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { HavenMark } from '@/components/brand/HavenMark'
import { SafeAreaBand } from '@/components/ui/SafeAreaBand'
import { SITE_FONT_VARIABLES } from './fonts'
import { SITE_WRAP } from './SiteSection'

/**
 * The redesigned public header (#3573, epic #3572), rendered by `SiteHeader`
 * when `isNewSiteVisible()` is on.
 *
 * Entries land with their destination (epic rule "Entries land with their
 * page"): How it works exists today; For developers and For agents arrive
 * with their pages in #3577. No Security item, by owner decision.
 */
export const SITE_NAV: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'How it works', href: '/how-it-works' },
]

/**
 * Whether any probe line crosses a dark section — the header's tone rule,
 * kept from the legacy header's `[data-v2-dark-section]` probe and lifted
 * out so it is testable without layout.
 */
export function crossesDarkSection(
  probeYs: ReadonlyArray<number>,
  darkSections: ReadonlyArray<{ top: number; bottom: number }>,
): boolean {
  return darkSections.some((rect) => probeYs.some((y) => rect.top <= y && rect.bottom >= y))
}

function readTone(): 'dark' | 'light' {
  const header = document.querySelector<HTMLElement>('[data-site-header]')
  const rect = header?.getBoundingClientRect()
  const probes = rect ? [rect.top + 8, rect.top + rect.height / 2, rect.bottom + 8] : [28, 56, 72]
  const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-v2-dark-section]')).map(
    (section) => section.getBoundingClientRect(),
  )
  return crossesDarkSection(probes, sections) ? 'dark' : 'light'
}

/**
 * Two tones, decided by what the header sits over, never by the theme:
 *
 * - `light` — over a white or tint ground, or a page with no dark section
 *   (the demo and releases pages). The page's own ground at 95% under theme ink, so
 *   it is legible in both themes.
 * - `dark` — over a fixed navy or indigo band. Fixed ink on a fixed ground
 *   in BOTH themes (#1867): `--v2-ink` flips near-white in the dark palette
 *   and near-black in the light one, and one of those vanishes on the band.
 *
 * `overlay` is the mockup's header: absolutely positioned and transparent
 * over a page's navy hero, scrolling away with it rather than sticking (the
 * mockup's own notes: "transparent over the hero rather than sticky"). The
 * page's hero clears it with its own top padding. Without `overlay` the header
 * is sticky and in the flow — today's behaviour for the demo and releases pages,
 * which have no hero — and the probe switches it to the on-dark treatment
 * while it passes over a dark band.
 */
export function Header({ overlay = false }: { overlay?: boolean }) {
  const [tone, setTone] = useState<'dark' | 'light'>('light')

  useEffect(() => {
    const update = () => setTone(readTone())
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  const dark = tone === 'dark'
  const ground = dark
    ? overlay
      ? 'bg-transparent border-b border-transparent'
      : 'bg-[rgba(14,18,48,0.82)] border-b border-[rgba(255,255,255,0.08)]'
    : 'bg-bg/95 border-b border-[var(--v2-border)]'
  const position = overlay ? 'absolute inset-x-0 top-0' : 'sticky top-0'

  return (
    <header
      data-site-header=""
      data-tone={tone}
      className={`${SITE_FONT_VARIABLES} ${position} z-30 transition-colors duration-200 ${ground}`}
    >
      {/* The installed-app status-bar band, outside the blurred bar (#2819). */}
      <SafeAreaBand className="bg-transparent" />
      <div className="backdrop-blur">
        <div className={`${SITE_WRAP} flex h-[60px] items-center justify-between gap-6`}>
          <Link
            href="/"
            className={`flex items-center gap-[9px] rounded-[4px] [font-family:var(--font-site-display)] text-[17px] font-semibold tracking-[-0.01em] ${
              dark ? 'text-white' : 'text-[var(--v2-ink)]'
            } ${dark ? FOCUS_ON_DARK : FOCUS_ON_LIGHT}`}
          >
            <HavenMark tone={dark ? 'inverse' : 'brand'} className="h-6 w-6" />
            Haven
          </Link>

          <nav
            aria-label="Primary"
            className={`hidden md:flex items-center gap-[26px] text-[14px] ${
              dark ? 'text-[rgba(255,255,255,0.72)]' : 'text-[var(--v2-ink-2)]'
            }`}
          >
            {SITE_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-[4px] transition-colors ${
                  dark ? `hover:text-white ${FOCUS_ON_DARK}` : `hover:text-[var(--v2-ink)] ${FOCUS_ON_LIGHT}`
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-[18px] text-[14px]">
            <Link
              href="/login"
              className={`hidden sm:inline-block rounded-[4px] transition-colors ${
                dark
                  ? `text-[rgba(255,255,255,0.85)] hover:text-white ${FOCUS_ON_DARK}`
                  : `text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] ${FOCUS_ON_LIGHT}`
              }`}
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className={`inline-flex h-9 items-center rounded-md px-3.5 text-[14px] font-medium whitespace-nowrap transition-colors ${
                dark
                  ? `bg-white text-[#0e1230] hover:bg-[#eef2ff] ${FOCUS_ON_DARK}`
                  : `bg-[var(--v2-brand)] text-[var(--v2-ink-on-brand)] hover:bg-[var(--v2-brand-strong)] ${FOCUS_ON_LIGHT}`
              }`}
            >
              Create your account
            </Link>
          </div>
        </div>
      </div>
    </header>
  )
}

// Focus rings follow the tone for the same reason the ink does: a brand ring
// on the navy band sits at ~2.6:1, a white one on a white bar is invisible.
const FOCUS_ON_LIGHT =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]'
const FOCUS_ON_DARK =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e1230]'
