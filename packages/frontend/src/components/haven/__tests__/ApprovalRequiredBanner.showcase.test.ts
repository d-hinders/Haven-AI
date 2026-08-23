import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Showcase-coverage guard (#1880).
 *
 * `ApprovalRequiredBanner` is a LADDER — `neutral` → `warning` → `danger` — and
 * a ladder with a missing rung is worse than no ladder, because the reader
 * cannot tell a two-step scale from a three-step one they are seeing half of.
 * That is exactly the state #1880 found: three tones in the component, one on
 * `/design-system`, and the escalation the component exists to express visible
 * nowhere it was documented.
 *
 * ── What this test CAN catch ────────────────────────────────────────────────
 *   1. a rung deleted from the showcase — the regression that reopens #1880;
 *   2. a FOURTH tone added to the component and not catalogued. This is the
 *      reason the expected set is derived from `BannerTone` rather than
 *      hardcoded here: a hardcoded triple would pass forever while the real
 *      ladder grew past it, which is the same failure one layer up.
 *
 * ── What it CANNOT catch, and this matters ──────────────────────────────────
 * It reads source text, so it proves a tone is REFERENCED on the page, never
 * that the three sit together where they can be compared, and never that they
 * render correctly. Three banners scattered across three sections would pass
 * here and still leave the ladder unjudgeable. The half that proves what a
 * reader actually sees is the committed `/design-system` visual baseline plus
 * the rendered `haven-design-reviewer` pass — this is the cheap half.
 */

const frontendSrc = resolve(__dirname, '../../..')

const componentSource = readFileSync(
  resolve(frontendSrc, 'components/haven/ApprovalRequiredBanner.tsx'),
  'utf8',
)
const showcaseSource = readFileSync(
  resolve(frontendSrc, 'app/(authenticated)/design-system/page.tsx'),
  'utf8',
)

/** The tone union, read from the component so the guard cannot go stale. */
function declaredTones(): string[] {
  const match = componentSource.match(/type BannerTone = ([^\n]+)/)
  if (!match) throw new Error('BannerTone union not found in ApprovalRequiredBanner.tsx')
  const tones = [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  if (tones.length === 0) throw new Error(`BannerTone union parsed to nothing: ${match[1]}`)
  return tones
}

/** Every `tone` passed to an `<ApprovalRequiredBanner>` on the showcase page. */
function cataloguedTones(): string[] {
  const opens = [...showcaseSource.matchAll(/<ApprovalRequiredBanner\b[^>]*>/g)].map((m) => m[0])
  if (opens.length === 0) throw new Error('no <ApprovalRequiredBanner> found on the design-system page')
  return opens.flatMap((tag) => {
    const tone = tag.match(/\btone="([a-z]+)"/)
    return tone ? [tone[1]] : []
  })
}

describe('/design-system catalogues the ApprovalRequiredBanner tone ladder (#1880)', () => {
  it('every declared tone appears on the showcase page', () => {
    const catalogued = new Set(cataloguedTones())
    for (const tone of declaredTones()) {
      expect(
        catalogued.has(tone),
        `tone "${tone}" is declared in BannerTone but demonstrated nowhere on /design-system — ` +
          'add it to the tone-ladder section rather than deleting it here',
      ).toBe(true)
    }
  })

  it('the showcase demonstrates no tone the component cannot render', () => {
    const declared = new Set(declaredTones())
    for (const tone of cataloguedTones()) {
      expect(declared.has(tone), `/design-system passes tone="${tone}", which BannerTone does not declare`).toBe(
        true,
      )
    }
  })

  it('the ladder is shown as one contiguous block, not scattered across the page', () => {
    // The whole point of #1880 is side-by-side comparability. A section that
    // holds all three within one run of the file is the closest a source-level
    // check can get to that; the baseline proves the rest.
    const section = showcaseSource.match(
      /title="ApprovalRequiredBanner — the tone ladder"[\s\S]*?\n      <\/Section>/,
    )
    expect(section, 'the tone-ladder section is missing from /design-system').not.toBeNull()
    const withinSection = new Set(
      [...(section as RegExpMatchArray)[0].matchAll(/\btone="([a-z]+)"/g)].map((m) => m[1]),
    )
    for (const tone of declaredTones()) {
      expect(
        withinSection.has(tone),
        `tone "${tone}" is not inside the tone-ladder section — the ladder is only judgeable together`,
      ).toBe(true)
    }
  })
})
