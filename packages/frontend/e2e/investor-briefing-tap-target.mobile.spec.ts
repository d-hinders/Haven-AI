import { expect, test, type Page } from '@playwright/test'

/**
 * `/investor-briefing`'s sticky-header CTA — tap target (#1955).
 *
 * `InvestorButton` renders `size="sm"` as `h-9 px-3.5 text-[13px]`: 36px tall.
 * The sticky header uses exactly that size, so `sticky top-0` keeps a 36px
 * control on screen for the whole 6,140px page. `docs/product/design-review.md`
 * § Responsive And States asks for ≥44px on a primary mobile touch target, or
 * an expanded hit area when the control is visually compact — this one had
 * neither. `ui/Button` solves the same problem with a transparent `::after`
 * overlay (#1726/#1766); this marketing button borrowed it.
 *
 * MEASURED on `/investor-briefing` under Pixel 5 emulation (393px), before:
 *
 *   painted box              150 x 36
 *   MEASURED hit rectangle   150 x 36   ← the border box and nothing more
 *
 * ...and after:
 *
 *   painted box              150 x 36   (unchanged — that is the point)
 *   MEASURED hit rectangle   150 x 44
 *
 * ── Why the number is walked and not read off a class string ────────────────
 * The cheap version of this test — assert the className contains `after:h-11` —
 * proves the string was typed, not that a finger reaches anything. A `::after`
 * overlay fails in ways a string cannot show: a missing `content`, a
 * positioning context that resolves on some ancestor, a clipping parent, or
 * another element winning the stacking contest in that band. This page has a
 * `sticky` header and a `backdrop-blur` band, so all four are live risks. jsdom
 * has no layout and no hit-testing, so none of it exists there either.
 * `elementFromPoint` in a real engine answers the only question worth asking:
 * what would a tap here actually reach. Same instrument, same reasoning, as
 * `mobile-nav-tap-target.mobile.spec.ts` (#1766).
 *
 * ── Why a compliant control is measured in the same run ─────────────────────
 * A reading of 36 is only evidence if this harness can report 44 when 44 is
 * real. The hero's `size="lg"` CTA paints 44px with no overlay at all and is
 * measured alongside on every run, so a walk that has silently stopped seeing
 * anything reports 36 for BOTH and the run goes red on the wrong assertion
 * rather than passing in silence. That validation is the reason the pre-fix 36
 * above is a measurement and not an absence of one. (The hero's lg CTA is now
 * "View product thesis" — #1956 removed the hero's duplicate
 * "Contact the team" pair, so the instrument anchors on the surviving one.)
 *
 * ── Both halves of the invariant ────────────────────────────────────────────
 * Reaching 44px is half the promise. The other half is that NOTHING MOVED: a
 * test that only checks the hit area passes just as happily if someone
 * "fixes" this by raising the paint to `h-11`, which the issue explicitly
 * refuses ("Do not raise the painted height — the header band's density depends
 * on it"). The painted box is pinned at 36px in the same pass.
 *
 * Marketing surfaces are design-lint-exempt (#874), so this file is the ONLY
 * thing standing between this control and a silent recurrence.
 */

/** `h-9`. Pinned so a paint-raising "fix" is as red as no fix at all. */
const PAINTED_PX = 36
/** The comfort target `docs/product/design-review.md` § Responsive And States asks for. */
const COMFORTABLE_TAP_TARGET_PX = 44
/** `h-11` — the hero CTA, compliant by paint, and this run's instrument check. */
const HERO_PAINTED_PX = 44

type Measurement = {
  painted: { w: number; h: number }
  hit: { w: number; h: number }
  /** What a tap 4px above and below the painted box actually lands on. */
  overhang: { above: string; below: string }
}

async function measure(page: Page): Promise<{
  header: Measurement
  hero: Measurement
  headerIsInHeader: boolean
}> {
  return page.evaluate(() => {
    const walk = (el: Element, ox: number, oy: number, dx: number, dy: number) => {
      let n = 0
      // Cap must exceed the element's own half extent or the walk stops on the
      // CAP and reports a false "something is covering this" (#1766's red run).
      while (n < 200) {
        const x = ox + dx * (n + 1)
        const y = oy + dy * (n + 1)
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) break
        const top = document.elementFromPoint(x, y)
        if (!(!!top && (top === el || el.contains(top)))) break
        n += 1
      }
      return n
    }

    const describe = (el: Element, x: number, y: number) => {
      const top = document.elementFromPoint(x, y)
      if (!top) return 'nothing'
      if (top === el || el.contains(top)) return 'CTA'
      return `${top.tagName.toLowerCase()}.${String(top.className).trim().split(/\s+/).slice(0, 2).join('.')}`
    }

    const read = (el: Element) => {
      const b = el.getBoundingClientRect()
      const cx = Math.round(b.left + b.width / 2)
      const cy = Math.round(b.top + b.height / 2)
      return {
        painted: { w: Math.round(b.width), h: Math.round(b.height) },
        hit: {
          w: walk(el, cx, cy, -1, 0) + walk(el, cx, cy, 1, 0) + 1,
          h: walk(el, cx, cy, 0, -1) + walk(el, cx, cy, 0, 1) + 1,
        },
        overhang: {
          above: describe(el, cx, Math.round(b.top) - 3),
          below: describe(el, cx, Math.round(b.bottom) + 2),
        },
      }
    }

    const header = document.querySelector('header')
    const contacts = Array.from(document.querySelectorAll('a')).filter(
      (a) => (a.textContent ?? '').trim() === 'Contact the team',
    )
    const headerCta = contacts.find((a) => !!header && header.contains(a))
    // Instrument anchor. The hero no longer repeats the header CTA (#1956); its
    // remaining `size="lg"` CTA ("View product thesis") paints 44px in exactly
    // the old position — same InvestorButton, same geometry — so the instrument
    // check below keeps its bite unchanged.
    const heroCta = Array.from(document.querySelectorAll('a')).find(
      (a) => (a.textContent ?? '').trim() === 'View product thesis',
    )
    if (!headerCta || !heroCta) {
      throw new Error(
        `expected a header "Contact the team" CTA and a hero "View product thesis" CTA, found ${contacts.length} contact links`,
      )
    }

    return {
      header: read(headerCta),
      hero: read(heroCta),
      headerIsInHeader: !!header && header.contains(headerCta),
    }
  })
}

test.describe('/investor-briefing sticky-header CTA', () => {
  test('reaches a 44px tap target without painting one pixel wider', async ({ page }) => {
    await page.goto('/investor-briefing')
    await page.evaluate(() => document.fonts.ready)

    const m = await measure(page)

    // The instrument check, asserted FIRST and deliberately not as a comment.
    // If the walk has stopped seeing real geometry, this is what goes red, and
    // the header reading below never gets mistaken for evidence.
    expect(
      m.hero.painted.h,
      'the hero CTA should paint 44px — if not, the page changed, not the instrument',
    ).toBe(HERO_PAINTED_PX)
    expect(
      m.hero.hit.h,
      'a walk that cannot report 44 for a control that IS 44 cannot report 36 either',
    ).toBeGreaterThanOrEqual(HERO_PAINTED_PX)

    expect(m.headerIsInHeader).toBe(true)

    // The fix: the hit rectangle, walked with `elementFromPoint`.
    expect(
      m.header.hit.h,
      `header CTA hit height ${m.header.hit.h}px; 3px above it lands on ${m.header.overhang.above}, 2px below on ${m.header.overhang.below}`,
    ).toBeGreaterThanOrEqual(COMFORTABLE_TAP_TARGET_PX)

    // The other half: nothing moved. `h-11` instead of the overlay would pass
    // the line above and fail this one, which is the point.
    expect(m.header.painted.h, 'the painted height must not grow — #1955').toBe(PAINTED_PX)

    // Vertical only (#1726): a sideways overlay would swallow a neighbour's
    // taps. The header row is over-subscribed on a phone, so this matters here.
    expect(m.header.hit.w).toBe(m.header.painted.w)

    // The overlay is transparent, so the ONLY thing that says it is live is
    // where a tap outside the painted box lands.
    expect(m.header.overhang.above, 'the overhang above the painted box must reach the CTA').toBe(
      'CTA',
    )
    expect(m.header.overhang.below, 'the overhang below the painted box must reach the CTA').toBe(
      'CTA',
    )
  })
})
