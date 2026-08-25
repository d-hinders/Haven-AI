/**
 * The per-run viewport override for the capture harness (#2006).
 *
 * #1944 declined to add 320 to the committed evidence set, and that decision
 * stands: at Haven's single sub-`lg` breakpoint 320 and 390 select the same
 * branches, so a 320 baseline would mint a blocking full-page `/design-system`
 * PNG plus a third capture of every route in every run, forever, to photograph
 * a layout whose real risk is arithmetic — and an overlap photographs happily
 * (#1858). What 320 IS gated by is measurement: `mobile-nav-tap-target`,
 * `mobile-nav-layering`, `transaction-row` and `navigation` all sweep it.
 *
 * What was missing is the other half: no way to LOOK at 320 without editing a
 * file four gates read. This file covers the override that closes that, and the
 * two properties that keep it from becoming a fifth silent capture path:
 *
 *   1. the committed set is returned UNCHANGED when nothing is requested — the
 *      default run's `-desktop` / `-mobile` filenames and the baselines that
 *      compare against them cannot move;
 *   2. a requested width is IDENTIFIABLE in what it produces. The viewport is
 *      named after its own dimensions, so a run that asked for 320 and shot the
 *      committed set is visibly wrong rather than plausibly right. A capture
 *      that cannot say what produced it is the #1800 defect.
 */
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, the capture harness itself
import { findViewportMismatches } from '../../scripts/screenshot.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, shared with scripts/screenshot.mjs and four gates
import {
  DEFAULT_OVERRIDE_HEIGHT,
  VIEWPORTS,
  parseViewportSpec,
  resolveCaptureViewports,
} from '../../scripts/evidence-viewports.mjs'

type Viewport = { name: string; width: number; height: number }
type Resolved = { viewports: Viewport[]; source: string; specs: string[] }

const resolve = (argv: string[] = [], env: Record<string, string> = {}): Resolved =>
  resolveCaptureViewports(argv, env) as Resolved

const committed = VIEWPORTS as Viewport[]

describe('the committed evidence set', () => {
  it('is what a run with no override shoots, entry for entry', () => {
    // The load-bearing assertion for "npm run screenshot is unchanged": every
    // gate compares against baselines keyed on these names, and this is the
    // only thing standing between the override and a moved baseline.
    const { viewports, source } = resolve()

    expect(source).toBe('committed')
    expect(viewports).toEqual(committed)
    expect(viewports.map((vp) => vp.name)).toEqual(['desktop', 'mobile'])
  })

  it('is not reachable through the override, so a request never degrades to it', () => {
    // The failure this exists to make impossible: a mistyped width that quietly
    // falls back to 1280/390 and hands a reviewer a "320px" capture of 390px.
    expect(() => resolve(['--viewport=32o'])).toThrow(/32o/)
    expect(() => resolve([], { SCREENSHOT_VIEWPORTS: '320x' })).toThrow(/320x/)
    expect(() => resolve(['--viewport=12'])).toThrow(/width 12 is outside/)
    expect(() => resolve(['--viewport=320x99999'])).toThrow(/height 99999 is outside/)
  })
})

describe('an overridden run', () => {
  it('shoots exactly the requested width and nothing from the committed set', () => {
    const { viewports, source, specs } = resolve(['--viewport=320x568'])

    expect(viewports).toEqual([{ name: '320x568', width: 320, height: 568 }])
    expect(source).toBe('--viewport')
    expect(specs).toEqual(['320x568'])
    // Explicit, because "the override ran" and "the committed set also ran" are
    // different results and only one of them is what was asked for.
    expect(viewports.map((vp) => vp.name)).not.toContain('desktop')
    expect(viewports.map((vp) => vp.name)).not.toContain('mobile')
  })

  it('names each viewport after its own dimensions, which is what the PNG carries', () => {
    // `screenshot.mjs` builds every filename as `<slug>-<vp.name>.png`, so this
    // name IS the evidence trail: `dashboard-320x568.png` cannot be mistaken
    // for `dashboard-mobile.png` in a review thread.
    const { viewports } = resolve([], { SCREENSHOT_VIEWPORTS: '320x568, 412x915' })

    expect(viewports.map((vp) => vp.name)).toEqual(['320x568', '412x915'])
    for (const vp of viewports) expect(vp.name).toBe(`${vp.width}x${vp.height}`)
  })

  it('takes a width alone and states the height it filled in', () => {
    const { viewports } = resolve(['--viewport=320'])

    expect(viewports).toEqual([
      { name: `320x${DEFAULT_OVERRIDE_HEIGHT}`, width: 320, height: DEFAULT_OVERRIDE_HEIGHT },
    ])
  })

  it('accepts a repeated flag and a comma list as the same thing', () => {
    const repeated = resolve(['--viewport=320x568', '--viewport=1280x800'])
    const listed = resolve(['--viewport=320x568,1280x800'])

    expect(repeated.viewports).toEqual(listed.viewports)
    // Named rather than only compared to each other: two forms that BOTH
    // degrade to the committed set are also equal, and that is the failure this
    // assertion has to be able to see.
    expect(repeated.viewports.map((vp) => vp.name)).toEqual(['320x568', '1280x800'])
  })

  it('lets a flag beat an exported environment variable', () => {
    // Otherwise a shell that once exported a width silently decides every later
    // run, and the flag the reviewer typed is the thing that looks ignored.
    const { viewports, source } = resolve(['--viewport=320x568'], {
      SCREENSHOT_VIEWPORTS: '1280x800',
    })

    expect(viewports).toEqual([{ name: '320x568', width: 320, height: 568 }])
    expect(source).toBe('--viewport')
  })

  it('collapses a duplicate spec instead of overwriting its own PNG', () => {
    const { viewports } = resolve(['--viewport=320x568,320x568'])

    expect(viewports).toHaveLength(1)
  })

  it('ignores an empty environment variable rather than treating it as a request', () => {
    expect(resolve([], { SCREENSHOT_VIEWPORTS: '' }).source).toBe('committed')
    expect(resolve([], { SCREENSHOT_VIEWPORTS: ' , ' }).source).toBe('committed')
  })
})

describe('parseViewportSpec', () => {
  it('is the single place a spec becomes a viewport', () => {
    expect(parseViewportSpec('320x568')).toEqual({ name: '320x568', width: 320, height: 568 })
  })
})

/**
 * The binding between the resolved widths and the PNGs actually written.
 *
 * Everything above tests a resolver, and a resolver can be perfect while the
 * capture loop iterates something else entirely — parsed, printed, stamped into
 * the manifest, and ignored. That defect is invisible in the artifact: a 390px
 * render of `/dashboard` is a good-looking PNG, and only its NAME says which
 * width it is. So the harness checks its own output against its own claim.
 */
describe('findViewportMismatches', () => {
  const at320 = [{ name: '320x568', width: 320, height: 568 }]

  it('passes a run whose files carry the resolved viewport name', () => {
    expect(
      findViewportMismatches(
        [
          '.screenshots/dashboard-320x568.png',
          '.screenshots/design-system-320x568.png',
          '.screenshots/connect-agent-waiting-slow-320x568-full.png',
        ],
        at320,
      ),
    ).toEqual([])
  })

  it('catches a run that resolved 320 and wrote the committed widths anyway', () => {
    // The exact shape of "the override was computed and then ignored". Without
    // this the manifest says 320x568 over two PNGs that are 1280 and 390.
    const mismatches = findViewportMismatches(
      ['.screenshots/dashboard-desktop.png', '.screenshots/dashboard-mobile.png'],
      at320,
    )

    expect(mismatches.map((m: { file: string }) => m.file)).toEqual([
      '.screenshots/dashboard-desktop.png',
      '.screenshots/dashboard-mobile.png',
    ])
    // The report has to say what WAS expected, or the reader is left comparing
    // a filename against a number they have to go and look up.
    expect(mismatches[0].expected).toEqual(['320x568'])
  })

  it('does not fire on the committed default run', () => {
    expect(
      findViewportMismatches(
        ['.screenshots/design-system-desktop.png', '.screenshots/design-system-mobile.png'],
        VIEWPORTS as Viewport[],
      ),
    ).toEqual([])
  })

  it('is not satisfied by a name that merely contains the width', () => {
    // `-320x568` has to be the viewport SEGMENT, not a substring anywhere in
    // the slug, or a route called `/pricing-320x568-preview` would excuse a
    // capture at any width at all.
    expect(findViewportMismatches(['.screenshots/320x568-dashboard.png'], at320)).toHaveLength(1)
  })
})
