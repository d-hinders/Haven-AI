import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { describe, expect, it } from 'vitest'

/**
 * Alpha-capable colour tokens + the brand focus ring (#1708).
 *
 * The bug this file exists to prevent: Tailwind v3 cannot apply an opacity
 * modifier to a theme colour whose value is a bare `var()`. There are no
 * channels to re-compose, so the utility is dropped from the compiled output —
 * no error, no warning, no class. `focus-visible:ring-2 focus-visible:ring-…/30`
 * therefore set a ring WIDTH with no ring COLOUR, and `--tw-ring-color` stayed
 * at Tailwind's preflight default of `rgb(59 130 246 / 0.5)`. Every focus ring
 * in Haven rendered blue-500/50 instead of brand indigo, across 68 call-sites,
 * for as long as nobody diffed the compiled CSS.
 *
 * A class that silently compiles to nothing is invisible to typecheck, to lint
 * and to review, so the guards below assert against the COMPILED CSS produced by
 * the real `tailwind.config.js` rather than against the source that feeds it.
 */

const FRONTEND = resolve(__dirname, '../..')
const css = readFileSync(join(FRONTEND, 'src/app/globals.css'), 'utf8')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tailwindConfig = require(join(FRONTEND, 'tailwind.config.js'))

/**
 * Booting Tailwind is a real compile, not a string match — a few seconds each
 * on a loaded machine, and vitest's 5s default turns that into a flake rather
 * than a finding.
 */
const COMPILE_TIMEOUT = 60_000

/** Compile a set of classes through the REAL theme and return the CSS. */
async function compile(classes: string[], themeColors?: unknown): Promise<string> {
  const result = await postcss([
    tailwindcss({
      content: [{ raw: classes.join(' '), extension: 'html' }],
      corePlugins: { preflight: false },
      theme: themeColors
        ? { extend: { colors: themeColors as Record<string, unknown> } }
        : tailwindConfig.theme,
    }),
  ]).process('@tailwind utilities;', { from: undefined })
  return result.css
}

function hexToChannels(hex: string): string {
  return [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16)).join(' ')
}

/** Every `--v2-<name>-rgb: R G B;` declared in globals.css. */
function channelTokens(): Array<{ name: string; channels: string }> {
  const out: Array<{ name: string; channels: string }> = []
  const re = /--v2-([a-z0-9-]+)-rgb:\s*([0-9]{1,3} [0-9]{1,3} [0-9]{1,3});/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) out.push({ name: m[1], channels: m[2] })
  return out
}

describe('channel tokens stay in sync with their hex originals (#1708)', () => {
  it('declares at least the palette the Tailwind theme consumes', () => {
    // A floor, not an inventory: it fails loudly if the block is deleted or
    // gutted, without forcing an edit every time a colour is added.
    expect(channelTokens().length).toBeGreaterThanOrEqual(20)
  })

  it('every --v2-<name>-rgb triplet equals its --v2-<name> hex', () => {
    for (const { name, channels } of channelTokens()) {
      const hex = css.match(new RegExp(`--v2-${name}:\\s*(#[0-9a-fA-F]{6})`))
      // The hex form is the source of truth — token-contrast.test.ts reads it.
      expect(hex, `--v2-${name} has a channel form but no #RRGGBB hex form`).not.toBeNull()
      expect(channels, `--v2-${name}-rgb drifted from --v2-${name} (${hex![1]})`).toBe(
        hexToChannels(hex![1].toLowerCase()),
      )
    }
  })

  it('keeps every hex declaration in #RRGGBB form for token-contrast.test.ts', () => {
    // That suite regex-parses `--v2-<name>: #RRGGBB` out of this same file.
    // Replacing a hex with its channel form would make the colour invisible to
    // the WCAG contrast guard instead of failing it. Checked for EVERY colour
    // that has a channel form, not a hand-picked subset — a spot-check would
    // miss exactly the token nobody thought to list.
    const missing = channelTokens()
      .map((t) => t.name)
      .filter((name) => !new RegExp(`--v2-${name}:\\s*#[0-9a-f]{6};`).test(css))
    expect(missing, 'these tokens lost their #RRGGBB form; token-contrast.test.ts reads it').toEqual(
      [],
    )
  })
})

describe('the Tailwind colour theme is alpha-capable (#1708)', () => {
  /** Flatten the theme's `colors` into [path, value] pairs. */
  function themeColorEntries(): Array<[string, string]> {
    const entries: Array<[string, string]> = []
    const walk = (node: unknown, path: string) => {
      if (typeof node === 'string') return entries.push([path, node])
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k)
      }
    }
    walk(tailwindConfig.theme.extend.colors, '')
    return entries
  }

  it('no colour is a bare var() — that is the shape that drops the modifier', () => {
    for (const [path, value] of themeColorEntries()) {
      expect(value, `colors.${path} is a bare var(); opacity modifiers on it compile to nothing`)
        .not.toMatch(/^var\(/)
      expect(value, `colors.${path} must carry the <alpha-value> placeholder`).toContain(
        '<alpha-value>',
      )
    }
  })

  it('every channel token the theme references is declared in globals.css', () => {
    for (const [path, value] of themeColorEntries()) {
      const ref = value.match(/var\((--v2-[a-z0-9-]+-rgb)\)/)
      expect(ref, `colors.${path} does not read a --v2-*-rgb channel token`).not.toBeNull()
      expect(css, `${ref![1]} (colors.${path}) is not declared in globals.css`).toContain(
        `${ref![1]}:`,
      )
    }
  })
})

describe('compiled CSS: the focus ring is brand-derived (#1708)', () => {
  it('ring-brand/30 sets --tw-ring-color from the brand channel token', async () => {
    const out = await compile(['focus-visible:ring-2', 'focus-visible:ring-brand/30'])
    expect(out).toContain('--tw-ring-color: rgb(var(--v2-brand-rgb) / 0.3)')
  }, COMPILE_TIMEOUT)

  it('covers every ring token this slice converted', async () => {
    const cases: Array<[string, string, string]> = [
      ['ring-brand/20', '--v2-brand-rgb', '0.2'],
      ['ring-danger/30', '--v2-danger-rgb', '0.3'],
      ['ring-warning/10', '--v2-warning-rgb', '0.1'],
      ['ring-success/10', '--v2-success-rgb', '0.1'],
      ['ring-border/40', '--v2-border-rgb', '0.4'],
    ]
    for (const [cls, token, alpha] of cases) {
      const out = await compile([cls])
      expect(out, `${cls} did not compile a ring colour`).toContain(
        `--tw-ring-color: rgb(var(${token}) / ${alpha})`,
      )
    }
  }, COMPILE_TIMEOUT)

  it('covers every border token this slice converted (#1709)', async () => {
    // The 91 border-* call-sites reduce to five base tokens. One case per
    // token, at an alpha actually used in the tree, so a token silently losing
    // its channel form fails here rather than rendering no border in the app.
    const cases: Array<[string, string, string]> = [
      ['border-brand/30', '--v2-brand-rgb', '0.3'],
      ['border-danger/20', '--v2-danger-rgb', '0.2'],
      ['border-warning/25', '--v2-warning-rgb', '0.25'],
      ['border-success/20', '--v2-success-rgb', '0.2'],
      ['border-debit/30', '--v2-debit-rgb', '0.3'],
    ]
    for (const [cls, token, alpha] of cases) {
      const out = await compile([cls])
      expect(out, `${cls} did not compile a border colour`).toContain(
        `border-color: rgb(var(${token}) / ${alpha})`,
      )
    }
  }, COMPILE_TIMEOUT)

  it('a BRACKETED opacity compiles too — the form every grep in #1685 missed (#1709)', async () => {
    // entityCardStyles.ts carried `bg-[var(--v2-brand)]/[0.03]`. The epic's
    // census, #1710's enumeration and #1710's acceptance criterion all match
    // `/[0-9]+`, which cannot match `/[` — so this one instance was invisible
    // to the count and would have outlived the epic. Pinned here so the
    // bracketed form is known to work, not merely assumed to.
    const out = await compile(['bg-brand/[0.03]'])
    expect(out).toContain('background-color: rgb(var(--v2-brand-rgb) / 0.03)')
  }, COMPILE_TIMEOUT)

  it('solid usages are unchanged — bg/text/border render the token at full opacity', async () => {
    const out = await compile(['bg-brand', 'text-brand', 'border-border', 'bg-surface'])
    expect(out).toContain('background-color: rgb(var(--v2-brand-rgb) / var(--tw-bg-opacity, 1))')
    expect(out).toContain('color: rgb(var(--v2-brand-rgb) / var(--tw-text-opacity, 1))')
    expect(out).toContain('border-color: rgb(var(--v2-border-rgb) / var(--tw-border-opacity, 1))')
    expect(out).toContain('background-color: rgb(var(--v2-surface-rgb) / var(--tw-bg-opacity, 1))')
  }, COMPILE_TIMEOUT)

  it('REGRESSION: the old bare-var() form compiles to no ring colour at all', async () => {
    // Not a hypothetical. This is the exact shape that shipped 68 dead classes,
    // reproduced here so that reintroducing it is a red test rather than a
    // silently blue focus ring.
    const out = await compile(['focus-visible:ring-2', 'focus-visible:ring-[var(--v2-brand)]/30'], {
      brand: { DEFAULT: 'var(--v2-brand)' },
    })
    // The WIDTH utility does compile — and it *references* --tw-ring-color…
    expect(out).toContain('--tw-ring-shadow:')
    // …but nothing ever ASSIGNS it, so it keeps preflight's blue-500/50.
    expect(out).not.toMatch(/--tw-ring-color:/)
  }, COMPILE_TIMEOUT)
})

/**
 * The two source-scanning guards that lived here are GONE (#1710).
 *
 * `no dead ring-* or border-* call-sites remain` (#1708, widened by #1709) and
 * `no bracketed-alpha-on-var() call-sites remain` (#1709) both matched raw
 * source text for the dead shape. `compiled-colour-utilities.test.ts` (#1818)
 * replaced them with something strictly stronger on every axis:
 *
 *   - it scans ALL of src/, not just the two dirs design-lint walks;
 *   - it covers every colour-bearing utility, not ring/border;
 *   - it accepts a bracketed alpha as well as a numeric one;
 *   - it strips comments, which a raw-text scan cannot — and that is not
 *     hypothetical: in #1709 an explanatory comment quoting the dead form
 *     tripped the very guard it was explaining, and a sweep script later
 *     rewrote a different comment into a false claim;
 *   - it decides by COMPILING the class, so it catches a token that exists but
 *     has no channel form — a shape no regex over call-sites can see.
 *
 * Keeping both would have meant two mechanisms for one defect, with the weaker
 * one producing the false positives. The COMPILE PROBES above stay: they assert
 * an alias resolves to the right token at the right alpha, which is a different
 * claim from "this compiles to something".
 */
