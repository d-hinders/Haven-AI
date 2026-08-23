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

/**
 * The scanning guards re-read every `.ts`/`.tsx` file under `src/` and run
 * several regexes over each one. That lands around 2.3s on an idle machine —
 * inside vitest's 5s default, but only 2x clear of it, and this repo's agent
 * sessions routinely run at load average 200+. Measured under that load the same
 * three tests took 8.5–13.4s and failed as TIMEOUTS, which is the worst possible
 * failure mode for a guard: it looks exactly like the defect it hunts for, on a
 * PR that did not cause it. Found while mutation-testing #1817, where a mutation
 * to one constant produced two unrelated "failures" in tests that never read it.
 *
 * So the budget is explicit and generous. These tests are I/O-bound file walks
 * whose *duration* is not the property under test — only their verdict is.
 */
const SCAN_TIMEOUT = 60_000

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
  // `warning-soft` is here because a BRAND ring lands on it — the case that is
  // easy to miss, since the surface is a different semantic tone from the ring:
  // ApprovalNotifications.tsx's bell is `bg-[var(--v2-warning-soft)]` whenever
  // `actionableCount > 0`, a static state rather than a hover. It clears the bar
  // today (3.93:1) and is registered anyway: an unregistered pair is not
  // "passing", it is UNMEASURED, and would regress silently under any future
  // palette or alpha change.
  //
  // `danger-soft` STAYS, and the reason it nearly did not is the most useful
  // thing in this file.
  //
  // It was originally registered for two icon buttons that tinted danger on
  // hover while their ring stayed brand. #1792 fixed one and #1809 the other, so
  // #1809 asked for this entry to be deleted as "its last real call-site". That
  // premise was wrong, and a grep could not have shown it: the surviving
  // call-site is `ApprovalQueue.tsx:289`, whose reject-confirmation panel is a
  // `bg-[var(--v2-danger-soft)]` CONTAINER holding a `<Button variant="ghost">`
  // ("Keep request") that carries `ring-brand/80`. Tab to it and a brand ring
  // renders on `danger-soft` at 3.95:1.
  //
  // The background arrives from a PARENT, not from the control's own class
  // string, so every hover-based grep over `hover:bg-[var(--v2-danger-soft)]`
  // structurally cannot see it — the same shape of blindness #1741 recorded for
  // `Checkbox`'s `accent-color` fill, one level up the tree instead of one level
  // down. It is exactly what the header above means by "a call-site's background
  // can come from a parent". Caught in review, not by the sweep that deleted it.
  //
  // So the standing rule holds in both directions: a registered pair that no
  // longer renders is stale data dressed as coverage — but "I grepped the
  // control's own classes" is not evidence that it no longer renders.
  brand: [
    'bg',
    'surface',
    'surface-2',
    'surface-hover',
    'brand-soft',
    'warning-soft',
    'danger-soft',
  ],
  // Destructive controls: page surfaces, the danger toast / disconnect row, the
  // icon buttons that tint `danger-soft` on hover, and — since #1817 — `Button`'s
  // solid-danger variant, whose ring lands on `bg` because of its offset.
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

/**
 * `Button` is exempt from the CO-LOCATION rule below and covered by the
 * dedicated assertion beside it instead. This is not a hole — it is the price of
 * #1817, paid deliberately and in one place.
 *
 * #1817 split the ring: its COLOUR is per-variant and lives in `VARIANT_CLASS`
 * beside the fill (so the tone rule can see the pair), while its GEOMETRY —
 * width, offset, offset colour — stays uniform in the base template string. The
 * `primary` variant therefore pairs a brand fill with a brand ring inside one
 * class string whose offset lives in a *different* declaration, which is exactly
 * the shape this rule flags and exactly the shape #1817 intends.
 *
 * The offset is not going unchecked: `Button keeps its offset…` below asserts it
 * directly, and deleting `ring-offset-2` from the base string turns that test
 * red. Mutation-proven in #1817's PR rather than asserted here.
 */
const BRAND_FILL_OFFSET_EXEMPT = ['src/components/ui/Button.tsx']

describe('brand-filled controls carry a ring offset (#1741)', () => {
  it('no class string pairs a brand fill with an un-offset brand ring', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(FRONTEND, 'src'))) {
      if (BRAND_FILL_OFFSET_EXEMPT.includes(relative(FRONTEND, file))) continue
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
  }, SCAN_TIMEOUT)

  it('Button keeps its offset even though its fill is defined apart from its ring', () => {
    // The rule above is co-location-based. #1817 moved Button's ring COLOUR into
    // VARIANT_CLASS beside the fill, but its ring GEOMETRY — width, offset,
    // offset colour — stays uniform in the base template string, so the two are
    // still declared apart and this assertion is still the only thing holding
    // the offset. It is now two claims, checked separately rather than as one
    // adjacency regex over a string that no longer contains both:
    //   (a) the base string still carries ring-offset-2, and
    //   (b) primary is still the brand-filled variant that needs it.
    // Without the offset, brand-on-brand composites to ~1.0:1 (#1741).
    const button = readFileSync(join(FRONTEND, 'src/components/ui/Button.tsx'), 'utf8')
    const base = button.match(/const classes = `[^`]*`/)?.[0] ?? ''
    expect(base, 'Button base class string not found — did Button.tsx get restructured?').not.toEqual(
      '',
    )
    expect(base, 'Button is brand-filled; its ring must stay offset').toMatch(
      /focus-visible:ring-2 focus-visible:ring-offset-2/,
    )
    const variants = button.match(/const VARIANT_CLASS[^}]+}/)?.[0] ?? ''
    expect(variants, 'primary is the brand-filled variant the offset protects').toMatch(
      /primary:\s*\n?\s*'[^']*bg-\[var\(--v2-brand\)\][^']*focus-visible:ring-brand\/\d+/,
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
 * of its others is correct.
 *
 * **#1817 shrank this rule's blind spot rather than working around it.** The
 * exception used to be `Button`'s `variant="danger"`: a SOLID `--v2-danger` fill
 * in `VARIANT_CLASS` against `ring-brand/80` in the base template string. A
 * per-class-string rule structurally cannot pair those, so the fix was to move
 * the ring COLOUR next to the fill in `VARIANT_CLASS` — which makes `Button`
 * an ordinary call-site this rule reads like any other, instead of a permanent
 * exemption with a bespoke assertion beside it. The hover shape was widened to
 * match the solid `hover:bg-[var(--v2-danger)]` form at the same time; it has
 * exactly one call-site in the product and no false positives.
 *
 * There is still a dedicated `Button` assertion below, and it is NOT redundant:
 * it pins the co-location itself, so moving the ring colour back to the base
 * string to "deduplicate" it fails loudly rather than silently restoring the
 * blind spot. Two assertions, two different claims.
 *
 * One known limit remains, named here so the list is honest rather than ending
 * at the cheapest entry:
 *
 *   1. `DropdownMenu`'s `tone="danger"` item, whose focus indicator is a
 *      background swap rather than a ring — outside a *ring* rule's domain
 *      entirely. It is not unguarded: the indicator rule below covers it, and
 *      deliberately accepts a `focus-visible:bg-` swap as a valid indicator.
 *
 * The other limit this comment used to carry — controls with NO focus ring at
 * all — is gone, because #1819 built the guard for it rather than widening this
 * one. That was the right split: this rule only fires on a class string that
 * ALREADY contains a `focus-visible:ring-*` utility, which is correct for a TONE
 * rule and structurally blind to an absent indicator. Two rules, two questions:
 * this one asks "what colour", the one below asks "is there one at all".
 */
const DESTRUCTIVE_HOVER =
  /hover:(?:bg-\[var\(--v2-danger(?:-soft)?\)\]|text-\[var\(--v2-danger\)\])/

describe('destructive controls focus in their own tone (#1792)', () => {
  it('a control that hovers danger does not focus brand', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(FRONTEND, 'src'))) {
      const rel = relative(FRONTEND, file)
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
  }, SCAN_TIMEOUT)

  it('the rule now covers every destructive call-site, with no exemptions', () => {
    // #1792 shipped a `TONE_EXEMPT` list holding `contacts/page.tsx`, plus an
    // assertion that the entry was still EARNING its place — so that fixing
    // #1809 would turn the suite red until the exemption was deleted. #1809 is
    // fixed here and the list is gone, which is that mechanism working as
    // designed rather than an assertion being quietly dropped.
    //
    // What replaces it: the scanner must still be looking at something. An
    // exemption list that shrinks to zero and a regex that silently matches
    // nothing produce the same green, so assert the population is non-empty.
    const destructive: string[] = []
    for (const file of sourceFiles(join(FRONTEND, 'src'))) {
      const text = readFileSync(file, 'utf8')
      for (const cls of text.match(/[^"'`]*focus-visible:ring-[a-z]+\/\d+[^"'`]*/g) ?? []) {
        if (DESTRUCTIVE_HOVER.test(cls)) destructive.push(relative(FRONTEND, file))
      }
    }
    expect(
      new Set(destructive).size,
      'the destructive-control scan matched nothing — the rule above is passing vacuously',
    ).toBeGreaterThanOrEqual(4)
  }, SCAN_TIMEOUT)

  it('Button keeps its ring colour beside its fill, where the rule can see it', () => {
    // #1817. This is NOT a duplicate of the general rule above — that rule now
    // covers Button only BECAUSE fill and ring share one class string. This
    // assertion pins that arrangement, so moving the colour back into the base
    // template string to deduplicate it fails here rather than silently
    // restoring the blind spot that hid the defect for months.
    const button = readFileSync(join(FRONTEND, 'src/components/ui/Button.tsx'), 'utf8')
    const variants = button.match(/const VARIANT_CLASS[^}]+}/)?.[0] ?? ''
    expect(variants, 'VARIANT_CLASS not found — did Button.tsx get restructured?').not.toEqual('')
    expect(
      variants,
      "Button's danger variant is a solid --v2-danger fill; its ring colour must be danger " +
        'and must live beside the fill, not in the base string',
    ).toMatch(/danger:\s*\n?\s*'[^']*bg-\[var\(--v2-danger\)\][^']*focus-visible:ring-danger\/\d+/)
    expect(
      button.match(/const classes = `[^`]*`/)?.[0] ?? '',
      'ring COLOUR belongs in VARIANT_CLASS; only its geometry is uniform',
    ).not.toMatch(/focus-visible:ring-[a-z]+\/\d+/)
  })

  it('the sibling that was already right stays right', () => {
    // EditAgentModal's "Remove budget" is the reference call-site #1792 was
    // measured against. Named so a future sweep cannot quietly flip it back.
    const modal = readFileSync(join(FRONTEND, 'src/components/EditAgentModal.tsx'), 'utf8')
    expect(modal).toMatch(/hover:bg-\[var\(--v2-danger-soft\)\][^"'`]*focus-visible:ring-danger\/\d+/)
  })
})

/**
 * A destructive control has a focus indicator AT ALL (#1819).
 *
 * The inverse question from the tone rule above, and a strictly more serious
 * one. A wrong tone is a consistency defect on a control that can still be
 * perceived; **no indicator is a WCAG 2.4.7 (Focus Visible) failure** — a
 * keyboard user cannot tell which control Enter will fire, on an action that
 * destroys something. `Sidebar`'s "Log out" was the worst case: the popover
 * *programmatically* moves focus to its first item on open (`Sidebar.tsx`'s
 * open-effect), so focus landed on an element with nothing to show for it.
 *
 * Why this could not be a widened version of the tone rule: that rule matches
 * class strings that already contain a `focus-visible:ring-*` utility, so a
 * call-site with none contributes nothing to scan and is invisible BY
 * CONSTRUCTION. #1741's sweep had the same blind spot for the same reason. The
 * population has to be enumerated from the other end — every destructive
 * control — and then checked for an indicator.
 *
 * **A ring is not the only valid indicator, and this rule says so in code rather
 * than in an exemption list.** `DropdownMenu`'s `tone="danger"` item indicates
 * focus with a `focus-visible:bg-` swap. Exempting that file by name would have
 * been the cheap move and would have encoded the wrong rule; accepting a
 * background swap encodes the actual requirement — *indicate focus somehow* —
 * and keeps the file guarded against losing its indicator later. Mutation-proven
 * by removing that swap and watching this rule name the file.
 *
 * Scope, stated because the number is smaller than it looks: across 139
 * hover-bearing class strings in `src/`, 99 carry no focus ring, but only these
 * few are destructive. Scoped to destructive controls the rule closes at ZERO
 * offenders and stays closed — a stronger guarantee than a shrink-only ratchet,
 * which is why #1819 needed neither a ratchet nor a further split. The other ~95
 * are mostly non-focusable elements that merely tint on hover; they are a
 * separate, noisier question and are NOT covered here.
 *
 * **Two known limits, named rather than assumed away** — this file's whole
 * argument is that a guard cannot be trusted because it passes, so its holes
 * belong in writing:
 *
 *   1. **The `bg-` branch checks presence, not distinctness.** It asks whether a
 *      `focus-visible:bg-` exists, never whether it DIFFERS from the control's
 *      own `hover:bg-`. `DropdownMenu` currently sets both to
 *      `--v2-danger-soft`, so its focused and hovered states are identical —
 *      still an indicator against the resting state, so not a 2.4.7 failure, but
 *      a hovering mouse user gets no focus signal. Worse, nothing here would
 *      reject a `focus-visible:bg-white` on a white popover, which would satisfy
 *      this rule while being invisible. Tightening it means comparing the two
 *      values in the same string, not just matching one.
 *   2. **A ring reachable only through `${}` interpolation is invisible to the
 *      scan.** `QUOTED_STRINGS` reads raw source text, so a destructive hover in
 *      a template literal whose ring arrives via an interpolated variable would
 *      be reported as an offender. Note the direction: that is a false POSITIVE,
 *      the safe failure — a noisy red, not a silent green. No call-site does
 *      this today (`Button.tsx` and `entityCardStyles.ts` were both checked), so
 *      it is theoretical; it is written down so the next person meets it as a
 *      known limit rather than a mystery.
 */
const FOCUS_INDICATOR = /focus-visible:(?:ring-[a-z]+\/\d+|bg-)/

/**
 * Every quoted string in a source file, whatever quote encloses it.
 *
 * NOT `className="…"`. That was this rule's first shape and it had a hole big
 * enough to hide the very case the rule documents: `DropdownMenu` builds its
 * tone classes in a TERNARY of single-quoted strings, and `Button` keeps its
 * variants in a lookup table, so neither is ever written as a `className="…"`
 * literal and neither was scanned. The mutation that removed `DropdownMenu`'s
 * indicator therefore left this rule green — a guard cannot be trusted because
 * it passes, only because it fails when it should.
 *
 * Splitting on quote characters is the same granularity the tone rules above
 * use, and it inherits their property: one class STRING at a time, so a file
 * with several controls is never excused because one of its others is correct.
 */
const QUOTED_STRINGS = /[^"'`\n]+/g

describe('destructive controls have a focus indicator at all (#1819)', () => {
  it('every destructive control indicates focus somehow', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(FRONTEND, 'src'))) {
      const text = readFileSync(file, 'utf8')
      for (const cls of text.match(QUOTED_STRINGS) ?? []) {
        if (!DESTRUCTIVE_HOVER.test(cls)) continue
        if (!FOCUS_INDICATOR.test(cls)) {
          offenders.push(`${relative(FRONTEND, file)}: ${cls.trim().slice(0, 80)}…`)
        }
      }
    }
    expect(
      offenders,
      'a destructive control with no focus indicator is a WCAG 2.4.7 failure — add ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80 ' +
        '(ring-inset on a full-bleed row, which would clip an outset ring)',
    ).toEqual([])
  }, SCAN_TIMEOUT)

  it('the indicator scan is looking at a real population', () => {
    // Same anti-vacuity reasoning as the tone rule: a regex that silently stops
    // matching turns the assertion above into a green over an empty list.
    const seen = new Set<string>()
    for (const file of sourceFiles(join(FRONTEND, 'src'))) {
      const text = readFileSync(file, 'utf8')
      for (const cls of text.match(QUOTED_STRINGS) ?? []) {
        if (DESTRUCTIVE_HOVER.test(cls)) seen.add(relative(FRONTEND, file))
      }
    }
    expect(
      seen.size,
      'the destructive-control scan matched nothing — the rule above is passing vacuously',
    ).toBeGreaterThanOrEqual(5)
  }, SCAN_TIMEOUT)

  it('a background-swap indicator counts, and DropdownMenu relies on it', () => {
    // Pins the deliberate design choice above. If someone "tidies" DropdownMenu's
    // focus-visible:bg- away, the rule must catch it rather than shrug — and if
    // someone narrows FOCUS_INDICATOR to rings only, this documents what breaks.
    const menu = readFileSync(join(FRONTEND, 'src/components/ui/DropdownMenu.tsx'), 'utf8')
    expect(
      menu,
      "DropdownMenu's danger item indicates focus with a background swap, not a ring",
    ).toMatch(/focus-visible:bg-\[var\(--v2-danger-soft\)\]/)
    expect(FOCUS_INDICATOR.test('focus-visible:bg-[var(--v2-danger-soft)]')).toBe(true)
  })
})

/**
 * A control that hand-copies `Button`'s base class string declares a focus
 * treatment AT ALL (#1867).
 *
 * The third question in this file, and the one nothing asked before. #1819
 * enumerated DESTRUCTIVE controls and checked each for an indicator, and said
 * in its own header that "controls with NO focus ring at all" was a separate,
 * noisier problem it was deliberately not opening. #1867 is one instance of
 * that problem — the White-on-brand CTA pattern, whose three hand-copies
 * disagreed about focus for as long as it had three: only
 * `investor-briefing/page.tsx:438` declared a ring, and the two on `app/page.tsx`
 * (the highest-traffic buttons in the product) declared nothing and fell back to
 * the UA outline.
 *
 * **Read the calibration before reading the rule.** Those two were not a WCAG
 * 2.4.7 failure: neither set `focus-visible:outline-none`, so the browser's own
 * outline survived and a keyboard user always had an indicator. This is a
 * design-system CONSISTENCY rule, and stating it as an accessibility rule would
 * be the easier framing and the wrong one.
 *
 * ── Why this population and not a wider one ──────────────────────────────────
 *
 * The honest scope is decided by what can be identified without guessing.
 * `design-system.md` § *Button-shaped controls that are not `Button`* publishes
 * a grep for controls that copy the FULL base signature, and states its own
 * blind spot: button-shaped controls built from scratch (`CodeBlock`'s copy
 * button, `ApprovalNotifications.tsx`'s styled `next/link`) do not appear,
 * because the check classifies by class-string spelling rather than by rendered
 * role. That blind spot is inherited here deliberately — a rule over "everything
 * that looks like a button" would need a classifier nobody has scoped, and #1819
 * measured the cost of guessing: 99 of 139 hover-bearing class strings carry no
 * ring, and almost all of them are non-focusable elements that merely tint.
 *
 * So this rule owns exactly the population the published check names, which is
 * also the population that *chose* to inherit `Button`'s paint and can be held
 * to `Button`'s guarantees for it.
 *
 * ── The splice, which is load-bearing rather than tidy ───────────────────────
 *
 * `QUOTED_STRINGS` splits raw source on quote characters, so a class constant
 * assembled by `'…' + '…'` — which is how `BrandBandButton` separates its
 * geometry from its focus clause for readability — reads as TWO strings, the
 * first of which carries the signature and no ring. Un-spliced, this rule would
 * report the very file that fixes #1867 as an offender: a false positive, and
 * the kind that gets a real rule deleted. `spliceConcatenations` rejoins
 * adjacent same-quote literals exactly as the runtime does, and nothing else.
 */
const BUTTON_BASE_SIGNATURE = /rounded-md font-medium tracking-tight/

/**
 * `Button` itself is the primitive being copied, not a copy, and its ring
 * COLOUR deliberately lives in `VARIANT_CLASS` rather than in the base string
 * (#1817) — so its base string carries the signature and no `ring-<tone>/80` by
 * design. It is not unguarded: `Button keeps its ring colour beside its fill`
 * above asserts the arrangement directly, and `Button keeps its offset…`
 * asserts the geometry. Exempting it here is naming that split, not excusing it.
 */
const BASE_SIGNATURE_EXEMPT = ['src/components/ui/Button.tsx']

/**
 * `'a ' + 'b'` → `'a b'`, for adjacent literals under the SAME quote char.
 *
 * **Sharp edge, named because a guard's holes belong in writing.** This is
 * un-scoped: it rewrites every same-quote `+` join in the file, not only the
 * two halves of a class-constant declaration. The failure it could produce is a
 * false NEGATIVE, so state exactly what it takes — the signature-bearing
 * literal must itself be the LEFT operand of a `+` whose right operand carries
 * a `focus-visible:ring-*`. An unrelated `+` join elsewhere in the file cannot
 * reach the signature string, because splicing only removes the join itself and
 * leaves everything between the two strings intact.
 *
 * That shape is exactly the legitimate one (`BrandBandButton`'s `BASE` splits
 * geometry from focus clause across two literals), which is why the splice
 * exists at all — un-spliced, this rule reports the very file that fixes #1867
 * as an offender. Scoping it to a matched `const X = …` statement would close
 * the theoretical hole; it is left un-scoped because a repo-wide scan finds no
 * `+`-joined literal pair outside the signature call sites, and a narrower
 * regex over declaration syntax is its own new class of silent miss.
 */
function spliceConcatenations(text: string): string {
  return text.replace(/(['"`])\s*\+\s*\1/g, '')
}

describe('hand-copies of Button declare a focus treatment (#1867)', () => {
  function signatureStrings(): { file: string; cls: string }[] {
    const out: { file: string; cls: string }[] = []
    for (const file of sourceFiles(join(FRONTEND, 'src'))) {
      const rel = relative(FRONTEND, file)
      if (BASE_SIGNATURE_EXEMPT.includes(rel)) continue
      const text = spliceConcatenations(readFileSync(file, 'utf8'))
      for (const cls of text.match(QUOTED_STRINGS) ?? []) {
        if (BUTTON_BASE_SIGNATURE.test(cls)) out.push({ file: rel, cls })
      }
    }
    return out
  }

  it('every control that copies the base class string declares a focus ring', () => {
    const offenders = signatureStrings()
      .filter(({ cls }) => !FOCUS_INDICATOR.test(cls))
      .map(({ file, cls }) => `${file}: ${cls.trim().slice(0, 80)}…`)
    expect(
      offenders,
      'this control copied Button\'s paint but not its focus ring. Copying the class ' +
        'string copies nothing else — add the one treatment from design-system.md ' +
        '§ Focus rings, with the tone that matches the fill it sits on (white on a ' +
        'dark band, brand on a light surface).',
    ).toEqual([])
  }, SCAN_TIMEOUT)

  it('the signature scan is looking at a real population', () => {
    // Same anti-vacuity reasoning as every other scan in this file. Two members
    // today: `marketing/BrandBandButton.tsx` (the White-on-brand band CTA, the
    // primitive #1867 extracted from three hand-copies) and `InvestorButton` in
    // `investor-briefing/page.tsx`. If this drops to zero the rule above is
    // green over an empty list.
    const files = new Set(signatureStrings().map((s) => s.file))
    expect(
      files.size,
      'the base-signature scan matched nothing — the rule above is passing vacuously',
    ).toBeGreaterThanOrEqual(2)
  }, SCAN_TIMEOUT)

  it('a ring that lands on the brand band is white, never brand', () => {
    // The tone half of the same defect, and NOT covered by the rule above: a
    // control that swapped `ring-white/80` for `ring-brand/80` still "declares a
    // focus ring" and would stay green. Brand indigo cannot reach 3:1 on a dark
    // fill at any alpha (measured in `records why a brand ring may never sit on
    // a dark fill` below), so the offset colour is the tell — a ring offset onto
    // `--v2-brand` is landing on the band, where only white works.
    const offenders: string[] = []
    let seen = 0
    for (const file of sourceFiles(join(FRONTEND, 'src'))) {
      const text = spliceConcatenations(readFileSync(file, 'utf8'))
      for (const cls of text.match(QUOTED_STRINGS) ?? []) {
        if (!/focus-visible:ring-offset-\[var\(--v2-brand\)\]/.test(cls)) continue
        seen++
        if (!/focus-visible:ring-white\/\d+/.test(cls)) {
          offenders.push(`${relative(FRONTEND, file)}: ${cls.trim().slice(0, 80)}…`)
        }
      }
    }
    expect(
      seen,
      'no ring is offset onto --v2-brand — the assertion below is passing vacuously',
    ).toBeGreaterThanOrEqual(1)
    expect(
      offenders,
      'a ring offset onto the brand band lands on a DARK fill; use ' +
        'focus-visible:ring-white/80 (design-system.md § Focus rings)',
    ).toEqual([])
  }, SCAN_TIMEOUT)
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

  it("Button's danger ring is legible only because of its offset moat (#1817)", () => {
    // BACKGROUNDS models (ring, background) pairs. `Button`'s solid-danger
    // variant is a THIRD geometry it does not model — ring, then a white offset
    // band, then the fill — so registering a solid `danger` background there
    // would be registering something adjacent to look thorough. Measured here
    // instead, as the distinct thing it is.
    const danger = tokenRgb('danger')
    const white = tokenRgb('bg')

    // The ring lands on the PAGE, outside the offset band. Already covered by
    // `danger: ['bg', …]` above; restated as the premise of this test.
    const ringOnPage = contrast(composite(danger, FOCUS_ALPHA / 100, white), white)
    expect(ringOnPage, `danger ring on --v2-bg = ${ringOnPage.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    )

    // The white band itself must separate ring from fill.
    const moat = contrast(white, danger)
    expect(moat, `offset band vs --v2-danger fill = ${moat.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    )

    // And the reason the offset is NOT optional. Before #1817 an un-offset ring
    // here would have been brand-over-danger at 1.08:1 — bad. Now that the tone
    // is correct it would be danger-over-danger, i.e. the ring painting itself
    // onto its own fill: strictly WORSE, and invisible at any alpha. Fixing the
    // tone made the offset load-bearing rather than merely helpful, which is the
    // opposite of what "the tone is now right" sounds like it should mean.
    const unOffset = contrast(composite(danger, FOCUS_ALPHA / 100, danger), danger)
    expect(
      unOffset,
      `an un-offset danger ring on the danger fill would measure ${unOffset.toFixed(2)}:1`,
    ).toBeLessThan(1.1)
  })

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
