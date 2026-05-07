'use client'

import Link from 'next/link'
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
      className={`sticky top-0 z-30 backdrop-blur transition-colors duration-200 ${
        onDarkSection
          ? 'bg-[#1e1b4b]/88 border-b border-transparent shadow-none'
          : 'bg-white/95 border-b border-[var(--v2-border)]'
      }`}
    >
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
          <Button href="/signup" size="sm">Get early access</Button>
        </div>
      </div>
    </header>
  )
}
