import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

/**
 * Mobile navigation toggle — tap target (#1766).
 *
 * The `Open sidebar` toggle paints a 32x32 box, 12px under the 44px comfort
 * target `docs/product/design-system.md` § Buttons documents (#1726). It is a
 * hand-rolled `<button>`, not the `Button` primitive, so it inherited none of
 * that primitive's invisible hit-area extension. #1749 had just made this
 * control REACHABLE for the first time below `lg` — it hit-tested under
 * `TopBar` for the whole life of the shell — so the undersized target went from
 * moot to load-bearing on the entry point to primary navigation.
 *
 * Measured on `/dashboard` under Pixel 5 emulation, before the fix:
 *
 *   painted box                        32 x 32   (x 16-48, y 16-48)
 *   MEASURED hit rectangle             32 x 32   (x 16-47, y 16-47)
 *   corners of the intended 44px area  all four land on <header>, not the toggle
 *
 * ...and after it:
 *
 *   painted box                        32 x 32   (unchanged — that is the point)
 *   MEASURED hit rectangle             44 x 44   (x 10-54, y 10-54)
 *   corners of the intended 44px area  all four reach the toggle
 *
 * #1767 then moved the painted box UP to `top-3` (y 12-44, centred in the 56px
 * bar), so the hit rectangle is y 6-50. The x is unchanged at `left-4`, on
 * purpose — see the alignment block below.
 *
 * Pixel conventions, because the two readings differ by one and both appear
 * below: a 44px-wide box spanning x 10-54 has its LAST HITTING PIXEL at x=53.
 * `hit.right` in the measurement is that last hitting pixel (53); "right edge
 * x=54" in the clearance reasoning is the box edge. Same rectangle.
 *
 * ── Why every number above is MEASURED and not read off a class string ───────
 * The obvious cheap test — assert the className contains `after:h-11 after:w-11`
 * — cannot fail for the reason that matters. A pseudo-element overlay is a
 * plausible-looking CSS trick with several silent no-op failure modes: a
 * missing `content`, a positioning context that resolves somewhere else, an
 * ancestor that clips it, or another element winning the stacking contest in
 * that band (which is exactly what #1749 was). jsdom has no layout, no stacking
 * contexts and no hit-testing, so none of that exists there. `elementFromPoint`
 * in a real engine answers the only question worth asking: what would a tap
 * here actually reach.
 *
 * The hit rectangle below is therefore not read from `getBoundingClientRect` —
 * that returns the BORDER box and would report 32x32 even with a working 44px
 * overlay. It is walked outward from the centre one pixel at a time, asking
 * `elementFromPoint` at each step, so it is the rectangle a finger sees.
 *
 * ── Both halves of the invariant ────────────────────────────────────────────
 * The target reaching 44px is only half the promise; the other half is that
 * NOTHING MOVED. A test that only checks the hit area passes just as happily if
 * someone "fixes" this by growing the visible box to `w-11 h-11`, which is the
 * remedy #1726 explicitly rejected (it would crowd `NetworkSwitcher` in this
 * 56px bar and churn the `/design-system` baselines). So the painted box is
 * pinned at 32x32 in the same assertion pass.
 */

/**
 * Alignment — the toggle and the slot `TopBar` reserves for it (#1767).
 *
 * `TopBar` carries `<div className="w-8 shrink-0 lg:hidden" />` and a comment
 * saying it reserves the room for this toggle. Two separate things were wrong
 * with that claim, and the issue only named the first:
 *
 *   1. The toggle was `top-4 left-4` — x 16-48, y 16-48 — 4px low in a 56px
 *      bar. Now `top-3`: y 12-44, centre 28, exactly the band's centre.
 *
 *      The issue also asked for `left-6`, making the box concentric with the
 *      slot at x 24-56. That half was measured and NOT taken, and the numbers
 *      are here so the decision can be argued with rather than repeated:
 *      `left-6` moves the 44px target's right edge from x=54 to x=62, which
 *      (a) cuts clearance to `NetworkSwitcher` (x=68) from 14px to 6px, under
 *      the 8px § Buttons asks for between adjacent targets, and (b) reaches
 *      PAST x=56 — the centre of the open drawer's Haven logo link — so the
 *      last test in this file goes red. Measured, both. A spacer's job is to
 *      keep the bar's content clear of a floating control, not to be
 *      concentric with it, and at `left-4` it clears it by 14px at every
 *      width. That is what (2) makes true.
 *
 *   2. **The slot was not there at all on a phone.** `w-8` with the default
 *      `flex-shrink: 1` is a suggestion, and this row is over-subscribed below
 *      about 700px: the spacer was the only compressible item in the left
 *      region, so it collapsed to width 0 and every reserved pixel went to
 *      `NetworkSwitcher`. Measured on `/dashboard` before the fix:
 *
 *        width   slot        toggle box   NetworkSwitcher box   clearance
 *        320     24-24  (0)  16-48        36-212.88             -17px  OVERLAP
 *        390     24-24  (0)  16-48        36-212.88             -17px  OVERLAP
 *        393     24-24  (0)  16-48        36-212.88             -17px  OVERLAP
 *        768     24-56  (32) 16-48        68-244.88             +15px
 *        1023    24-56  (32) 16-48        68-244.88             +15px
 *
 *      The bar reserved the room at the widths where nothing needed reserving
 *      and gave it away at every width a phone actually has. The painted 32px
 *      toggle sat ON TOP of the chip's leading 12px, and #1766's invisible 44px
 *      target took 18 more: `NetworkSwitcher`'s own hit rectangle started at
 *      x=54 instead of its border-box x=36.
 *
 * Why the suite above did not catch (2), which is the part worth carrying
 * forward: `neighbour` was found with `if (b.left <= box.right) continue` —
 * "the nearest control to the toggle's RIGHT". A control the toggle is sitting
 * on top of has `b.left` inside the toggle, so the filter skipped it and
 * happily measured the next control along (the notification bell, 160px away).
 * The one assertion written to catch a swallowed neighbour could not see a
 * neighbour that had already been swallowed. It now takes the LEFTMOST control
 * in the band, overlapping or not, and compares hit rectangle against hit
 * rectangle rather than against a border box.
 *
 * `320` and `1023` alone could not have caught it either, even with the right
 * filter, because at both of those the OLD failure and the OLD pass looked the
 * same shape. 390 is added deliberately: it is the width `evidence-viewports`
 * renders the mobile baseline at, and the width a Pixel/iPhone actually has.
 */

// The toggle is `lg:hidden`. Three widths: the narrowest phone we support, the
// width the visual baseline and the design evidence render at, and the last
// pixel below the `lg` breakpoint where a regression would most plausibly
// reappear. (`mobile-nav-layering.mobile.spec.ts` already proves the toggle
// vanishes AT 1024px.)
const WIDTHS = [320, 390, 1023]

const PAINTED_PX = 32
const COMFORTABLE_TAP_TARGET_PX = 44
/** `w-8` — what `TopBar`'s spacer must actually measure, not merely declare. */
const RESERVED_SLOT_PX = 32
/** `h-14` — the bar the toggle has to be centred in. The spacer cannot say: it
 *  is an empty box in an `items-center` row, so its own height is 0. */
const HEADER_BAND_PX = 56
/**
 * The floor for dead space between the toggle's invisible target (right box
 * edge x=54) and the nearest control's (`NetworkSwitcher`, x=68): 14px, and now
 * 14px at EVERY width rather than 14px on a tablet and MINUS 17px on a phone.
 *
 * Asserted as a floor rather than left as a comment because the two ways to
 * close it are both one-word edits someone will plausibly make: moving the
 * toggle right (#1767 proposed `left-6`, which lands at 6px — under the 8px
 * § Buttons asks for between adjacent targets) or letting the slot shrink
 * again. It has been both.
 */
const MIN_NEIGHBOUR_CLEARANCE_PX = 14

type Measurement = {
  painted: { w: number; h: number }
  hit: { left: number; right: number; top: number; bottom: number; w: number; h: number }
  corners: Record<string, string>
  /**
   * The LEFTMOST interactive control in the toggle's band inside the top bar —
   * overlapping the toggle or not. `left`/`right` are its border box; `hitLeft`
   * is its own measured hit rectangle, which is the edge that matters: a
   * neighbour whose taps the toggle's overlay is stealing reports a `hitLeft`
   * well right of its `left`, and nothing else in this suite would say so.
   */
  neighbour: { label: string; left: number; right: number; hitLeft: number } | null
  /**
   * Where the top bar starts. The toggle is `fixed`, so it consumes NO layout —
   * the bar it floats over begins at the viewport edge. See the assertion.
   */
  headerLeft: number
  /** Worst overlap between two consecutive controls inside the bar, in px. */
  worstBarOverlap: number
  /** The `w-8 shrink-0 lg:hidden` spacer: the room `TopBar` claims to reserve. */
  slot: { left: number; right: number; width: number; centreX: number } | null
  /** The bar itself. Height, because the spacer's own height is 0. */
  band: { height: number; centreY: number }
  /** Centre of the PAINTED box — what has to line up with the slot and band. */
  centre: { x: number; y: number }
}

/**
 * Everything the fix promises, measured against ONE page load.
 *
 * Deliberately not split per assertion: each test costs a full navigation, and
 * this suite is meant to stay fast enough to gate every pull request (#1768).
 */
async function measureToggle(page: Page): Promise<Measurement> {
  return page.evaluate(
    ({ half }) => {
      const btn = document.querySelector('button[aria-label="Open sidebar"]') as HTMLElement
      const box = btn.getBoundingClientRect()
      const cx = Math.round(box.left + box.width / 2)
      const cy = Math.round(box.top + box.height / 2)

      // Walk outward from an element's centre until a tap stops landing on it.
      // This is the hit rectangle — the border box plus whatever an overlay
      // adds, minus whatever another element has taken — and it is the only
      // measurement that can tell a working overlay from an inert one, or a
      // neighbour whose taps are being stolen from one that is intact.
      const walkFrom = (
        el: HTMLElement,
        ox: number,
        oy: number,
        dx: number,
        dy: number,
        // Steps to try before giving up. Must exceed the element's own half
        // extent or the walk stops on the CAP and reports a hit rectangle
        // smaller than the border box — a false "something is covering this".
        // It cost one red run on a 177px-wide neighbour with the cap at 80.
        max = 80,
      ) => {
        let n = 0
        while (n < max) {
          const x = ox + dx * (n + 1)
          const y = oy + dy * (n + 1)
          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) break
          const top = document.elementFromPoint(x, y)
          if (!(!!top && (top === el || el.contains(top)))) break
          n += 1
        }
        return n
      }
      const reaches = (x: number, y: number) => {
        const top = document.elementFromPoint(x, y)
        return !!top && (top === btn || btn.contains(top))
      }
      const walk = (dx: number, dy: number) => walkFrom(btn, cx, cy, dx, dy)
      const l = walk(-1, 0)
      const r = walk(1, 0)
      const u = walk(0, -1)
      const d = walk(0, 1)

      // Name what a failing corner actually hit, so a red run says WHAT is in
      // the way rather than just `false` — the first question anyone asks next.
      const describe = (x: number, y: number) => {
        const top = document.elementFromPoint(x, y)
        if (!top) return 'nothing'
        if (top === btn || btn.contains(top)) return 'TOGGLE'
        return `${top.tagName.toLowerCase()}.${String(top.className).trim().split(/\s+/).slice(0, 3).join('.')}`
      }
      const corners = {
        centre: describe(cx, cy),
        topLeft: describe(cx - half + 1, cy - half + 1),
        topRight: describe(cx + half - 1, cy - half + 1),
        bottomLeft: describe(cx - half + 1, cy + half - 1),
        bottomRight: describe(cx + half - 1, cy + half - 1),
      }

      // The LEFTMOST interactive control in the toggle's vertical band. The
      // invisible target must not reach it: an overlay that swallows a
      // neighbour's taps trades one mis-tap for another, and it is invisible by
      // construction, so nothing but a measurement would notice.
      //
      // Deliberately NOT filtered to "controls starting right of the toggle"
      // (#1767). That filter reads as a harmless optimisation and is the exact
      // blind spot: a control the toggle is already sitting on top of starts
      // INSIDE the toggle, so it was skipped, and the next control along —
      // 160px away and in no danger from anything — was measured in its place.
      // The failure this assertion exists for made itself invisible to it.
      const header = document.querySelector('header')!
      let nEl: HTMLElement | null = null
      let nBox: DOMRect | null = null
      for (const el of Array.from(
        header.querySelectorAll<HTMLElement>('button, a[href], [role="button"]'),
      )) {
        const b = el.getBoundingClientRect()
        if (b.width === 0 || b.height === 0) continue
        if (b.bottom < box.top || b.top > box.bottom) continue
        if (!nBox || b.left < nBox.left) {
          nEl = el
          nBox = b
        }
      }
      const neighbour =
        nEl && nBox
          ? {
              label: (nEl.getAttribute('aria-label') || nEl.textContent || nEl.tagName)
                .trim()
                .slice(0, 40),
              left: Math.round(nBox.left),
              right: Math.round(nBox.right),
              // Its OWN hit rectangle's left edge, walked the same way. Equal to
              // `left` when nothing is stealing from it; well right of `left`
              // when the toggle's overlay is.
              hitLeft:
                Math.round(nBox.left + nBox.width / 2) -
                walkFrom(
                  nEl,
                  Math.round(nBox.left + nBox.width / 2),
                  Math.round(nBox.top + nBox.height / 2),
                  -1,
                  0,
                  Math.ceil(nBox.width / 2) + 8,
                ),
            }
          : null

      // Every control in the bar, left to right, and the worst overlap between
      // two consecutive ones. Reclaiming the toggle's 32px has to come out of
      // something in an over-subscribed row: if the widest item cannot
      // truncate, it does not shrink — it OVERFLOWS its parent and paints over
      // the notification bell, which is a different defect of the same shape
      // one control further along.
      let worstBarOverlap = 0
      const inBar = Array.from(
        header.querySelectorAll<HTMLElement>('button, a[href], [role="button"]'),
      )
        .map((el) => el.getBoundingClientRect())
        .filter((b) => b.width > 0 && b.height > 0 && b.bottom >= box.top && b.top <= box.bottom)
        .sort((a, b) => a.left - b.left)
      for (let i = 1; i < inBar.length; i += 1) {
        worstBarOverlap = Math.max(worstBarOverlap, inBar[i - 1].right - inBar[i].left)
      }

      // The room TopBar claims to reserve. `w-8` is a DECLARATION; this is the
      // measurement, and below ~700px they used to disagree completely.
      //
      // Found STRUCTURALLY — the first childless `lg:hidden` box in the bar —
      // not by `div.w-8`. Selecting it by the width class makes the width
      // assertion below unfalsifiable in the one direction that matters: edit
      // `w-8` to anything else and the element simply stops being found, so the
      // failure says "missing" instead of "36px", and a genuine change to the
      // reserved width reads as a broken test rather than a broken promise.
      // (Verified: the mutation that widened the slot reported `null` under the
      // class selector and reports the number under this one.)
      const slotEl =
        Array.from(header.querySelectorAll<HTMLElement>('div[class*="lg:hidden"]')).find(
          (el) => el.children.length === 0 && el.textContent === '',
        ) ?? null
      const slotBox = slotEl?.getBoundingClientRect()
      const headerBox = header.getBoundingClientRect()

      return {
        painted: { w: Math.round(box.width), h: Math.round(box.height) },
        hit: { left: cx - l, right: cx + r, top: cy - u, bottom: cy + d, w: l + r + 1, h: u + d + 1 },
        corners,
        neighbour,
        headerLeft: Math.round(headerBox.left),
        worstBarOverlap: Math.round(worstBarOverlap * 100) / 100,
        slot: slotBox
          ? {
              left: Math.round(slotBox.left),
              right: Math.round(slotBox.right),
              width: Math.round(slotBox.width),
              centreX: Math.round(slotBox.left + slotBox.width / 2),
            }
          : null,
        band: {
          height: Math.round(headerBox.height),
          centreY: Math.round(headerBox.top + headerBox.height / 2),
        },
        centre: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
      }
    },
    { half: Math.floor(COMFORTABLE_TAP_TARGET_PX / 2) },
  )
}

test.describe('mobile navigation toggle tap target (#1766)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const width of WIDTHS) {
    test.describe(`at ${width}px`, () => {
      test.use({ viewport: { width, height: 844 } })

      test('offers a 44px hit area without painting a pixel more', async ({ page }) => {
        await page.goto('/dashboard')
        await page.getByRole('button', { name: 'Open sidebar' }).waitFor()

        const m = await measureToggle(page)

        // 1. The hit rectangle a finger actually sees.
        expect(m.hit.w).toBeGreaterThanOrEqual(COMFORTABLE_TAP_TARGET_PX)
        expect(m.hit.h).toBeGreaterThanOrEqual(COMFORTABLE_TAP_TARGET_PX)

        // 2. ...and the corners of that area, not just its width. A target that
        //    is 44 wide and 44 tall but shaped like a cross would pass (1).
        expect(m.corners).toEqual({
          centre: 'TOGGLE',
          topLeft: 'TOGGLE',
          topRight: 'TOGGLE',
          bottomLeft: 'TOGGLE',
          bottomRight: 'TOGGLE',
        })

        // 3. Nothing moved. The remedy #1726 rejected — grow the visible box —
        //    passes (1) and (2) and fails here.
        expect(m.painted).toEqual({ w: PAINTED_PX, h: PAINTED_PX })

        // 4. The enlarged target did not eat its neighbour. `NetworkSwitcher`
        //    starts at x=68 in this bar; the 44px target's right box edge is
        //    x=62, so its last hitting pixel is x=61 — 6px of clearance.
        //
        //    Asserted twice on purpose, against two different edges. The border
        //    box says the two controls do not overlap; the neighbour's own hit
        //    rectangle says it has not quietly lost tap area to the overlay.
        //    Before #1767 the first was false at 320/390/393 (-17px) and the
        //    second was false by 18px, and neither was visible from here.
        expect(m.neighbour).not.toBeNull()
        expect(m.hit.right).toBeLessThan(m.neighbour!.left)
        expect(m.neighbour!.hitLeft).toBe(m.neighbour!.left)
        expect(m.neighbour!.left - (m.hit.right + 1)).toBeGreaterThanOrEqual(
          MIN_NEIGHBOUR_CLEARANCE_PX,
        )

        // 5. The toggle still consumes NO layout.
        //
        //    Added because the mutation battery found this gap rather than
        //    predicted it: swapping the toggle's `fixed` for `relative` — a
        //    plausible slip when editing this exact className, and the shape of
        //    the #1749 defect — passed assertions 1-4, passed the layering
        //    spec, and passed the horizontal-overflow gate, while shifting the
        //    ENTIRE app shell 32px to the right (measured: `<header>` moved
        //    from x=0 to x=32). Three mobile specs and none of them could see a
        //    32px displacement of everything, because each measures something
        //    relative to a box that moved with it. This is the absolute anchor.
        expect(m.headerLeft).toBe(0)

        // 6. The slot TopBar reserves is REALLY 32px wide (#1767). `w-8` on a
        //    flex item with the default `flex-shrink: 1` is a request, not a
        //    reservation, and in an over-subscribed row it is the first thing
        //    given away: measured 0px at 320/390/393. This is the mechanism
        //    behind (4)'s clearance — without it that clearance is a fact about
        //    tablets only, which is exactly how it was read for two issues.
        expect(m.slot).not.toBeNull()
        expect(m.slot!.width).toBe(RESERVED_SLOT_PX)

        // 7. Vertically centred in the BAND, not in the slot. The slot is an
        //    empty box in an `items-center` row, so its height is 0 and its own
        //    centre is a single line at y=27.5 — measuring against it would
        //    pass for a toggle anywhere from y 12 to y 44, which is the whole
        //    range the fix had to choose within.
        expect(m.band.height).toBe(HEADER_BAND_PX)
        expect(m.centre.y).toBe(m.band.centreY)

        // 8. No two controls IN the bar overlap either (#1767). (6) makes the
        //    bar stop over-promising the toggle's slot; the 32px it stops
        //    giving away has to be absorbed by something, and if nothing can
        //    truncate, the widest item overflows its parent instead of
        //    shrinking — measured, `NetworkSwitcher` kept its intrinsic
        //    176.88px inside a 141px slot and ran 34px under the notification
        //    bell. Same defect as the toggle-over-chip one this issue started
        //    with, one control further along, and invisible to every
        //    toggle-relative assertion above.
        expect(m.worstBarOverlap).toBeLessThanOrEqual(0.5)
      })
    })
  }

  test.describe('at the project viewport', () => {
    // #1749 made this control reachable at all. An overlay is exactly the kind
    // of change that can re-break it — a stray `relative` would un-fix the
    // button and drop it back under `TopBar` — so the reachability half is
    // re-asserted here with a NON-forced click, which runs Playwright's own
    // hit-test before it fires.
    test('the enlarged target still opens the drawer, and its edge is live', async ({ page }) => {
      await page.goto('/dashboard')
      const open = page.getByRole('button', { name: 'Open sidebar' })
      await open.waitFor()

      // Tap 4px OUTSIDE the painted box — inside the overlay, outside the
      // border box. On the pre-fix code this reached `<header>` and opened
      // nothing; it is the single pixel-level fact this whole issue is about.
      const box = (await open.boundingBox())!
      await page.mouse.click(box.x - 4, box.y + box.height / 2)

      const nav = page.getByRole('navigation')
      await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible()

      // ...and the ordinary centre click still closes it.
      await page.getByRole('button', { name: 'Close sidebar' }).click()
      await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible()
    })

    // The OPEN-drawer state, which the closed-state measurements above cannot
    // see. The toggle outranks the drawer (`--v2-z-nav-toggle` 150 vs
    // `--v2-z-nav-drawer` 140) so that one control both opens and closes it —
    // which means the invisible target now also floats over the drawer's own
    // 56px logo band, 6px per edge further than it did before.
    //
    // Raised by review rather than predicted, and worth an assertion rather
    // than a judgement: the 6px looks obviously harmless, but "obviously
    // harmless" is precisely the reasoning that shipped a control nobody could
    // tap (#1749). What must stay true is not "no overlap" — the 32px box
    // already overlapped the logo's leading edge before this PR — but that the
    // Haven logo link is still reachable at its own centre.
    test('the enlarged target does not swallow the open drawer\'s logo link', async ({ page }) => {
      await page.goto('/dashboard')
      await page.getByRole('button', { name: 'Open sidebar' }).click()

      // Wait for the 200ms slide to FINISH. Hit-testing a transforming element
      // lands on a part-way drawer and reports a defect that does not exist —
      // the false failure that hit three of four widths on #1749's first run.
      await page.waitForFunction(
        () => Math.round(document.querySelector('aside')!.getBoundingClientRect().left) === 0,
        undefined,
        { timeout: 10_000 },
      )

      const reach = await page.evaluate(() => {
        const aside = document.querySelector('aside')!
        const logo = aside.querySelector<HTMLElement>('a[href="/dashboard"]')!
        const b = logo.getBoundingClientRect()
        const top = document.elementFromPoint(
          Math.round(b.left + b.width / 2),
          Math.round(b.top + b.height / 2),
        )
        return {
          logoReachableAtItsCentre: !!top && (top === logo || logo.contains(top)),
          // Named, so a red run says WHAT took the tap instead of just `false`.
          takenBy: top
            ? `${top.tagName.toLowerCase()}.${String(top.className).trim().split(/\s+/).slice(0, 2).join('.')}`
            : 'nothing',
        }
      })
      expect(reach).toMatchObject({ logoReachableAtItsCentre: true })
    })
  })
})
