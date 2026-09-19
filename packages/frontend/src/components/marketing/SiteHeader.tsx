'use client'

import Link from 'next/link'
import { SafeAreaBand } from '@/components/ui/SafeAreaBand'
import { useEffect, useState } from 'react'
import { HavenMark } from '@/components/brand/HavenMark'
import { Button } from '../ui/Button'

const NAV = [
  { label: 'How it works', href: '/how-it-works' },
  { label: 'x402', href: '/protocols/x402' },
  { label: 'MPP', href: '/protocols/mpp' },
]

export function SiteHeader() {
  const [onDarkSection, setOnDarkSection] = useState(false)

  useEffect(() => {
    const updateHeaderTone = () => {
      const header = document.querySelector<HTMLElement>('[data-v2-header]')
      const rect = header?.getBoundingClientRect()
      const probePoints = rect
        ? [rect.top + 8, rect.top + rect.height / 2, rect.bottom + 8]
        : [28, 56, 72]
      const darkSections = Array.from(document.querySelectorAll<HTMLElement>('[data-v2-dark-section]'))
      setOnDarkSection(
        darkSections.some((section) => {
          const rect = section.getBoundingClientRect()
          return probePoints.some((probeY) => rect.top <= probeY && rect.bottom >= probeY)
        }),
      )
    }

    updateHeaderTone()
    window.addEventListener('scroll', updateHeaderTone, { passive: true })
    window.addEventListener('resize', updateHeaderTone)
    return () => {
      window.removeEventListener('scroll', updateHeaderTone)
      window.removeEventListener('resize', updateHeaderTone)
    }
  }, [])

  return (
    <header
      data-v2-header
      style={onDarkSection ? { backgroundColor: 'rgba(30, 27, 75, 0.88)' } : undefined}
      className={`sticky top-0 z-30 transition-colors duration-200 ${
        onDarkSection
          ? 'border-b border-transparent shadow-none'
          : 'bg-bg/95 border-b border-[var(--v2-border)]'
      }`}
    >
      {/*
        The two states split by THEME CLASS, not by light/dark page (#3139):

        - Non-dark-section ground was `bg-white/95` — a fixed light bar under
          token-driven ink, so dark-theme nav vanished whenever the header was
          NOT over a dark band. It is now the page's own background at 95%
          (`bg-bg/95`), and the ink rides the theme tokens as it always did.

        - The dark-section branch keeps its fixed indigo ground and fixed
          white ink in BOTH themes — it is the intentionally-dark band
          treatment (#1867): `--v2-ink` flips near-white in the dark palette
          and would vanish on the band, while in the LIGHT theme the ink would
          sit near-black on it. Fixed-on-fixed is what makes mid-scroll legible
          over the dark band in either theme. The mark stays tone-conditional
          for the mirror reason: in the light theme the brand mark on that band
          sits at ~2.6:1, which is why `inverse` exists.
      */}
      <SafeAreaBand className="bg-transparent" />
      <div className="backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link
            href="/"
            className={`flex items-center gap-2 text-[15px] font-semibold tracking-tight transition-colors ${
              onDarkSection ? 'text-white' : 'text-[var(--v2-ink)]'
            }`}
          >
            <HavenMark tone={onDarkSection ? 'inverse' : 'brand'} />
            Haven
          </Link>

          <nav
            className={`hidden md:flex items-center gap-7 text-[14px] font-medium transition-colors ${
              onDarkSection ? 'text-white' : 'text-[var(--v2-ink)]'
            }`}
          >
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={onDarkSection ? 'hover:text-white transition-colors' : 'hover:text-[var(--v2-ink)] transition-colors'}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className={`hidden sm:inline-block text-[14px] font-medium transition-colors ${
                onDarkSection ? 'text-white hover:text-white/85' : 'text-[var(--v2-ink)] hover:text-[var(--v2-brand)]'
              }`}
            >
              Sign in
            </Link>
            <Button href="/signup" size="sm">Create your account</Button>
          </div>
        </div>
      </div>
    </header>
  )
}
