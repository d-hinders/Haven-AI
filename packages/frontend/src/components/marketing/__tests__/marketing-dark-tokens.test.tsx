import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HeroBackdrop } from '../HeroBackdrop'
import { SiteHeader } from '../SiteHeader'
import { BrandBandButton } from '../BrandBandButton'
import { FlowCard } from '../FlowCard'

/**
 * The marketing surface joined the dark token system (#3139).
 *
 * The five marketing routes ride the same token palettes as the product app,
 * but their shared chrome hard-coded a light canvas while its text rode theme
 * tokens — a dark-scheme visitor got near-white headline ink on an always-white
 * wash. The #2929 dark-mode sweep never covered this surface because
 * `design-lint` exempts marketing, so nothing could go red when the paint and
 * the ink diverged. These assertions are the headless equivalent for exactly
 * that divergence:
 *
 *   - the wash and the dot grid must read TOKENS, not hard-coded whites
 *     (the shapes that put dark ink on a light page);
 *   - the dark forms of those tokens must exist in BOTH dark declaration
 *     blocks of globals.css, byte-identically — the same invariant
 *     `theme-tokens.test.ts` holds for the rest of the palette;
 *   - the fixed-on-fixed pairings (dark-band header, white band CTA) must
 *     keep their fixed ink classes rather than drifting back to `--v2-ink`,
 *     which flips near-white in the dark palette.
 */

const FRONTEND = resolve(__dirname, '../../../..')
const css = readFileSync(join(FRONTEND, 'src/app/globals.css'), 'utf8')

/** The `{ … }` body of the first block whose selector contains `opener`. */
function blockBody(opener: string): string {
  const at = css.indexOf(opener)
  expect(at, `globals.css: block not found: ${opener}`).toBeGreaterThanOrEqual(0)
  const openBrace = css.indexOf('{', at)
  let depth = 0
  for (let i = openBrace; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) return css.slice(openBrace + 1, i)
    }
  }
  throw new Error(`globals.css: unbalanced braces in block: ${opener}`)
}

const WASH_LIGHT =
  'linear-gradient(180deg, rgba(255, 255, 255, 0.88) 0%, rgba(255, 255, 255, 0.96) 72%, #ffffff 100%)'
const WASH_DARK =
  'linear-gradient(180deg, rgba(26, 31, 46, 0.88) 0%, rgba(25, 29, 44, 0.96) 72%, #191d2c 100%)'
const DOT_LIGHT = 'rgba(26, 31, 54, 0.08)'
const DOT_DARK = 'rgba(212, 220, 236, 0.07)'

describe('the marketing canvas tokens resolve per theme (#3139)', () => {
  it('the light palette declares the white wash and the dark-dot on light ink', () => {
    const root = blockBody(':root {')
    expect(root).toContain(`--v2-marketing-canvas-wash: ${WASH_LIGHT};`)
    expect(root).toContain(`--v2-marketing-dot: ${DOT_LIGHT};`)
  })

  it('both dark declaration blocks carry the byte-identical dark forms', () => {
    for (const opener of [
      ':root:not([data-theme="light"]) {',
      ':root[data-theme="dark"] {',
    ]) {
      const block = blockBody(opener)
      expect(block, `${opener} misses the dark wash`).toContain(
        `--v2-marketing-canvas-wash: ${WASH_DARK};`,
      )
      expect(block, `${opener} misses the dark dot`).toContain(
        `--v2-marketing-dot: ${DOT_DARK};`,
      )
    }
  })

  it('HeroBackdrop paints the wash and dot tokens, never a hard-coded white ground', () => {
    const { container } = render(<HeroBackdrop />)
    const wash = container.querySelector('.v2-mesh-drift') as HTMLElement
    expect(wash).not.toBeNull()
    expect(wash.style.background).toContain('var(--v2-marketing-canvas-wash)')
    expect(wash.style.background).not.toContain('#ffffff')
    expect(wash.style.background).not.toContain('rgba(255,255,255')

    const dots = container.querySelector('[style*="22px 22px"]') as HTMLElement
    expect(dots).not.toBeNull()
    expect(dots.style.backgroundImage).toContain('var(--v2-marketing-dot)')
    expect(dots.style.backgroundImage).not.toContain('rgba(26, 31, 54')
  })

  it('the resting header ground is the page token, not a fixed white bar', () => {
    const { container } = render(<SiteHeader />)
    const header = container.querySelector('[data-v2-header]') as HTMLElement
    expect(header.className).toContain('bg-bg/95')
    expect(header.className).not.toContain('bg-white/95')
  })

  it('the dark-section header keeps its fixed white ink over the fixed band', () => {
    // `useState(false)` renders the resting state; the fixed-ink classes of the
    // dark state are asserted in source so a drift back to a theme token —
    // which flips near-white in the dark palette — cannot ship silently.
    const source = readFileSync(join(FRONTEND, 'src/components/marketing/SiteHeader.tsx'), 'utf8')
    expect(source).toContain("onDarkSection ? 'text-white' : 'text-[var(--v2-ink)]'")
  })

  it('the band CTA keeps a fixed ink on its fixed white fill', () => {
    const { container } = render(
      <BrandBandButton href="/signup">Create your account</BrandBandButton>,
    )
    const link = container.querySelector('a') as HTMLElement
    expect(link.className).toContain('text-[#1a1f36]')
    expect(link.className).not.toContain('text-[var(--v2-ink)]')
  })

  it('the live-payment card fill is the theme ground, not hard-coded white', () => {
    const { container } = render(<FlowCard />)
    const card = container.querySelector('.rounded-\\[14px\\]') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.className).toContain('bg-bg')
    expect(card.className).not.toContain('bg-white')
  })
})
