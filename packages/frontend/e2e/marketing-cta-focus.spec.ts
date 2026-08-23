/**
 * The dark-band CTAs indicate focus, RENDERED (#1867).
 *
 * `src/__tests__/focus-ring.test.ts` gained a completeness rule in the same PR:
 * a class string that copies `Button`'s base signature must declare a
 * `focus-visible:` ring. That rule reads SOURCE TEXT, which is the same
 * granularity every guard in that file works at, and this repo has paid for
 * trusting it alone twice — #1818 is a class string that compiled to nothing,
 * and #1741's `ring-current/30` rendered Tailwind's default blue for months
 * while looking correct in the diff. So the structural rule gets a rendered
 * counterpart, on the three controls #1867 is actually about.
 *
 * ── Why this file carries NO baseline, and that is the considered answer ─────
 *
 * The obvious move was a driven pixel capture, following
 * `focus-visible.visual.spec.ts`. Two things argued against it and one argued
 * decisively:
 *
 *  1. **The region problem is worse here than there.** `#1873` records the
 *     hazard: `ring-2` + `ring-offset-2` puts 4px of ring OUTSIDE the control's
 *     own border box, so a locator-scoped capture clips the indicator it exists
 *     to photograph. That file solved it by capturing the parent row. These
 *     CTAs' parent is `flex items-center`, exactly as tall as the buttons
 *     themselves, so the parent clips too — the next container up is the whole
 *     CTA band, an enormous region whose diff would be dominated by a radial
 *     gradient rather than by a ring.
 *  2. **A baseline proves a match, never a correctness.** #1909's archived row
 *     is the standing example: 49px before and after the fix, the baseline a
 *     faithful photograph OF the bug.
 *
 * What actually needs proving here is a boolean — does a visible ring paint,
 * and is it white rather than brand — and #1909's own mobile test sets the
 * precedent for asserting the invariant instead of minting a baseline the file
 * has no coverage argument for ("Overflow is a boolean, not a pixel count").
 * The computed `box-shadow` is read from the live render, so a class that
 * compiles to nothing fails here exactly as loudly as one that is missing.
 *
 * ── Keyboard, never `.focus()` ───────────────────────────────────────────────
 *
 * `:focus-visible` is decided by the last input MODALITY. A `.focus()` call
 * after any pointer interaction takes focus with NO ring at all, and the
 * assertion would then be measuring a resting state while reporting a focus
 * one. Real `Tab` traversal keeps the modality keyboard end to end, and the
 * `:focus-visible` assertion is what would catch it if that stopped being true.
 * Same reasoning, same wording, as `focus-visible.visual.spec.ts`'s header.
 *
 * ── Scope: desktop only, and that is the config's doing, not a claim ─────────
 *
 * `chromium-mobile` declares `testMatch: ['**\/*.mobile.spec.ts']`, so this file
 * runs under `chromium-desktop` alone in `test:e2e:gate`. Stated because the
 * band's controls DO reflow at 390px (`flex-wrap`), and this spec makes no
 * claim about that width — #1797's rule is that a desktop proof may not be
 * reused where it was not taken. The property under test is a computed colour
 * rather than a layout, so it is width-independent in a way a capture would not
 * be; a mobile file would be about the wrap, which is a different question.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * The three controls, by route, by the BAND they live in, and by their
 * accessible name. Located semantically rather than by class string, for the
 * reason #1811/#1820 gave: the class string is what this gate is under contract
 * to check, so it must not also be what the gate trusts to find its subject.
 *
 * **The band is part of the locator because the name alone is ambiguous, and
 * that was measured rather than anticipated.** The first draft used
 * `getByRole('link', { name })` page-wide and `toHaveCount(1)` failed on all
 * three: the landing page's hero carries its own `<Button href="/signup">Get
 * early access</Button>`, and `investor-briefing` reaches `CONTACT_TEAM_HREF`
 * from three controls. Two of those extras are real `Button`s with the ordinary
 * light-surface `ring-brand/80`, so a page-wide locator that happened to match
 * one of them would have asserted a WHITE ring on a control that correctly has
 * a brand one — a test failing for the right-looking wrong reason.
 *
 * `heading` is the band's own `<h2>`, which is semantic contract and the thing
 * a reader uses to identify the band too.
 */
const BAND_CTAS = [
  {
    route: '/',
    heading: 'Ready to put your agents to work?',
    name: 'Get early access',
    variant: 'solid',
  },
  {
    route: '/',
    heading: 'Ready to put your agents to work?',
    name: 'Read the technical overview',
    variant: 'translucent',
  },
  {
    route: '/investor-briefing',
    heading: 'Haven is building the account layer for agents that pay.',
    name: 'Contact the team',
    variant: 'solid',
  },
] as const

/**
 * Press Tab until `document.activeElement` IS the target node. Bounded, and it
 * throws naming the control rather than falling back to `.focus()` — a control
 * reachable by script but not by tab order is a WCAG 2.4.3 finding in its own
 * right, and substituting the driver would hide it.
 *
 * The bound is generous because these are the LAST controls on long marketing
 * pages: the landing page's band sits below the header nav, six sections of
 * links and a footer.
 */
async function tabToTarget(page: Page, target: Locator, label: string, max = 200) {
  const handle = await target.elementHandle()
  if (!handle) throw new Error(`focus gate: "${label}" is not attached — nothing to tab to`)
  for (let presses = 1; presses <= max; presses++) {
    await page.keyboard.press('Tab')
    if (await page.evaluate((el) => document.activeElement === el, handle)) return presses
  }
  throw new Error(
    `focus gate: "${label}" was NOT reachable by keyboard Tab within ${max} presses. ` +
      `Do not "fix" this by substituting .focus() — see this spec's header.`,
  )
}

/**
 * Split a computed `box-shadow` into layers that actually PAINT — non-transparent
 * colour AND non-zero geometry — and return them.
 *
 * Both halves of that conjunction are load-bearing, and neither is obvious.
 * `ring-2` always emits a `--tw-ring-offset-shadow` layer, opaque white by
 * default and ZERO-SIZED; a colour-only check accepts it and passes a control
 * whose real ring is `ring-transparent`. Conversely the real ring under that
 * mutation has size and no colour. The trap is documented at length in
 * `focus-visible.visual.spec.ts`, where it went green on a control with no ring
 * and only a pixel capture caught it. Repeated here rather than imported
 * because that file is a Playwright spec: importing from it would re-register
 * its eleven tests inside this one.
 */
interface ShadowLayer {
  raw: string
  rgb: [number, number, number]
  alpha: number
  /** The 4th length — offsetX, offsetY, blur, SPREAD. */
  spread: number
}

function paintingLayers(boxShadow: string): ShadowLayer[] {
  if (boxShadow === 'none') return []
  // Paren-aware split: `rgba(0, 0, 0, 0)` contains the layer delimiter itself.
  const layers: string[] = []
  let depth = 0
  let current = ''
  for (const ch of boxShadow) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      layers.push(current)
      current = ''
    } else current += ch
  }
  layers.push(current)

  const parsed: ShadowLayer[] = []
  for (const raw of layers) {
    const colour = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+)\s*)?\)/i.exec(raw)
    if (!colour) continue
    const alpha = colour[4] === undefined ? 1 : Number(colour[4])
    if (alpha === 0) continue
    // Lengths OUTSIDE the colour function — `rgb(255, 255, 255)`'s own numbers
    // are not geometry.
    const lengths = (raw.replace(/rgba?\([^)]*\)/gi, ' ').match(/-?[\d.]+px/g) ?? []).map(
      parseFloat,
    )
    if (!lengths.some((l) => l !== 0)) continue
    parsed.push({
      raw: raw.trim(),
      rgb: [Number(colour[1]), Number(colour[2]), Number(colour[3])],
      alpha,
      spread: lengths[3] ?? 0,
    })
  }
  return parsed
}

test.describe('dark-band CTAs indicate focus (#1867)', () => {
  for (const cta of BAND_CTAS) {
    test(`${cta.route} — "${cta.name}" (${cta.variant}) paints a white focus ring`, async ({
      page,
    }) => {
      // `networkidle` is load-bearing here and NOT belt-and-braces: without it
      // this spec flaked on `locator.scrollIntoViewIfNeeded: Element is not
      // attached to the DOM`, one test in three, on a run where the other two
      // passed. React hydration REPLACES the anchor node some milliseconds
      // after `load`, so a locator resolved before that points at a detached
      // element — and `toBeVisible()` cannot save it, because the assertion
      // passes against the pre-hydration node and the detach happens in the gap
      // before the next call. Caught by running the spec repeatedly rather than
      // once; a green first run would have shipped it.
      await page.goto(cta.route)
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => document.fonts.ready)

      const band = page
        .locator('section[data-v2-dark-section]')
        .filter({ has: page.getByRole('heading', { name: cta.heading, exact: true }) })
      await expect(
        band,
        `${cta.route}: the dark CTA band headed "${cta.heading}" is not there exactly once`,
      ).toHaveCount(1)

      const target = band.getByRole('link', { name: cta.name, exact: true })
      await expect(target).toHaveCount(1)
      await expect(target).toBeVisible()

      // No explicit scroll. The browser scrolls a focused element into view on
      // its own, so the scroll bought nothing that `tabToTarget` does not, and
      // it was the call that surfaced the hydration race above — one fewer
      // handle taken before hydration settles is one fewer node to detach.
      await tabToTarget(page, target, `${cta.route} · ${cta.name}`)

      const state = await target.evaluate((el) => {
        const s = getComputedStyle(el)
        return {
          isActive: document.activeElement === el,
          focusVisible: el.matches(':focus-visible'),
          boxShadow: s.boxShadow,
          // Read from the live stylesheet rather than copied into this file as
          // a hex, so a palette change moves the expectation with the token
          // instead of turning this spec into a stale second source of truth.
          brand: getComputedStyle(document.documentElement)
            .getPropertyValue('--v2-brand')
            .trim(),
        }
      })

      expect(state.isActive, `${cta.name}: expected it to hold focus`).toBe(true)
      expect(
        state.focusVisible,
        `${cta.name}: focus landed but :focus-visible did not match, so the ring's own CSS ` +
          `condition is false and nothing would paint`,
      ).toBe(true)

      const painting = paintingLayers(state.boxShadow)
      expect(
        painting.length,
        `${cta.name}: focused and :focus-visible, but the computed box-shadow paints NO ` +
          `visible ring — ${state.boxShadow}. A class string present in source can still ` +
          `compile to nothing (#1818).`,
      ).toBeGreaterThan(0)

      // ── The TONE, and WHICH LAYER carries it ──────────────────────────────
      //
      // The first draft of this assertion picked the layer whose geometry
      // mentioned `2px` and measured **rgb(79, 70, 229)** on all three controls
      // — `--v2-brand`. That is not a defect in the fix, it is the OFFSET layer:
      // Tailwind emits `--tw-ring-offset-shadow` at spread = the offset width
      // (2px) and `--tw-ring-shadow` at spread = ring + offset (4px), so `2px`
      // matched the moat and never the ring. It would have failed a correct
      // control while reporting the offset colour as "the ring", which is
      // exactly the confidently-wrong-evidence shape this repo keeps paying for
      // (#1800). Found by RUNNING it; no amount of reading the class string
      // would have said so.
      //
      // The ring is therefore identified by being the OUTERMOST painting layer
      // — largest spread — which is also what a user sees as the ring.
      //
      // **Do not copy this heuristic onto a `ring-inset` control.** It holds
      // because these three are `ring-2 ring-offset-2`: the offset layer's
      // spread is the offset width and the ring layer's is ring + offset, so
      // larger spread really does mean further out. An inset ring paints
      // INWARD (`--tw-ring-inset: inset`) and its spread orders differently;
      // `Row` and several icon buttons use that form for the clipping reason
      // documented in design-system.md § Focus rings. A spec covering one of
      // those needs to read the `inset` keyword, not just the numbers.
      const outermost = painting.reduce((a, b) => (b.spread > a.spread ? b : a))
      expect(
        outermost.rgb,
        `${cta.name}: the ring on a dark brand band must be WHITE — measured ` +
          `rgb(${outermost.rgb.join(', ')}) on the outermost layer "${outermost.raw}". See ` +
          `design-system.md § Focus rings: brand indigo tops out below 3:1 on a dark fill ` +
          `at FULL opacity, so no alpha rescues it.`,
      ).toEqual([255, 255, 255])
      expect(
        outermost.alpha,
        `${cta.name}: every focus ring in this system is /80 — measured ${outermost.alpha}`,
      ).toBeCloseTo(0.8, 5)

      // And the moat, which is the reason the ring is legible at all: an
      // un-offset ring would paint onto the band it is supposed to stand out
      // from. Its colour is the band's own, so this is also what pins the ring
      // as being offset onto `--v2-brand` rather than the page's `--v2-bg`.
      const brandHex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(state.brand)
      expect(
        brandHex,
        `could not read --v2-brand from the live stylesheet (got "${state.brand}")`,
      ).not.toBeNull()
      const brandRgb = [brandHex![1], brandHex![2], brandHex![3]].map((h) => parseInt(h, 16))

      const moat = painting.find((layer) => layer !== outermost && layer.spread > 0)
      expect(
        moat?.rgb,
        `${cta.name}: the ring must be offset onto the BAND (--v2-brand = ${state.brand}), not ` +
          `the page — box-shadow ${state.boxShadow}`,
      ).toEqual(brandRgb)
    })
  }
})
