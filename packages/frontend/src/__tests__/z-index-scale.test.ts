import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Layering-scale guard (#1749).
 *
 * ── What this test CAN catch ────────────────────────────────────────────────
 * Two things, both of them source-level facts:
 *   1. the scale's ordering — if someone raises `--v2-z-chrome` above the
 *      navigation tiers, or drops a nav tier below the chrome, that is the
 *      exact inversion that made the mobile sidebar toggle unreachable;
 *   2. the shell components reaching for a token instead of a bare number —
 *      a fresh `z-[60]` in Sidebar or AuthenticatedShell is how the defect is
 *      reintroduced, and it is invisible to every other frontend gate.
 *
 * ── What it CANNOT catch, and this matters ──────────────────────────────────
 * It cannot see stacking contexts, and it cannot hit-test. A correctly ordered
 * scale still fails to produce a clickable button if some ancestor creates a
 * stacking context that traps one of these layers — `transform`, `filter`,
 * `opacity < 1`, `will-change`, `backdrop-filter` all do that, and the numbers
 * would still read correctly here while the button stayed buried.
 *
 * So this test is the cheap half of the guard and deliberately not the whole
 * one. The half that actually proves a user can tap the control is
 * `e2e/mobile-nav-layering.spec.ts`, which runs a real engine and asks
 * `elementFromPoint` — the only question with a trustworthy answer.
 */

const root = resolve(__dirname, '..')
// The layering tokens moved to @haven_ai/ui (#3508): tokens.css lives in
// packages/ui/src, imported by the app layout before globals.css.
const css = readFileSync(resolve(root, '../../ui/src/tokens.css'), 'utf8')

function zToken(name: string): number {
  const match = css.match(new RegExp(`--v2-z-${name}:\\s*(\\d+)`))
  if (!match) throw new Error(`token --v2-z-${name} not found in tokens.css`)
  return Number(match[1])
}

const SHELL_FILES = [
  'components/AuthenticatedShell.tsx',
  'components/sidebar/Sidebar.tsx',
  'components/sidebar/MoreSheet.tsx',
  'components/sidebar/MobileTabBar.tsx',
]

describe('z-index scale (#1749)', () => {
  it('the mobile navigation tiers all outrank the app chrome', () => {
    const chrome = zToken('chrome')
    for (const nav of ['nav-scrim', 'nav-drawer', 'nav-toggle']) {
      expect(zToken(nav), `--v2-z-${nav} must sit above --v2-z-chrome`).toBeGreaterThan(chrome)
    }
  })

  it('the bottom tab bar sits between the content and the overlays above it (#2730)', () => {
    // Above the content it scrolls over, below the popovers anchored in the
    // chrome, and below the nav overlay tiers — a bar at `--v2-z-nav-drawer`
    // or above is the #1749 inversion one surface over: it would paint over
    // a sheet that grew past its edge.
    expect(zToken('tab-bar')).toBeGreaterThan(zToken('sticky'))
    expect(zToken('tab-bar')).toBeLessThan(zToken('chrome-popover'))
    expect(zToken('tab-bar')).toBeLessThan(zToken('nav-scrim'))
    expect(zToken('tab-bar')).toBeLessThan(zToken('nav-drawer'))
  })

  it('the More sheet floats OVER the tab bar, its scrim shading to the viewport bottom (#4058)', () => {
    // #4053 kept the bar reachable by GEOMETRY: sheet and scrim ended at the
    // bar's top edge. Once the bar became a floating pill (#4058) that edge
    // cut through the pill and left the strip around it undimmed, so the
    // sheet now covers the bar BY RANK (the ordering assertions above) and
    // carries its own ✕. This pins the half the ordering cannot see: the scrim
    // runs to the bottom edge, and the card floats clear of it rather than
    // stopping at the bar.
    const sheet = readFileSync(resolve(root, 'components/sidebar/MoreSheet.tsx'), 'utf8')
    const scrim = sheet.match(/data-more-sheet-scrim=""[\s\S]*?className="([^"]+)"/)
    expect(scrim, 'scrim className not found').not.toBeNull()
    expect(scrim![1].split(/\s+/)).toEqual(
      expect.arrayContaining(['fixed', 'inset-x-0', 'top-[var(--v2-safe-top)]', 'bottom-0', 'z-[var(--v2-z-nav-scrim)]']),
    )
    // Never `inset-0` / `top-0`: the status band stays opaque (#2819).
    expect(scrim![1]).not.toMatch(/\binset-0\b|\btop-0\b/)
    expect(sheet).toContain('bottom-[max(0.5rem,var(--v2-safe-bottom))]')
    expect(sheet).toContain('aria-label="Close sidebar"')
    // The geometry `const bottom` that made the sheet stop at the bar is gone.
    expect(sheet).not.toMatch(/const bottom = /)
  })

  it('the More control is a cell of the tab bar, not a control floating over a drawer (#4053)', () => {
    // #2731–#2820 painted it from outside the bar on `--v2-z-nav-toggle`,
    // because the full-screen drawer covered the bar and the same button had
    // to stay on top of it to close it. Since #4058 the sheet covers the bar
    // again, but it closes itself (its ✕), so no control has to float over
    // it: the tier keeps no consumer, and one reappearing on it means the
    // close control has moved back out of the sheet.
    const bar = readFileSync(resolve(root, 'components/sidebar/MobileTabBar.tsx'), 'utf8')
    const sidebar = readFileSync(resolve(root, 'components/sidebar/Sidebar.tsx'), 'utf8')
    expect(bar).toContain('data-more-toggle')
    for (const source of [bar, sidebar]) expect(source).not.toContain('z-[var(--v2-z-nav-toggle)]')
    expect(zToken('nav-drawer')).toBeGreaterThan(zToken('nav-scrim'))
  })

  it('modals and toasts outrank the navigation overlay', () => {
    // A dialog opened from a nav link has to cover the drawer it was opened
    // from; a toast has to be visible over everything.
    expect(zToken('modal')).toBeGreaterThan(zToken('nav-toggle'))
    expect(zToken('tooltip')).toBeGreaterThan(zToken('modal'))
    expect(zToken('panel')).toBeGreaterThan(zToken('tooltip'))
    expect(zToken('toast')).toBeGreaterThan(zToken('panel'))
  })

  it('the whole scale is strictly ascending in the documented order', () => {
    const order = [
      'content',
      'sticky',
      'chrome',
      'tab-bar',
      'chrome-popover',
      'nav-scrim',
      'nav-drawer',
      'nav-toggle',
      'modal',
      'tooltip',
      'panel',
      'toast',
    ]
    const values = order.map(zToken)
    expect(values, `scale order: ${order.join(' < ')}`).toEqual([...values].sort((a, b) => a - b))
    expect(new Set(values).size, 'every tier is a distinct value').toBe(values.length)
  })

  it('the shell components use scale tokens, never a bare z-index number', () => {
    for (const file of SHELL_FILES) {
      const source = readFileSync(resolve(root, file), 'utf8')
      // Bare arbitrary values (`z-[60]`) and Tailwind's own numeric scale
      // (`z-50`) alike — both are how an unrelated number gets picked.
      //
      // The trailing guard is `(?![\w-])`, NOT `\b`. `\b` after `z-[100]`
      // never matches: `]` and the following space are both non-word, so
      // there is no boundary between them, and the whole pattern silently
      // failed to see the exact value this test exists to catch. Found by
      // mutating TopBar back to `z-[100]` and watching this assertion PASS —
      // the bug was caught only by the softer `toMatch` below, which would
      // have kept quiet had one other token remained anywhere in the file.
      const bare = source.match(/\bz-(?:\[\d+\]|\d+)(?![\w-])/g) ?? []
      expect(bare, `${file} must reference --v2-z-* tokens, found: ${bare.join(', ')}`).toEqual([])
      expect(source, `${file} should reference the layering scale`).toMatch(/z-\[var\(--v2-z-/)
    }
  })

  it('every full-screen modal overlay sits on the modal tier', () => {
    // The finding that made this test exist in its current form: raising the
    // navigation above the chrome silently DEMOTED ten `fixed inset-0`
    // overlays below it, because they carried hand-picked z-indexes (five at
    // 100/110, three at 50, two at 200) that nobody had reconciled. Three of
    // them were already rendering under TopBar before this change.
    //
    // "Modals outrank the navigation" is a claim the design-system page makes
    // in prose; this is the assertion that keeps it TRUE. A full-screen
    // overlay is unambiguous — `fixed inset-0` is the shape — so a new one on
    // a fresh number fails here rather than being discovered by a user who
    // cannot dismiss a dialog.
    // The mobile navigation scrim (the More sheet's, #4053 — full-height
    // since #4058 but still below the status band, so not `inset-0`) is the
    // one legitimate overlay
    // that is NOT a modal — it belongs to the navigation tier by construction, and
    // is allowed here by its token rather than by filename, so renaming the
    // file cannot smuggle a modal through.
    const ALLOWED = new Set(['[var(--v2-z-modal)]', '[var(--v2-z-nav-scrim)]'])

    const files = globSync('**/*.tsx', { cwd: root }).filter(
      (f) => !String(f).includes('__tests__'),
    ) as string[]
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(resolve(root, file), 'utf8')
      for (const line of source.split('\n')) {
        if (!/fixed inset-0/.test(line)) continue
        const z = line.match(/\bz-(\[[^\]]+\]|\d+)/)
        if (!z) continue
        if (!ALLOWED.has(z[1])) offenders.push(`${file}: ${z[0]}`)
      }
    }
    expect(offenders, 'full-screen overlays must use --v2-z-modal').toEqual([])
  })

  it('every --v2-z-* token in the scale is documented on /design-system', () => {
    // The layering rule is only written down if the reference page actually
    // lists it — #1749's own acceptance criterion.
    const page = readFileSync(resolve(root, 'app/(authenticated)/design-system/page.tsx'), 'utf8')
    const declared = [...css.matchAll(/--v2-z-([a-z-]+):/g)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(0)
    for (const name of declared) {
      expect(page, `--v2-z-${name} is missing from the /design-system layering table`).toContain(
        `--v2-z-${name}`,
      )
    }
  })
})
