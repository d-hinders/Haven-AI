import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { act, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Header, SITE_NAV, crossesDarkSection } from '../Header'
import { Footer, SITE_FOOTER_COLUMNS } from '../Footer'
import { SITE_NAVY, SiteSection } from '../SiteSection'
import { ProductFrame, FrameControl } from '../ProductFrame'

/**
 * The redesigned public site's shared chrome (#3573, epic #3572).
 */

const SRC = join(__dirname, '..', '..', '..', '..')

afterEach(() => {
  vi.unstubAllEnvs()
  document.documentElement.removeAttribute('data-theme')
  document.body.innerHTML = ''
})

describe('header entries', () => {
  it('carries only entries whose destination exists today', () => {
    render(<Header />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['How it works', '/how-it-works'],
      ['For developers', '/developers'],
      ['For agents', '/for-agents'],
    ])
    expect(SITE_NAV.map((item) => item.label)).not.toContain('Security')
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    expect(screen.getByRole('link', { name: /Create your account/ })).toHaveAttribute('href', '/signup')
  })

  it('gives both header actions the 44px hit area and a short CTA label on phones (#1726)', () => {
    render(<Header />)
    for (const link of [
      screen.getByRole('link', { name: 'Sign in' }),
      screen.getByRole('link', { name: /Create your account/ }),
    ]) {
      expect(link.className).toContain('after:h-11')
      expect(link.className).toContain('relative')
    }
    const cta = screen.getByRole('link', { name: /Create your account/ })
    expect(within(cta).getByText('Sign up').className).toContain('sm:hidden')
    expect(within(cta).getByText('Create your account').className).toContain('hidden sm:inline')
  })

  it('keeps the installed-app safe-area band as the header’s first child (#2819)', () => {
    render(<Header />)
    const header = document.querySelector('[data-site-header]')!
    const band = header.firstElementChild as HTMLElement
    expect(band.className).toContain('--v2-safe-top')
    expect(band.className).not.toContain('backdrop-blur')
  })
})

/**
 * The header's tone is decided by what it sits over, never by the theme. The
 * four cases the issue names: a page with no dark section and a page scrolled
 * over a dark band, each in the light and the dark theme.
 */
describe('header legibility: four cases', () => {
  function rect(top: number, bottom: number): DOMRect {
    return { top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }
  }

  function mountOver(withDarkSection: boolean) {
    if (withDarkSection) {
      const band = document.createElement('section')
      band.setAttribute('data-v2-dark-section', '')
      band.getBoundingClientRect = () => rect(0, 600)
      document.body.appendChild(band)
    }
    const view = render(<Header />)
    const header = document.querySelector<HTMLElement>('[data-site-header]')!
    header.getBoundingClientRect = () => rect(0, 60)
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    return { header, view }
  }

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme} theme, no dark section: theme ink on the page's own ground`, () => {
      document.documentElement.setAttribute('data-theme', theme)
      const { header } = mountOver(false)
      expect(header.dataset.tone).toBe('light')
      expect(header.className).toContain('bg-bg/95')
      const brand = within(header).getByRole('link', { name: 'Haven' })
      expect(brand.className).toContain('text-[var(--v2-ink)]')
      expect(within(header).getByRole('link', { name: /Create your account/ }).className).toContain(
        'bg-[var(--v2-brand)]',
      )
      const mark = brand.querySelector('svg')!
      expect(mark.querySelector('rect')!.getAttribute('class')).toBe('fill-[var(--v2-brand)]')
      expect(mark.querySelector('path')!.getAttribute('stroke')).toBe('white')
    })

    it(`${theme} theme, over a dark section: fixed white ink on a fixed navy ground`, () => {
      document.documentElement.setAttribute('data-theme', theme)
      const { header } = mountOver(true)
      expect(header.dataset.tone).toBe('dark')
      expect(header.className).toContain('bg-[rgba(14,18,48,0.82)]')
      const brand = within(header).getByRole('link', { name: 'Haven' })
      expect(brand.className).toContain('text-white')
      expect(brand.className).not.toContain('var(--v2-ink)')
      const cta = within(header).getByRole('link', { name: /Create your account/ })
      expect(cta.className).toContain('bg-white')
      expect(cta.className).toContain('text-[#0e1230]')
      // The mockup's mark over navy (#3586, site.css:53): a solid white tile,
      // navy ink, no translucent `inverse` tile.
      const mark = brand.querySelector('svg')!
      const tile = mark.querySelector('rect')!.getAttribute('class')!.split(/\s+/)
      expect(tile).toEqual(['fill-white'])
      expect(tile).not.toContain('fill-white/20')
      expect(tile).not.toContain('stroke-white/30')
      expect(mark.querySelector('path')!.getAttribute('stroke')).toBe(SITE_NAVY)
    })
  }

  it('the probe crosses a band only where a probe line falls inside it', () => {
    expect(crossesDarkSection([8, 30, 68], [])).toBe(false)
    expect(crossesDarkSection([8, 30, 68], [{ top: 0, bottom: 600 }])).toBe(true)
    expect(crossesDarkSection([8, 30, 68], [{ top: 70, bottom: 600 }])).toBe(false)
    expect(crossesDarkSection([8, 30, 68], [{ top: -600, bottom: 5 }])).toBe(false)
  })

  it('an overlay header is transparent over a dark hero and does not stick (mockup notes)', () => {
    const band = document.createElement('section')
    band.setAttribute('data-v2-dark-section', '')
    band.getBoundingClientRect = () => rect(0, 600)
    document.body.appendChild(band)
    render(<Header overlay />)
    const header = document.querySelector<HTMLElement>('[data-site-header]')!
    expect(header.dataset.tone).toBe('dark')
    expect(header.className).toContain('bg-transparent')
    expect(header.className).toContain('absolute')
    expect(header.className).not.toContain('sticky')
  })
})

describe('footer legal line', () => {
  it('reads "© <current year> Haven Labs" (owner decision 16, #3586)', () => {
    render(<Footer />)
    const footer = document.querySelector('footer')!
    const line = `© ${new Date().getFullYear()} Haven Labs`
    expect(within(footer).getByText(line).textContent).toBe(line)
  })
})

describe('footer entries', () => {
  it('has no placeholder link and no entry without a destination', () => {
    render(<Footer />)
    const footer = document.querySelector('footer')!
    const hrefs = Array.from(footer.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs.length).toBeGreaterThan(0)
    expect(hrefs).not.toContain('#')
    for (const label of ['Contact', 'About', 'Privacy', 'Terms', 'Security']) {
      expect(within(footer).queryByRole('link', { name: label })).toBeNull()
    }
  })

  it('renders every column entry, with static files as plain anchors', () => {
    render(<Footer />)
    const footer = document.querySelector('footer')!
    for (const link of SITE_FOOTER_COLUMNS.flatMap((column) => column.links)) {
      expect(within(footer).getByRole('link', { name: link.label })).toHaveAttribute('href', link.href)
    }
  })
})

describe('section grounds', () => {
  it('navy and indigo are dark sections with fixed ink; white and tint are themed', () => {
    render(
      <>
        {(['white', 'tint', 'navy', 'indigo'] as const).map((ground) => (
          <SiteSection key={ground} ground={ground}>
            {ground}
          </SiteSection>
        ))}
      </>,
    )
    const of = (ground: string) => document.querySelector<HTMLElement>(`[data-site-ground="${ground}"]`)!
    expect(of('white').hasAttribute('data-v2-dark-section')).toBe(false)
    expect(of('tint').hasAttribute('data-v2-dark-section')).toBe(false)
    expect(of('navy').hasAttribute('data-v2-dark-section')).toBe(true)
    expect(of('indigo').hasAttribute('data-v2-dark-section')).toBe(true)
    expect(of('white').className).toContain('bg-[var(--v2-bg)]')
    expect(of('tint').className).toContain('bg-[var(--v2-surface)]')
    expect(of('white').className).toContain('[--site-ink:var(--v2-ink)]')
    expect(of('navy').className).toContain('[--site-ink:#ffffff]')
    expect(of('indigo').className).toContain('[--site-ink:#ffffff]')
  })
})

describe('product frame', () => {
  it('names its environment and screen, and its body cannot be operated', () => {
    render(
      <ProductFrame env="Operations" screen="Dashboard">
        <FrameControl variant="primary">Receive</FrameControl>
      </ProductFrame>,
    )
    expect(screen.getByText('Operations')).toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    const body = document.querySelector('[data-product-frame-body]')!
    expect(body.hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('the public-site fonts stay on the public site', () => {
  it('only new-site components import the site fonts', () => {
    const importers: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(path)
        } else if (/\.tsx?$/.test(entry.name) && /from '[^']*site\/fonts'|from '\.\/fonts'/.test(readFileSync(path, 'utf8'))) {
          importers.push(relative(SRC, path))
        }
      }
    }
    walk(SRC)
    expect(importers.length, 'the sweep found the header it must cover').toBeGreaterThan(0)
    // `components/auth/` is new-site chrome too (#3578): the auth shell
    // carries the site font variables like every other new-site root, but it
    // lives outside `marketing/site/` on purpose — design-lint exempts only
    // `marketing/` and `brand/` (#874), so the auth surface stays under the
    // product token gates where an authentication screen belongs.
    const ALLOWED = [join('components', 'marketing', 'site'), join('components', 'auth')]
    for (const file of importers) {
      expect(ALLOWED.some((dir) => file.startsWith(dir)), file).toBe(true)
    }
  })

  it('the root layout still loads Inter only', () => {
    const layout = readFileSync(join(SRC, 'app', 'layout.tsx'), 'utf8')
    expect(layout).toContain("import { Inter } from 'next/font/google'")
    expect(layout).not.toMatch(/Inter_Tight|JetBrains_Mono|site\/fonts/)
  })
})
