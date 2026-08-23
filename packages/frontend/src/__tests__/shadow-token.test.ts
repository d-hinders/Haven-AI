import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { describe, expect, it } from 'vitest'

/**
 * Every elevation token reaches a real, painted `box-shadow` (#1945).
 *
 * ── The defect this exists to make impossible ────────────────────────────────
 *
 * `shadow-[var(--v2-shadow-card)]` and its four siblings emitted NOTHING. A
 * bare `var()` inside `shadow-[…]` is ambiguous — Tailwind cannot know whether
 * the variable holds a colour or a whole shadow — so its arbitrary-value type
 * inference takes the COLOUR branch and compiles:
 *
 *     --tw-shadow-color: var(--v2-shadow-card);
 *     --tw-shadow: var(--tw-shadow-colored);
 *
 * Nothing ever sets `--tw-shadow-colored`, so `--tw-shadow` is invalid and the
 * computed `box-shadow` is `none`. 67 call sites across 43 files — every
 * `Card`, `ui/Modal`'s panel, every popover, tooltip and toast — rendered flat
 * for as long as the tokens had existed.
 *
 * It is the third instance of one failure mode, and that is why the guard is
 * shaped like `focus-ring.test.ts` rather than like a lint rule: **a spelling
 * that lints clean, reads correctly to a human, and emits nothing.** #1708 was
 * an opacity modifier on a bare-`var()` ring colour; #1818 generalised it past
 * the arbitrary-value SHAPE to the OUTPUT; this is the same output failure on
 * the shadow axis. `design:lint`'s token rules cannot see any of them — they
 * exist to catch a *bypassed* token, and here the token is referenced exactly
 * as every convention says it should be.
 *
 * ── Why the instrument is a COMPILE and not a grep ───────────────────────────
 *
 * A spelling rule would have been cheaper and would encode the wrong claim.
 * What matters is not which characters the class string contains but whether a
 * `box-shadow` VALUE comes out the other end of Tailwind, which is the same
 * argument #1818 made when it replaced #1708's regex. So this file boots the
 * real compiler over the real `tailwind.config.js`, reads what it emits, and
 * resolves each `var()` back through `globals.css` to the literal shadow list.
 *
 * The bare-`var()` BAN below is a second, weaker net kept deliberately: it
 * names the specific dead spelling at the call site, where the compile check
 * can only say "some utility somewhere emitted nothing".
 *
 * ── Positive control ─────────────────────────────────────────────────────────
 *
 * This repo has been burned by false zeros — a `none` from an unproven reader
 * terminates an investigation while feeling like rigour (see the memory note
 * on false-zero instruments, and #1897/#1899). Every "emits nothing" assertion
 * here is therefore paired with a declaration known to resolve, so a clean run
 * is a MEASUREMENT rather than a broken reader returning empty. Two controls:
 * `shadow-card` on the compile side, and `.v2-modal-backdrop` — the named-class
 * idiom that provably resolved when the arbitrary-value form did not — on the
 * stylesheet-reading side.
 */

const FRONTEND = resolve(__dirname, '../..')
const css = readFileSync(join(FRONTEND, 'src/app/globals.css'), 'utf8')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tailwindConfig = require(join(FRONTEND, 'tailwind.config.js'))

/** Booting real Tailwind is a real compile; vitest's 5s default would flake. */
const COMPILE_TIMEOUT = 60_000

/**
 * Same rationale as `focus-ring.test.ts`: these scans re-read every `.ts`/`.tsx`
 * under `src/`, which is I/O-bound and lands well inside 5s idle — but this
 * repo's agent sessions run at load average 200+, where the same walk has
 * measured 8-13s and failed as a TIMEOUT. A timeout is the worst failure mode
 * for a guard: it looks exactly like the defect, on a PR that did not cause it.
 */
const SCAN_TIMEOUT = 60_000

/**
 * The elevation scale. Every `--v2-shadow-*` token in `globals.css` MUST appear
 * here or in SCALE_EXEMPT — the completeness assertion below derives the token
 * list from the stylesheet rather than trusting this constant, so adding a
 * token without deciding which side it falls on turns the suite red.
 */
const ELEVATION = ['card', 'card-raised', 'button', 'modal', 'popover'] as const

/**
 * `--v2-shadow-scroll-edge` is not an elevation tier. It is the single inset
 * continuation cue at the bottom of a scrolling dialog body, applied through
 * `.v2-scroll-edge-cue` (#1893) precisely BECAUSE the arbitrary-value form was
 * dead — that class is where this defect was first measured. It has one call
 * site, no variants, and a 40-line rationale attached to it; promoting it to a
 * theme utility would advertise it as a reusable rung it is not.
 */
const SCALE_EXEMPT = ['scroll-edge']

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(full)) acc.push(full)
  }
  return acc
}

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

/** The `--tw-shadow` a class compiles to, or null if none was emitted. */
async function compiledShadow(utility: string): Promise<string | null> {
  const out = await compileCss([utility])
  return out.match(/--tw-shadow:\s*([^;\n}]+)/)?.[1].trim() ?? null
}

/**
 * The literal value of a `--v2-*` custom property as `globals.css` defines it.
 *
 * Deliberately NOT a colour parse: a shadow token is a comma-separated list of
 * offset/blur/colour triples, and what this guard needs to know is that the
 * chain ends in something a browser can paint — not what hue it is.
 */
function tokenValue(name: string): string | null {
  return css.match(new RegExp(`--v2-${name}:\\s*([^;]+);`))?.[1].trim() ?? null
}

/** Every `--v2-shadow-*` token `globals.css` actually defines. */
function definedShadowTokens(): string[] {
  return [...css.matchAll(/--v2-shadow-([a-z-]+):/g)].map((m) => m[1])
}

// ── the instrument proves it can say yes ─────────────────────────────────────

describe('the reader works before any "emits nothing" is believed (#1945)', () => {
  it('resolves a declaration known to be live — .v2-modal-backdrop', () => {
    // The named-class idiom that RESOLVED in the browser probe while every
    // `shadow-[var(…)]` sibling read `none`. If this ever returns null, the
    // stylesheet reader is broken and every token assertion below is vacuous.
    expect(css, 'globals.css does not contain .v2-modal-backdrop').toMatch(/\.v2-modal-backdrop\s*\{/)
    expect(tokenValue('modal-backdrop'), 'the token reader returned nothing for a live token').toMatch(
      /^rgba\(/,
    )
  })

  it('emits a real box-shadow for a utility known to be live — shadow-card', async () => {
    const emitted = await compiledShadow('shadow-card')
    expect(emitted, 'the compile reader emitted nothing for the reference utility').toBe(
      'var(--v2-shadow-card)',
    )
  }, COMPILE_TIMEOUT)

  it('finds the shadow call sites at all', () => {
    // Without this, a regex that silently matches nothing turns the sweep below
    // into a vacuous pass over an empty array.
    const uses = shadowUses()
    expect(uses.length, 'the shadow scan matched nothing').toBeGreaterThan(50)
    expect(new Set(uses.map((u) => u.file)).size).toBeGreaterThan(30)
  }, SCAN_TIMEOUT)
})

// ── reading the call sites ───────────────────────────────────────────────────

interface ShadowUse {
  file: string
  /** e.g. `shadow-card`, `hover:shadow-card-raised`, `shadow-[var(--v2-shadow-card)]` */
  utility: string
}

/**
 * Every `shadow-` utility in the product source that names a `--v2-shadow-*`
 * token, in either spelling — the live theme form and the dead arbitrary form.
 *
 * Bespoke literal shadows (`shadow-[0_8px_24px_-12px_rgba(…)]`, the marketing
 * hover lifts) are deliberately out of scope: they carry their value inline, so
 * they cannot fail this way, and `design:lint` owns the separate question of
 * whether they should be tokens. Test files are excluded because two of them
 * QUOTE the dead spelling on purpose, as documentation of what not to write.
 */
function shadowUses(): ShadowUse[] {
  const re = /\b([a-z-]+:)?shadow-(?:\[var\(--v2-shadow-[a-z-]+\)\]|(?:card-raised|card|button|modal|popover)\b)/g
  const out: ShadowUse[] = []
  for (const file of sourceFiles(join(FRONTEND, 'src'))) {
    if (/__tests__|\.test\.tsx?$/.test(file)) continue
    for (const m of readFileSync(file, 'utf8').matchAll(re)) {
      out.push({ file: relative(FRONTEND, file), utility: m[0] })
    }
  }
  return out
}

// ── guards ───────────────────────────────────────────────────────────────────

describe('every elevation utility in use paints something (#1945)', () => {
  it('emits a --tw-shadow that is not the never-set colour placeholder', async () => {
    const dead: string[] = []
    for (const utility of [...new Set(shadowUses().map((u) => u.utility))]) {
      // Strip the variant — `hover:shadow-card-raised` compiles the same
      // declaration under a `:hover` selector, and it is the DECLARATION that
      // is under test here.
      const bare = utility.replace(/^[a-z-]+:/, '')
      const emitted = await compiledShadow(bare)
      if (emitted === null || emitted === 'var(--tw-shadow-colored)') {
        dead.push(`${utility} → ${emitted ?? 'nothing emitted'}`)
      }
    }
    expect(
      dead,
      'these compile to a shadow COLOUR against a variable nothing sets, so the computed ' +
        'box-shadow is `none`. Use the theme utility (shadow-card, shadow-modal, …), never ' +
        'shadow-[var(--v2-shadow-*)] — see tailwind.config.js → boxShadow.',
    ).toEqual([])
  }, COMPILE_TIMEOUT)

  it('resolves each emitted var() to a real shadow list in globals.css', async () => {
    // The compile check above proves a value was emitted; this proves the value
    // it was emitted AGAINST is not empty. A theme entry pointing at a token
    // that no longer exists would satisfy the first check and paint nothing.
    const unresolved: string[] = []
    for (const tier of ELEVATION) {
      const emitted = await compiledShadow(`shadow-${tier}`)
      const token = emitted?.match(/^var\((--v2-shadow-[a-z-]+)\)$/)?.[1]
      if (token === undefined) {
        unresolved.push(`shadow-${tier} → ${emitted ?? 'nothing emitted'}`)
        continue
      }
      const value = tokenValue(token.replace('--v2-', ''))
      // A paintable shadow is at least one `<offset> <offset> …` triple; the
      // weakest honest check is that it carries a length and a colour.
      if (value === null || !/\d/.test(value) || !/rgba?\(|#[0-9a-f]{3}/i.test(value)) {
        unresolved.push(`${token} = ${value ?? 'undefined in globals.css'}`)
      }
    }
    expect(unresolved, 'a theme entry points at a token with no paintable value').toEqual([])
  }, COMPILE_TIMEOUT)

  it('REGRESSION: shadow-[var(--v2-shadow-card)] is one of those dead shapes', async () => {
    // Reproduced so that reaching for the arbitrary form again is a red test
    // rather than an invisible flat surface. Both halves matter: the dead form
    // stays dead, AND the live form stays live in the same assertion, so this
    // cannot pass because the compiler stopped emitting anything at all.
    expect(await compiledShadow('shadow-[var(--v2-shadow-card)]')).toBe('var(--tw-shadow-colored)')
    expect(await compiledShadow('shadow-[var(--v2-shadow-card)]')).toBe(
      await compiledShadow('shadow-[color:var(--v2-shadow-card)]'),
    )
    expect(await compiledShadow('shadow-card')).toBe('var(--v2-shadow-card)')
    // The documented type hint is the OTHER working spelling. It is not what
    // this repo uses — the theme utility is, per #1708's precedent — but
    // asserting it here records that the diagnosis is about the missing hint
    // rather than about `var()` in a shadow being impossible.
    expect(await compiledShadow('shadow-[shadow:var(--v2-shadow-card)]')).toBe('var(--v2-shadow-card)')
  }, COMPILE_TIMEOUT)
})

describe('the dead spelling cannot come back (#1945)', () => {
  it('no product source writes shadow-[var(--v2-shadow-*)]', () => {
    const offenders = shadowUses()
      .filter((u) => u.utility.includes('['))
      .map((u) => `${u.file}: ${u.utility}`)
    expect(
      offenders,
      'a bare var() inside shadow-[…] compiles to a shadow COLOUR and paints nothing (#1945). ' +
        'Use the theme utility: shadow-card, shadow-card-raised, shadow-button, shadow-modal, ' +
        'shadow-popover.',
    ).toEqual([])
  }, SCAN_TIMEOUT)

  it('every elevation token has a theme entry, or a named exemption', () => {
    // Derived from the stylesheet, not from ELEVATION — so adding a token and
    // forgetting to wire it up is a red test rather than a silent gap. This is
    // the assertion that would have caught #1945 at the moment
    // `--v2-shadow-popover` was added with no way to spell it.
    const theme = tailwindConfig.theme.extend.boxShadow as Record<string, string>
    const missing = definedShadowTokens().filter(
      (t) => !SCALE_EXEMPT.includes(t) && theme[t] !== `var(--v2-shadow-${t})`,
    )
    expect(
      missing,
      'an elevation token with no theme entry has no working spelling — add it to ' +
        'tailwind.config.js → boxShadow, or to SCALE_EXEMPT with a reason.',
    ).toEqual([])
    expect(
      definedShadowTokens().length,
      'no --v2-shadow-* tokens found — the completeness check is passing vacuously',
    ).toBeGreaterThanOrEqual(6)
  })

  it('the exemption is still earning its place', () => {
    // Same mechanism #1792/#1809 used for `TONE_EXEMPT`: an exemption that
    // stops being true must fail rather than linger as stale data dressed as a
    // decision. `scroll-edge` is exempt because it is applied through a class.
    expect(css, '.v2-scroll-edge-cue no longer applies --v2-shadow-scroll-edge').toMatch(
      /\.v2-scroll-edge-cue\s*\{[\s\S]*box-shadow:\s*var\(--v2-shadow-scroll-edge\)/,
    )
  })
})
