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
  //
  // `warning-soft` and `danger-soft` are here because a BRAND ring lands on
  // them — the two cases that are easy to miss, since the surface is a
  // different semantic tone from the ring:
  //   - ApprovalNotifications.tsx — the bell is `bg-[var(--v2-warning-soft)]`
  //     whenever `actionableCount > 0`, a static state rather than a hover.
  //   - contacts/page.tsx — "Delete contact" tints `hover:bg-danger-soft`
  //     while its ring stays brand. That mismatch is #1809; until it
  //     lands the pair is real and stays registered. (AgentBudgetCard.tsx was
  //     the other one and moved to a danger ring in #1792.)
  // Both clear the bar today (3.93:1 and 3.95:1). They are registered anyway:
  // an unregistered pair is not "passing", it is UNMEASURED, and would regress
  // silently under any future palette or alpha change.
  brand: ['bg', 'surface', 'surface-2', 'surface-hover', 'brand-soft', 'warning-soft', 'danger-soft'],
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

/**
 * Controls whose OWN fill is opaque brand, and therefore cannot wear an
 * un-offset brand ring: it would composite brand-over-brand and measure ~1.0:1
 * (or ~1.5:1 where the fill is `accent-color`), invisible at any alpha.
 *
 * This is a hand-maintained list because it CANNOT be derived. `BACKGROUNDS`
 * above resolves `--v2-*` background tokens; a fill that arrives via
 * `accent-color`, or only in a checked/active state, is not a background token
 * and never appears as a `bg-` class in the markup. `Checkbox` was exactly
 * that case — it looked like an ordinary sweep line in the diff, passed every
 * registered pair, and was only caught by LOOKING at the rendered crop.
 *
 * So read the guarantee precisely: `BACKGROUNDS` is complete for the pairs it
 * registers, not for the render. This list is the second net for the gap.
 */
/** An opaque brand fill, however it is painted — `bg-`, or `accent-color`. */
const BRAND_FILL = /(?:\bbg-brand\b|bg-\[var\(--v2-brand\)\]|\baccent-brand\b|accent-\[var\(--v2-brand\)\])/

describe('brand-filled controls carry a ring offset (#1741)', () => {
  it('no class string pairs a brand fill with an un-offset brand ring', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(FRONTEND, 'src'))) {
      const text = readFileSync(file, 'utf8')
      // Per class STRING, not per file: a file with several controls must not
      // be excused because one of its other buttons happens to be correct.
      for (const cls of text.match(/[^"'`]*focus-visible:ring-brand\/\d+[^"'`]*/g) ?? []) {
        if (BRAND_FILL.test(cls) && !/focus-visible:ring-offset-2/.test(cls)) {
          offenders.push(`${relative(FRONTEND, file)}: ${cls.trim().slice(0, 80)}…`)
        }
      }
    }
    expect(
      offenders,
      'a brand ring on a brand-FILLED control composites brand-over-brand (~1.0:1) — add ' +
        'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]',
    ).toEqual([])
  })

  it('Button keeps its offset even though its fill is defined apart from its ring', () => {
    // The rule above is co-location-based, so it cannot see `Button`, whose
    // `bg-brand` lives in VARIANT_CLASS while the ring lives in the base
    // string. Asserted separately rather than left as a silent blind spot.
    const button = readFileSync(join(FRONTEND, 'src/components/ui/Button.tsx'), 'utf8')
    expect(button, 'Button primary is brand-filled; its ring must stay offset').toMatch(
      /focus-visible:ring-brand\/\d+ focus-visible:ring-offset-2/,
    )
  })
})

/**
 * A destructive control signals destructive in EVERY state it has (#1792).
 *
 * This guard is about tone, not contrast, and the difference matters for how it
 * is read. `ring-brand/80` on `--v2-danger-soft` measures 3.95:1 — comfortably
 * over the bar, registered in BACKGROUNDS, and #1798's measured assertions were
 * therefore never going to say a word about it. Two identical destructive icon
 * buttons answered "what colour is focus?" two different ways for months
 * precisely because every *measurable* property of both was fine.
 *
 * What makes a control destructive here is its own hover treatment: it tints
 * `--v2-danger-soft` or reddens its glyph to `--v2-danger`. If it says danger on
 * hover it says danger on focus.
 *
 * Scope note, so this does not read as more than it is: it matches within a
 * single class STRING, the same granularity as the brand-fill rule above and for
 * the same reason — a file with several buttons must not be excused because one
 * of its others is correct. Three known limits follow from that, named here so
 * the list is honest rather than ending at the cheapest one:
 *
 *   1. `Button`'s `variant="danger"` — a SOLID `--v2-danger` fill in
 *      `VARIANT_CLASS` against `ring-brand/80` in the base string. The same
 *      co-location split #1798 had to work around for its offset rule, plus a
 *      hover shape (`hover:bg-[var(--v2-danger)]/90`) this regex does not match.
 *      It is the loudest destructive control in the product and it focuses
 *      brand. Not a contrast defect — the base string's `ring-offset-2` puts a
 *      white moat (6.57:1 against the fill) between ring and fill, so the ring
 *      lands on the page at 4.19:1; un-offset it would be 1.08:1. Tracked as
 *      #1817, which is where the `Button`-specific assertion belongs, since a
 *      co-location rule structurally cannot cover it.
 *   2. `DropdownMenu`'s `tone="danger"` item, whose focus indicator is a
 *      background swap rather than a ring — outside a ring rule's domain
 *      entirely.
 *   3. Controls with NO focus ring at all (`Sidebar` logout, `AgentCard`'s
 *      revoke/remove links, #1819). This rule only fires on a class string that
 *      already contains a `focus-visible:ring-*` utility, which is right for a
 *      TONE rule — a missing indicator is a different defect needing its own
 *      guard, not a widened version of this one.
 */
const DESTRUCTIVE_HOVER = /hover:(?:bg-\[var\(--v2-danger-soft\)\]|text-\[var\(--v2-danger\)\])/

/**
 * File-scoped, and it is meant to be deleted rather than grown.
 *
 * `contacts/page.tsx`'s "Delete contact" button has exactly the mismatch this
 * guard exists for. #1792 fixed ONE call-site on purpose — which tone a control
 * should wear is a per-call-site design judgement, and sweeping it would have put
 * "the rule now exists" and "this other button is now red too" in one diff.
 * Filed as #1809; closing that issue means removing this entry, not adding a
 * second one.
 */
const TONE_EXEMPT = ['src/app/(authenticated)/contacts/page.tsx']

describe('destructive controls focus in their own tone (#1792)', () => {
  it('a control that hovers danger does not focus brand', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(FRONTEND, 'src'))) {
      const rel = relative(FRONTEND, file)
      if (TONE_EXEMPT.includes(rel)) continue
      const text = readFileSync(file, 'utf8')
      for (const cls of text.match(/[^"'`]*focus-visible:ring-[a-z]+\/\d+[^"'`]*/g) ?? []) {
        if (!DESTRUCTIVE_HOVER.test(cls)) continue
        const tone = cls.match(/focus-visible:ring-([a-z]+)\/\d+/)?.[1]
        if (tone !== undefined && tone !== 'danger') {
          offenders.push(`${rel}: hovers danger, focuses ${tone}`)
        }
      }
    }
    expect(
      offenders,
      'a destructive control must focus in its own tone — use focus-visible:ring-danger/80',
    ).toEqual([])
  })

  it('the exemption names a file that really is still mismatched', () => {
    // An exemption list that outlives its reason silently licenses the next
    // regression in that file. This asserts the entry is still EARNING its
    // place, so #1809's fix makes this test red until the entry is removed.
    for (const rel of TONE_EXEMPT) {
      const text = readFileSync(join(FRONTEND, rel), 'utf8')
      const mismatched = (text.match(/[^"'`]*focus-visible:ring-[a-z]+\/\d+[^"'`]*/g) ?? []).some(
        (cls) =>
          DESTRUCTIVE_HOVER.test(cls) && cls.match(/focus-visible:ring-([a-z]+)\/\d+/)?.[1] !== 'danger',
      )
      expect(mismatched, `${rel} is exempt but no longer mismatched — drop it from TONE_EXEMPT`).toBe(
        true,
      )
    }
  })

  it('the sibling that was already right stays right', () => {
    // EditAgentModal's "Remove budget" is the reference call-site #1792 was
    // measured against. Named so a future sweep cannot quietly flip it back.
    const modal = readFileSync(join(FRONTEND, 'src/components/EditAgentModal.tsx'), 'utf8')
    expect(modal).toMatch(/hover:bg-\[var\(--v2-danger-soft\)\][^"'`]*focus-visible:ring-danger\/\d+/)
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
