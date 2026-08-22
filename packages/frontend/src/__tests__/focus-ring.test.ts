import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { describe, expect, it } from 'vitest'

/**
 * One focus-ring treatment, and it clears WCAG 3:1 (#1741, #1746).
 *
 * Two defects motivate every guard below, and neither was visible in source:
 *
 * 1. **Contrast.** `ring-brand/30` composited over white measures 1.60:1.
 *    WCAG 2.4.11 (Focus Appearance) / 1.4.11 (Non-text Contrast) want 3:1
 *    against the adjacent background. The form-field family was weaker still at
 *    `/20` (1.36:1). A ratio is a property of a COLOUR PAIR, so this file
 *    resolves the compiled ring colour, composites it over each background that
 *    ring actually lands on, and measures — rather than asserting a number from
 *    a token value, which is how "it's roughly fine" survives review.
 *
 * 2. **Dead classes.** Tailwind silently drops an opacity modifier it cannot
 *    re-compose. #1708 removed the `ring-[var(--v2-*)]/N` form; `Toast.tsx`
 *    still carried `ring-current/30`, which fails the same way — `currentColor`
 *    has no channels either — so that ring rendered preflight's blue-500/50 on
 *    all three tones. #1708's guard regex only matched the arbitrary-value
 *    shape, so it could not see the second one. The compile check here is
 *    shape-agnostic: it asks whether a ring colour was EMITTED, whatever the
 *    class looked like.
 */

const FRONTEND = resolve(__dirname, '../..')
const css = readFileSync(join(FRONTEND, 'src/app/globals.css'), 'utf8')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tailwindConfig = require(join(FRONTEND, 'tailwind.config.js'))

/** Booting real Tailwind is a real compile; vitest's 5s default would flake. */
const COMPILE_TIMEOUT = 60_000

/** The one alpha every focus ring uses. See ALPHA_RATIONALE below. */
const FOCUS_ALPHA = 80

/**
 * `/80` is not a taste call — it is the lowest 10%-step alpha at which EVERY
 * (ring colour, background) pair in BACKGROUNDS clears 3:1. The binding pair is
 * `ring-success` on `--v2-success-soft` inside the success toast: 2.99:1 at
 * `/70` — under the bar by a hair — and 3.58:1 at `/80`. Lower the constant and
 * the measured assertion below goes red and names the pair.
 */
const AA_NON_TEXT = 3

// ── colour maths ───────────────────────────────────────────────────────────

type RGB = [number, number, number]

function tokenRgb(name: string): RGB {
  const m = css.match(new RegExp(`--v2-${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!m) throw new Error(`token --v2-${name} not found in globals.css`)
  return [0, 2, 4].map((i) => parseInt(m[1].slice(1 + i, 3 + i), 16)) as RGB
}

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** A translucent ring is composited by the browser before it is perceived. */
function composite(fg: RGB, alpha: number, bg: RGB): RGB {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as RGB
}

// ── the registry ───────────────────────────────────────────────────────────

/**
 * Which backgrounds each ring colour is actually drawn against. This is
 * maintained data, not something derivable from source — a call-site's
 * background can come from a parent, a hover state or a tone variant. Adding a
 * focus ring on a new surface means adding it here; that is the point.
 *
 * The dark entries are the ones that decide the rule "on a dark fill the ring
 * is white, never brand": brand indigo tops out at 2.99:1 on
 * `--v2-surface-code` and 2.58:1 on `--v2-ink` at FULL opacity, so no alpha
 * could ever fix a brand ring there.
 */
const BACKGROUNDS: Record<string, string[]> = {
  // Light product chrome. `brand-soft` is reached via `hover:bg-…-soft` on the
  // several icon buttons that tint on hover while focused.
  brand: ['bg', 'surface', 'surface-2', 'surface-hover', 'brand-soft'],
  // Destructive controls: page surfaces plus the danger toast / disconnect row.
  danger: ['bg', 'surface', 'surface-2', 'danger-soft'],
  // Success toast only.
  success: ['success-soft'],
  // Every dark fill: the code block, the ink toast, the ink skip-link pill, and
  // the brand-filled CTA on the investor briefing.
  white: ['surface-code', 'ink', 'brand'],
}

// ── reading the call-sites ─────────────────────────────────────────────────

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(full)) acc.push(full)
  }
  return acc
}

interface RingUse {
  file: string
  variant: 'focus' | 'focus-visible'
  /** e.g. `ring-brand/80`, `ring-2`, `ring-offset-1` */
  utility: string
}

/**
 * Every `focus:`/`focus-visible:` ring utility in the product source.
 *
 * Deliberately NOT matched: unconditional `ring-*` with no focus variant. Those
 * are decorative halos (EmptyState icon discs, AllowanceBar, FlowCard,
 * RecoveryNudge, the onboarding check icons) — tonal brand tints on matching
 * `-soft` fills, not focus indicators. #1741 scopes them out explicitly and
 * 2.4.11 does not apply to them.
 */
function ringUses(): RingUse[] {
  const re = /\b(focus|focus-visible):(ring-[a-z0-9/[\]()\-.]*[a-z0-9/[\]().])/g
  const out: RingUse[] = []
  for (const file of sourceFiles(join(FRONTEND, 'src'))) {
    const text = readFileSync(file, 'utf8')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      out.push({ file: relative(FRONTEND, file), variant: m[1] as RingUse['variant'], utility: m[2] })
    }
  }
  return out
}

/**
 * The single documented exemption from `focus-visible:`. `layout.tsx`'s skip
 * link is `sr-only` until focused, so it is only ever reachable by keyboard and
 * the two selectors coincide; a dozen sibling `focus:` utilities reveal the
 * pill, and splitting the ring onto a different selector would give one element
 * two focus states. Named here so it stays a decision rather than drift.
 */
const FOCUS_SELECTOR_EXEMPT = ['src/app/(authenticated)/layout.tsx']

async function compileCss(classes: string[]): Promise<string> {
  const result = await postcss([
    tailwindcss({
      content: [{ raw: classes.join(' '), extension: 'html' }],
      corePlugins: { preflight: false },
      theme: tailwindConfig.theme,
    }),
  ]).process('@tailwind utilities;', { from: undefined })
  return result.css
}

/** The `--tw-ring-color` a class compiles to, or null if none was emitted. */
async function compiledRingColor(utility: string): Promise<string | null> {
  const out = await compileCss([utility])
  return out.match(/--tw-ring-color:\s*([^;\n}]+)/)?.[1].trim() ?? null
}

// ── guards ─────────────────────────────────────────────────────────────────

describe('one focus-ring treatment (#1746)', () => {
  const uses = ringUses()

  it('finds the focus rings at all (guards the scanner itself)', () => {
    // Without this, a regex that silently matches nothing turns every
    // assertion below into a vacuous pass over an empty array.
    expect(uses.length).toBeGreaterThan(50)
    expect(new Set(uses.map((u) => u.file)).size).toBeGreaterThan(25)
  })

  it('uses focus-visible:, except the one named exemption', () => {
    const offenders = uses
      .filter((u) => u.variant === 'focus')
      .filter((u) => !FOCUS_SELECTOR_EXEMPT.includes(u.file))
      .map((u) => `${u.file}: focus:${u.utility}`)
    expect(
      offenders,
      'form fields used to fire their ring on mouse click too; use focus-visible: (#1746)',
    ).toEqual([])
  })

  it('is 2px everywhere — no ring-1 stragglers', () => {
    const widths = uses.filter((u) => /^ring-\d+$/.test(u.utility)).map((u) => u.utility)
    expect(new Set(widths), 'every focus ring is ring-2').toEqual(new Set(['ring-2']))
  })

  it('offsets, where used at all, are all ring-offset-2', () => {
    // Offset is deliberately NOT universal: `Row` draws `ring-inset` because a
    // full-bleed row would clip an outset ring, and most icon buttons sit in
    // tight containers. What IS unified is the SIZE — Table/Sidebar/ApprovalQueue
    // each used offset-1 against everything else's offset-2 (#1746).
    const offsets = uses
      .filter((u) => /^ring-offset-\d+$/.test(u.utility))
      .map((u) => `${u.file}: ${u.utility}`)
      .filter((s) => !s.endsWith('ring-offset-2'))
    expect(offsets, 'standardise on ring-offset-2').toEqual([])
  })

  it('uses exactly one alpha across every focus ring', () => {
    const alphas = new Set(
      uses
        .map((u) => u.utility.match(/^ring-[a-z-]+\/(\d+)$/)?.[1])
        .filter((a): a is string => a !== undefined),
    )
    expect(alphas, `every focus ring is /${FOCUS_ALPHA}`).toEqual(new Set([String(FOCUS_ALPHA)]))
  })
})

describe('every focus ring actually compiles to a colour (#1741)', () => {
  // `ring-inset` is structural, not a colour — it sets --tw-ring-inset.
  const STRUCTURAL = new Set(['ring-inset'])
  const coloured = [...new Set(ringUses().map((u) => u.utility))].filter(
    (u) => /^ring-[a-z-]+(\/\d+)?$/.test(u) && !STRUCTURAL.has(u),
  )

  it('emits --tw-ring-color for every colour utility in use', async () => {
    const dead: string[] = []
    for (const utility of coloured) {
      if ((await compiledRingColor(utility)) === null) dead.push(utility)
    }
    expect(
      dead,
      'these compile to a ring WIDTH with no ring COLOUR, so they render preflight blue-500/50',
    ).toEqual([])
  }, COMPILE_TIMEOUT)

  it('REGRESSION: ring-current/N is one of those dead shapes', async () => {
    // Toast.tsx shipped this for months. Reproduced so that reaching for it
    // again is a red test rather than an invisible blue ring.
    expect(await compiledRingColor('ring-current/30')).toBeNull()
    // The bare form is fine — it is only the opacity modifier that cannot be
    // re-composed onto currentColor.
    expect(await compiledRingColor('ring-current')).toBe('currentColor')
  }, COMPILE_TIMEOUT)
})

describe('focus rings clear WCAG 3:1 against the surfaces they land on (#1741)', () => {
  it('measures every registered (ring, background) pair', async () => {
    const failures: string[] = []
    const measured: string[] = []

    for (const [colour, backgrounds] of Object.entries(BACKGROUNDS)) {
      const utility = `ring-${colour}/${FOCUS_ALPHA}`
      const compiled = await compiledRingColor(utility)
      expect(compiled, `${utility} emitted no ring colour`).not.toBeNull()

      // Resolve the compiled value to real channels. Token rings compile to
      // `rgb(var(--v2-x-rgb) / 0.8)`; `white` compiles to literal channels.
      const viaToken = compiled!.match(/var\(--v2-([a-z0-9-]+)-rgb\)\s*\/\s*([\d.]+)/)
      const literal = compiled!.match(/rgb\(\s*(\d+) (\d+) (\d+)\s*\/\s*([\d.]+)/)
      let fg: RGB
      let alpha: number
      if (viaToken) {
        fg = tokenRgb(viaToken[1])
        alpha = Number(viaToken[2])
      } else if (literal) {
        fg = [Number(literal[1]), Number(literal[2]), Number(literal[3])]
        alpha = Number(literal[4])
      } else {
        throw new Error(`could not parse compiled ring colour for ${utility}: ${compiled}`)
      }

      // The compiled alpha must be the alpha we think we shipped — this is what
      // ties the measurement to the real CSS rather than to FOCUS_ALPHA alone.
      expect(alpha, `${utility} compiled to alpha ${alpha}`).toBeCloseTo(FOCUS_ALPHA / 100, 5)

      for (const bgName of backgrounds) {
        const bg = tokenRgb(bgName)
        const ratio = contrast(composite(fg, alpha, bg), bg)
        measured.push(`${utility} on --v2-${bgName} = ${ratio.toFixed(2)}:1`)
        if (ratio < AA_NON_TEXT) {
          failures.push(`${utility} on --v2-${bgName} = ${ratio.toFixed(2)}:1 (needs ${AA_NON_TEXT})`)
        }
      }
    }

    expect(failures, `measured:\n${measured.join('\n')}`).toEqual([])
  }, COMPILE_TIMEOUT)

  it('records why a brand ring may never sit on a dark fill', () => {
    // Not a style preference — an arithmetic ceiling. Even at full opacity the
    // brand hue cannot reach 3:1 on either dark surface, which is why the skip
    // link and CodeBlock use a white ring. If a future palette change lifted
    // these above 3:1 this test would go red and the rule could be revisited.
    for (const dark of ['surface-code', 'ink']) {
      const solidBrand = contrast(tokenRgb('brand'), tokenRgb(dark))
      expect(solidBrand, `--v2-brand on --v2-${dark} reached ${solidBrand.toFixed(2)}:1`).toBeLessThan(
        AA_NON_TEXT,
      )
      const solidWhite = contrast(tokenRgb('bg'), tokenRgb(dark))
      expect(solidWhite, `white ring on --v2-${dark}`).toBeGreaterThanOrEqual(AA_NON_TEXT)
    }
  })
})
