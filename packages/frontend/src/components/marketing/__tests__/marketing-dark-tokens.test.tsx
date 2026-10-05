import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrandBandButton } from '../BrandBandButton'

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
 *   - the fixed-on-fixed pairing (the white band CTA) must keep its fixed
 *     ink class rather than drifting back to `--v2-ink`, which flips
 *     near-white in the dark palette.
 *
 * The legacy chrome's own cases (the hero backdrop's wash, the resting and
 * dark-section header, the live-payment card) went with that chrome in the
 * switch-over (#3579); the redesigned header's dark-band behaviour is pinned
 * in `site/__tests__/site-chrome.test.tsx`.
 */

const FRONTEND = resolve(__dirname, '../../../..')
// The marketing-canvas tokens moved to @haven_ai/ui (#3508): tokens.css lives
// in packages/ui/src, imported by the app layout before globals.css.
const css = readFileSync(resolve(FRONTEND, '../ui/src/tokens.css'), 'utf8')

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

  it('the band CTA keeps a fixed ink on its fixed white fill', () => {
    const { container } = render(
      <BrandBandButton href="/signup">Create your account</BrandBandButton>,
    )
    const link = container.querySelector('a') as HTMLElement
    expect(link.className).toContain('text-[#1a1f36]')
    expect(link.className).not.toContain('text-[var(--v2-ink)]')
  })
})
