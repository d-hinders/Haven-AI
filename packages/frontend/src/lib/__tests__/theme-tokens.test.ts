import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blocksFromCss, contrastRowsFromCss } from '../../../scripts/contrast-check.mjs'
import { THEME_TOKENS, CONTRAST_PAIRS, contrastTable, type TokenSpec } from '../theme-tokens'

/**
 * The token contract of the two palettes (#2927).
 *
 * globals.css is the source of truth; this suite makes the claims about it
 * that the issue fixes as acceptance:
 *
 *   - every colour-valued token of `:root` is redeclared in BOTH dark blocks
 *     with identical values, and no token exists only in a dark block;
 *   - the two dark declaration sets are byte-identical (same names, same
 *     order, same values);
 *   - `color-scheme` is declared in all three blocks;
 *   - the THEME_TOKENS data table (what /design-system renders) cannot drift
 *     from the CSS by a single value;
 *   - every acceptance contrast pair clears its threshold in both themes.
 *
 * Colour-value detector, stated once: a declaration is colour-valued when
 * its whole value is a hex literal or a single colour function
 * (`rgb`/`rgba`/`hsl`/`hsla`/`oklch`/`oklab`/`lab`/`lch`/`hwb`/`color`/
 * `color-mix`). Composite values (shadows, gradients, `env()` insets,
 * `calc()`) are NOT colour-valued — a shadow contains rgba() but is not a
 * colour — which is exactly how the 45-token inventory arises: the 26 hex
 * tokens with `-rgb` twins, plus the 19 twin-less whole-value colours
 * (measured with this detector on the #3658 branch).
 */

// The palette moved to @haven_ai/ui (#3508): tokens.css lives in
// packages/ui/src, imported by the app layout before globals.css.
const css = readFileSync(resolve(__dirname, '../../../../ui/src/tokens.css'), 'utf8')

/** blocksFromCss is untyped .mjs; this is its real shape. */
function cssBlocks(): Record<string, Record<string, string>> {
  return blocksFromCss(css) as unknown as Record<string, Record<string, string>>
}

const COLOUR_VALUE =
  /^#[0-9a-fA-F]{3,8}$|^(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix)\([\s\S]+\)$/

describe('the three palette blocks of globals.css', () => {
  const blocks = cssBlocks()

  function colourValued(block: Record<string, string>): string[] {
    return Object.entries(block)
      .filter(([name, value]) => name.startsWith('--v2-') && COLOUR_VALUE.test(value))
      .map(([name]) => name)
  }

  it('every colour-valued token in :root is redeclared in both dark blocks', () => {
    const lightColours = colourValued(blocks.light)
    // 44 since #3670 removed --v2-chain-gnosis (45 after #3658/#3674).
    expect(lightColours.length).toBeGreaterThanOrEqual(44)
    for (const darkName of ['mediaDark', 'explicitDark'] as const) {
      const dark = blocks[darkName]
      for (const name of lightColours) {
        // "Identical values" means identical BETWEEN the two dark blocks —
        // asserted by the byte-identical test below. Here: present, period.
        expect(dark[name], `${name} missing from the ${darkName} block`).toBeDefined()
      }
    }
  })

  it('no token exists only in a dark block', () => {
    for (const darkName of ['mediaDark', 'explicitDark'] as const) {
      for (const name of colourValued(blocks[darkName])) {
        expect(blocks.light[name], `${name} exists only in the ${darkName} block`).toBeDefined()
      }
    }
  })

  it('the two dark declaration sets are byte-identical', () => {
    // The exact declaration list (name + value, in file order) of the
    // media-gated block must equal the explicit block's, so a future edit
    // cannot update one and silently leave the other.
    const serialise = (block: Record<string, string>) =>
      Object.entries(block)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n')
    expect(serialise(blocks.mediaDark)).toBe(serialise(blocks.explicitDark))
  })

  it('color-scheme is set in all three blocks', () => {
    expect(blocks.light['color-scheme']).toBe('light')
    expect(blocks.mediaDark['color-scheme']).toBe('dark')
    expect(blocks.explicitDark['color-scheme']).toBe('dark')
  })
})

describe('THEME_TOKENS is pinned to the CSS (the /design-system data cannot drift)', () => {
  const blocks = cssBlocks()

  it('every entry matches the CSS value for both themes', () => {
    for (const token of THEME_TOKENS) {
      const name = `--v2-${token.name}`
      expect(blocks.light[name], `${name} light value drifted`).toBe(token.light)
      expect(blocks.explicitDark[name], `${name} dark value drifted`).toBe(token.dark)
    }
  })

  it('covers exactly the colour-valued tokens of :root — nothing missing, nothing extra', () => {
    const fromCss = Object.entries(cssBlocks().light)
      .filter(([name, value]) => name.startsWith('--v2-') && COLOUR_VALUE.test(value))
      .map(([name]) => name.slice('--v2-'.length))
      .sort()
    const fromData = THEME_TOKENS.map((t) => t.name).sort()
    expect(fromData).toEqual(fromCss)
  })

  it('the acceptance pair list references known tokens', () => {
    const names = new Set(THEME_TOKENS.map((t) => t.name))
    for (const pair of CONTRAST_PAIRS) {
      expect(names.has(pair.fg), `pair fg ${pair.fg} is not a token`).toBe(true)
      expect(names.has(pair.bg), `pair bg ${pair.bg} is not a token`).toBe(true)
    }
  })
})

describe('contrast acceptance — scripts/contrast-check.mjs against the real CSS', () => {
  it('every acceptance pair clears its threshold in both themes', () => {
    const rows = contrastRowsFromCss(css)
    expect(rows).toHaveLength(CONTRAST_PAIRS.length * 2)
    const failed = rows.filter((r) => !r.pass)
    expect(
      failed.map((r) => `${r.fg} on ${r.bg} (${r.theme}): ${r.ratio} < ${r.min}`),
      'pairs below threshold',
    ).toEqual([])
  })

  it('the vitest-side table (theme-tokens.ts) and the script-side parser agree on every ratio', () => {
    const scriptRows = new Map(
      contrastRowsFromCss(css).map((r) => [`${r.fg}/${r.bg}/${r.theme}`, r.ratio]),
    )
    for (const row of contrastTable()) {
      const key = `${row.pair.fg}/${row.pair.bg}/${row.theme}`
      expect(scriptRows.get(key), `${key} measured differently by the two parsers`).toBe(row.ratio)
    }
  })
})

describe('the avatar tints (#4066)', () => {
  /**
   * CIE 1976 ΔE — coarse, but monotone and dependency-free, and the bar it
   * enforces here (≥10) is far above anything a JND-scale slip could blur.
   */
  function deltaE(a: string, b: string): number {
    const lab = (hex: string): [number, number, number] => {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
      const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      const [R, G, B] = [lin(r), lin(g), lin(b)]
      const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047
      const y = 0.2126 * R + 0.7152 * G + 0.0722 * B
      const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883
      const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
      const [fx, fy, fz] = [f(x), f(y), f(z)]
      return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
    }
    const [L1, a1, b1] = lab(a)
    const [L2, a2, b2] = lab(b)
    return Math.sqrt((L1 - L2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2)
  }

  const AVATAR_INKS = [1, 2, 3, 4, 5, 6].map((n) => `avatar-${n}`)
  const AVATAR_SOFTS = [1, 2, 3, 4, 5, 6].map((n) => `avatar-${n}-soft`)
  // The families an avatar must never be mistaken for: the chart series and
  // the status/brand colours — the showcase rule is "by name, never a status
  // or series colour", so the hexes have to back that up.
  const FORBIDDEN = [
    ...[1, 2, 3, 4, 5, 6].map((n) => `series-${n}`),
    'success',
    'success-soft',
    'debit',
    'debit-soft',
    'warning',
    'warning-soft',
    'danger',
    'danger-soft',
    'brand',
    'brand-soft',
  ]

  function tokenValues(names: string[], theme: 'light' | 'dark'): string[] {
    const values = names.map((name) => {
      const spec = THEME_TOKENS.find((t) => t.name === name)
      expect(spec, `${name} missing from THEME_TOKENS`).toBeDefined()
      return (spec as TokenSpec)[theme]
    })
    for (const v of values) expect(v, 'avatar tokens must be opaque #RRGGBB').toMatch(/^#[0-9a-f]{6}$/)
    return values
  }

  it('the six soft grounds are pairwise separable from the six inks, in both themes', () => {
    // The family exists to be told apart: a stated minimum colour difference
    // (CIE76 ΔE) for every pair of grounds and every pair of inks, per theme.
    const MIN_DE = 10
    for (const theme of ['light', 'dark'] as const) {
      for (const family of [tokenValues(AVATAR_SOFTS, theme), tokenValues(AVATAR_INKS, theme)]) {
        for (let i = 0; i < family.length; i++) {
          for (let j = i + 1; j < family.length; j++) {
            const dE = deltaE(family[i]!, family[j]!)
            expect(
              dE,
              `${family[i]} vs ${family[j]} (${theme}): ΔE ${dE.toFixed(1)} < ${MIN_DE}`,
            ).toBeGreaterThanOrEqual(MIN_DE)
          }
        }
      }
    }
  })

  it('every avatar hex is disjoint from every series and semantic hex, in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const forbidden = new Set(tokenValues(FORBIDDEN, theme))
      for (const name of [...AVATAR_INKS, ...AVATAR_SOFTS]) {
        const value = (THEME_TOKENS.find((t) => t.name === name) as TokenSpec)[theme]
        expect(
          forbidden.has(value),
          `${name} (${theme}, ${value}) collides with a series/status hex`,
        ).toBe(false)
      }
    }
  })
})
