import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blocksFromCss, contrastRowsFromCss } from '../../../scripts/contrast-check.mjs'
import { THEME_TOKENS, CONTRAST_PAIRS, contrastTable } from '../theme-tokens'

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
 * colour — which is exactly how the 39-token inventory arises: the 20 hex
 * tokens with `-rgb` twins, plus the 19 twin-less whole-value colours.
 */

const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')

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
    expect(lightColours.length).toBeGreaterThanOrEqual(39)
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
