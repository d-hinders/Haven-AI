import { expect, test, type Page } from '@playwright/test'
import {
  mockHavenApi,
  seedAuthenticatedSession,
  serveAgentDetailResponses,
  waitForDrawerOpen,
} from './fixtures/haven-api'

/**
 * Mobile navigation toggle — tap target (#1766).
 *
 * The `Open sidebar` control is the tab bar's fifth slot ("More", #2731): a
 * hand-rolled `<button>` painted `w-1/5` by the tab bar's height, whose
 * geometry is asserted by `measureTabBar` below. Its tap-target history is
 * what this file exists to keep honest about:
 *
 *   - As a 32x32 icon (the original #1766 subject) it sat 12px under the 44px
 *     comfort target `docs/product/design-system.md` § Buttons documents
 *     (#1726) — it was not the `Button` primitive, so it inherited none of
 *     that primitive's invisible hit-area extension, and #1749 had just made
 *     it REACHABLE for the first time (it had hit-tested under the top bar
 *     for the shell's whole life), so the undersized target went from moot to
 *     load-bearing on the entry point to primary navigation. The fix was the
 *     transparent `::after` overlay: 44x44 hit, 32x32 painted.
 *   - #1767 then moved the painted box to `top-3`, centred in the then-56px
 *     bar (y 12-44, centre 28), with the x held at `left-4` on measured
 *     grounds.
 *   - #2730 expressed both offsets with the safe-area tokens
 *     (`top-[calc(0.75rem+var(--v2-safe-top))]`,
 *     `left-[max(1rem,var(--v2-safe-left))]`) — identical numbers wherever
 *     the insets are 0, and the centring survived a real notch because the
 *     bar grew by the same inset.
 *   - #2731 moved the control into the tab bar's fifth slot, where the
 *     painted cell IS the 44px+ target and the overlay retired (#3825's bar
 *     was emptied in the same move; the bar itself is gone since #4029).
 *
 * The walk below does not care which era it is measuring: it reads the LIVE
 * geometry of `button[aria-label="Open sidebar"]` wherever the control
 * currently lives.
 *
 * Pixel conventions, because the two readings differ by one and both appear
 * below: a 44px-wide box spanning x 10-54 has its LAST HITTING PIXEL at x=53.
 * `hit.right` in the measurement is that last hitting pixel (53); "right edge
 * x=54" in the clearance reasoning is the box edge. Same rectangle.
 *
 * ── Why every number below is MEASURED and not read off a class string ───────
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
 */

/**
 * Alignment history — what #1767 measured and why the geometry is what it is.
 * Recorded here because the decisions were measured, not argued, and a future
 * move of the control should inherit the numbers rather than repeat the
 * debate:
 *
 *   - `top-4 left-4` (x 16-48, y 16-48) sat 4px low in the 56px bar; `top-3`
 *     centred it (y 12-44, centre 28).
 *   - The issue also asked for `left-6`, making the box concentric with the
 *     `w-8` spacer the bar reserved. That half was measured and NOT taken:
 *     `left-6` moves the 44px target's right edge from x=54 to x=62, which
 *     (a) cuts clearance to `NetworkSwitcher` (x=68) from 14px to 6px, under
 *     the 8px § Buttons asks for between adjacent targets, and (b) reaches
 *     PAST x=56 — the centre of the open drawer's Haven logo link — so the
 *     last test in this file goes red. A spacer's job is to keep the bar's
 *     content clear of a floating control, not to be concentric with it.
 *   - **The slot was not there at all on a phone.** `w-8` with the default
 *     `flex-shrink: 1` is a suggestion, and the bar's row was
 *     over-subscribed below about 700px: the spacer collapsed to width 0 and
 *     every reserved pixel went to `NetworkSwitcher`. Measured on
 *     `/dashboard` before the fix:
 *
 *       width   slot        toggle box   NetworkSwitcher box   clearance
 *       320     24-24  (0)  16-48        36-212.88             -17px  OVERLAP
 *       390     24-24  (0)  16-48        36-212.88             -17px  OVERLAP
 *       393     24-24  (0)  16-48        36-212.88             -17px  OVERLAP
 *       768     24-56  (32) 16-48        68-244.88             +15px
 *       1023    24-56  (32) 16-48        68-244.88             +15px
 *
 *     The bar reserved the room at the widths where nothing needed reserving
 *     and gave it away at every width a phone actually has. The painted 32px
 *     toggle sat ON TOP of the chip's leading 12px, and #1766's invisible 44px
 *     target took 18 more: `NetworkSwitcher`'s own hit rectangle started at
 *     x=54 instead of its border-box x=36.
 *
 * Why the suite of the time did not catch the collapse, which is the part
 * worth carrying forward: `neighbour` was found with
 * `if (b.left <= box.right) continue` — "the nearest control to the toggle's
 * RIGHT". A control the toggle is sitting on top of has `b.left` inside the
 * toggle, so the filter skipped it and happily measured the next control
 * along (the notification bell, 160px away — the bell has since been deleted
 * by #1989; this records what was measured at the time). The one assertion
 * written to catch a swallowed neighbour could not see a neighbour that had
 * already been swallowed. That is the lesson that made the tab-bar era's
 * assertions structural (the seam between adjacent cells is an EQUALITY, not
 * a floor).
 *
 * `320` and `1023` alone could not have caught the collapse either, even with
 * the right filter, because at both of those the OLD failure and the OLD pass
 * looked the same shape. 390 is included deliberately: it is the width
 * `evidence-viewports` renders the mobile baseline at, and the width a
 * Pixel/iPhone actually has.
 */

// The toggle is `lg:hidden`. Four widths: the narrowest phone we support, the
// width the visual baseline and the design evidence render at, a tablet (768,
// the first of these widths where #4058's `max-w-md` cap and centring apply —
// the cap bites above 472px, 448 plus two 12px insets), and the last pixel
// below the `lg` breakpoint where a regression would most plausibly
// reappear. (`mobile-nav-layering.mobile.spec.ts` already proves the toggle
// vanishes AT 1024px.)
const WIDTHS = [320, 390, 768, 1023]

const COMFORTABLE_TAP_TARGET_PX = 44
/**
 * The page back link's measured hit HEIGHT (#4028). It moved out of the
 * (since deleted, #4029) top bar into the page, drawn at text height (about
 * 20px) with a transparent `::after` extending its target to 44px, Button's
 * mechanism (#1726). So this is the comfort target itself, measured the way a
 * finger meets it, not the "not collapsed" floor the bar's 13px text link
 * used to get. Width is not extended (the label already makes it wide), so
 * width gets the old floor.
 */
const BACK_LINK_MIN_HIT_PX = COMFORTABLE_TAP_TARGET_PX
const BACK_LINK_MIN_HIT_W_PX = 12

type Measurement = {
  painted: { w: number; h: number }
  hit: { left: number; right: number; top: number; bottom: number; w: number; h: number }
  corners: Record<string, string>
  /**
   * Where the app frame starts. The toggle is `fixed`, so it consumes NO
   * layout — the frame it floats over begins at the viewport edge. See the
   * assertion. (This was the top bar's `<header>` left edge until #4029
   * deleted the bar; a bare `querySelector('header')` now finds
   * `PageHeader`'s in-page header, so the anchor moved to the frame.)
   */
  frameLeft: number
  /** Centre of the PAINTED box — what has to line up with the tab bar slot. */
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

      // The VIEWPORT-ABSOLUTE anchor. The toggle is `fixed` and consumes NO
      // layout, so the frame it floats over must begin at the viewport edge —
      // the same absolute anchor #1767 pinned on the top bar's `<header>`,
      // moved to `[data-app-frame]` when the bar was deleted (#4029). A bare
      // `querySelector('header')` would now find `PageHeader`'s in-page
      // header, which is exactly the silent re-point this suite refuses.
      const frame = document.querySelector('[data-app-frame]')!
      const frameBox = frame.getBoundingClientRect()

      return {
        painted: { w: Math.round(box.width), h: Math.round(box.height) },
        hit: { left: cx - l, right: cx + r, top: cy - u, bottom: cy + d, w: l + r + 1, h: u + d + 1 },
        corners,
        frameLeft: Math.round(frameBox.left),
        centre: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
      }
    },
    { half: Math.floor(COMFORTABLE_TAP_TARGET_PX / 2) },
  )
}

/**
 * The page's back link (#4028), measured the way the deleted `measureBar`
 * measured a bar control: a hit rectangle walked with `elementFromPoint` out
 * from its centre, so a transparent `::after` target counts and a covered
 * pixel does not.
 */
async function measurePageBackLink(page: Page, href: string) {
  return page.evaluate((target) => {
    const el = document.querySelector<HTMLElement>(`#main-content a[href="${target}"]`)!
    const walk = (ox: number, oy: number, dx: number, dy: number, cap: number) => {
      let n = 0
      while (n < cap) {
        const x = ox + dx * (n + 1)
        const y = oy + dy * (n + 1)
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) break
        const top = document.elementFromPoint(x, y)
        if (!(!!top && (top === el || el.contains(top)))) break
        n += 1
      }
      return n
    }
    const b = el.getBoundingClientRect()
    const cx = Math.round(b.left + b.width / 2)
    const cy = Math.round(b.top + b.height / 2)
    const top = document.elementFromPoint(cx, cy)
    const cap = 40
    const h1 = document.querySelector<HTMLElement>('#main-content h1')
    return {
      label: (el.textContent || '').trim(),
      left: Math.round(b.left),
      right: Math.round(b.right),
      bottom: Math.round(b.bottom),
      titleTop: h1 ? Math.round(h1.getBoundingClientRect().top) : Number.POSITIVE_INFINITY,
      painted: { w: Math.round(b.width), h: Math.round(b.height) },
      reachableAtCentre: !!top && (top === el || el.contains(top)),
      hit: {
        w: walk(cx, cy, -1, 0, cap) + walk(cx, cy, 1, 0, cap) + 1,
        h: walk(cx, cy, 0, -1, cap) + walk(cx, cy, 0, 1, cap) + 1,
      },
    }
  }, href)
}

/**
 * The bottom tab bar's geometry (#2731), which is where the toggle went.
 *
 * Read from the LIVE elements rather than from classes: the bar's slots are
 * `grid-cols-5` cells and the More control is a `w-1/5` sibling, so "they line
 * up" is an arithmetic claim about two independently positioned boxes and is
 * exactly the kind that a class read cannot check.
 */
async function measureTabBar(page: import('@playwright/test').Page) {
  return page.evaluate(({ half }) => {
    const bar = document.querySelector<HTMLElement>('[data-mobile-tab-bar]')
    const more = document.querySelector<HTMLElement>('button[aria-label="Open sidebar"]')
    if (!bar || !more) return null
    const tabs = Array.from(bar.querySelectorAll<HTMLElement>('a[href]')).map((el) => ({
      href: el.getAttribute('href'),
      current: el.getAttribute('aria-current'),
      box: el.getBoundingClientRect(),
    }))
    const moreBox = more.getBoundingClientRect()
    const barBox = bar.getBoundingClientRect()
    const main = document.querySelector<HTMLElement>('main')!
    const at = (x: number, y: number) => {
      const el = document.elementFromPoint(Math.round(x), Math.round(y))
      if (!el) return 'NOTHING'
      if (el === more || more.contains(el)) return 'MORE'
      return el.tagName.toLowerCase()
    }
    return {
      slots: [...tabs.map((t) => ({ w: Math.round(t.box.width), h: Math.round(t.box.height) })), {
        w: Math.round(moreBox.width),
        h: Math.round(moreBox.height),
      }],
      hrefs: tabs.map((t) => t.href),
      current: tabs.filter((t) => t.current === 'page').map((t) => t.href),
      // The More cell against the last TAB: they must meet, not overlap and
      // not leave a dead strip a thumb can land in.
      seam: tabs.length
        ? Math.round(moreBox.left) - Math.round(tabs[tabs.length - 1].box.right)
        : null,
      moreCorners: {
        centre: at(moreBox.left + moreBox.width / 2, moreBox.top + moreBox.height / 2),
        topLeft: at(moreBox.left + 1, moreBox.top + 1),
        topRight: at(moreBox.right - 1, moreBox.top + 1),
        // `moreBox.bottom - 1`, not `top + half`. The old reading probed 22px
        // into a 57px box, so the cross-shaped target this assertion exists to
        // reject would have passed with its bottom 35px dead.
        bottomLeft: at(moreBox.left + 1, moreBox.bottom - 1),
        bottomRight: at(moreBox.right - 1, moreBox.bottom - 1),
      },
      // Floating since #4058: the gaps to the viewport's bottom and sides.
      barBottomGap: Math.round(window.innerHeight - barBox.bottom),
      barLeftGap: Math.round(barBox.left),
      barRightGap: Math.round(window.innerWidth - barBox.right),
      barWidth: Math.round(barBox.width),
      // What `<main>` reserves for it. The bar is `fixed` and consumes no
      // layout, so this padding is the only thing keeping the last row out
      // from under it.
      mainPaddingBottom: Math.round(
        parseFloat(getComputedStyle(main).paddingBottom || '0'),
      ),
      barHeight: Math.round(barBox.height),
    }
  }, { half: Math.floor(COMFORTABLE_TAP_TARGET_PX / 2) })
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

        // #2731 moved this control out of the (now deleted) top bar and into
        // the bottom tab bar's fifth slot. Assertions 1-8 below are the SAME
        // questions translated to that geometry, not a smaller set: a hit
        // area, its corners, its painted size, its neighbour, the absolute
        // anchor, the reservation that keeps content clear of it, its
        // placement in its own band, and what landmark the chrome exposes.
        const t = (await measureTabBar(page))!
        expect(t, 'the tab bar did not render').not.toBeNull()

        // 1. Every one of the five slots is a comfortable target — not just
        //    More. The old control needed an invisible overlay to reach 44px;
        //    these are 44px of painted cell, which is why (3) inverts.
        expect(t.slots).toHaveLength(5)
        for (const slot of t.slots) {
          expect(slot.w).toBeGreaterThanOrEqual(COMFORTABLE_TAP_TARGET_PX)
          expect(slot.h).toBeGreaterThanOrEqual(COMFORTABLE_TAP_TARGET_PX)
        }

        // 2. ...and the corners of More's area, not just its width. Same
        //    reasoning as before: a 44x44 cross-shaped target passes (1).
        expect(t.moreCorners).toEqual({
          centre: 'MORE',
          topLeft: 'MORE',
          topRight: 'MORE',
          bottomLeft: 'MORE',
          bottomRight: 'MORE',
        })

        // 3. The painted box IS the target now, and that is the change. The
        //    old assertion pinned 32px painted so a "fix" could not simply
        //    grow the visible control; here growing it is the design, so what
        //    replaces that guard is exactness: More is one fifth of the bar's
        //    content box, the same size as the tabs beside it. Since #4058
        //    the bar floats, so the fifth is of the pill (its 2px side
        //    padding and 1px border each side excluded), not of the viewport.
        for (const slot of t.slots) {
          expect(Math.abs(slot.w - t.slots[4].w)).toBeLessThanOrEqual(1)
          expect(slot.h).toBe(t.slots[4].h)
        }
        expect(Math.abs(t.slots[4].w - (t.barWidth - 6) / 5)).toBeLessThanOrEqual(1)

        // 4. It did not eat its neighbour, and did not leave a dead strip
        //    either. The old neighbour was `NetworkSwitcher` 14px away in the
        //    header row; the new one is the last tab, and tabs ABUT by design,
        //    so the floor becomes an equality. A negative seam is an overlap
        //    (a thumb on Accounts opens the sheet); a positive one is a gap
        //    that swallows taps.
        expect(t.seam).toBe(0)

        // 5. Nothing consumes layout. UNCHANGED from the original, and it is
        //    the assertion that earned its place: swapping `fixed` for
        //    `relative` on the old toggle passed every other check while
        //    shifting the whole shell 32px. The frame is the viewport-absolute
        //    anchor since the top bar — the element the old assertion measured
        //    — was deleted (#4029).
        expect(m.frameLeft).toBe(0)

        // 6. `<main>` reserves the bar's height. This replaced the 32px top
        //    bar slot, and it is the same KIND of assertion: a reservation
        //    that a naive edit drops, whose absence is invisible until the
        //    last row of a long page sits under the chrome. The bar is
        //    `fixed`, so nothing else keeps content clear of it.
        expect(t.mainPaddingBottom).toBeGreaterThanOrEqual(t.barHeight + t.barBottomGap)

        // 7. Floating, and placed against the right box (#4058, replacing
        //    #2731's flush, edge-to-edge assertion). The pill sits 12px above
        //    the viewport bottom (`--v2-tab-bar-bottom` with no inset here —
        //    the inset case is safe-area-insets.mobile.spec.ts), at least
        //    12px in from each side, centred, and no wider than `max-w-md`
        //    (448px), so a tablet does not get 200px cells. The failure
        //    shape is the old one — a control placed against the wrong box.
        expect(t.barBottomGap).toBe(12)
        expect(t.barLeftGap).toBeGreaterThanOrEqual(12)
        expect(t.barRightGap).toBeGreaterThanOrEqual(12)
        expect(Math.abs(t.barLeftGap - t.barRightGap)).toBeLessThanOrEqual(1)
        expect(t.barWidth).toBeLessThanOrEqual(448)

        // 8. NO banner landmark (#4029). The top bar was the app's only
        //    `<header>` outside the page; with it deleted the shell renders
        //    no banner at all. `ui/PageHeader` still renders a `<header>` —
        //    inside `<main>`, so it is NOT a banner landmark (a header is a
        //    banner only when it is not nested inside a sectioning root) —
        //    and the assertion must be structural (`getByRole('banner')`),
        //    not attribute-shaped, because a bare
        //    `querySelector('header')` silently re-points at PageHeader's
        //    header the moment the bar is gone. Count 0 on a real engine is
        //    the proof that no chrome header came back.
        expect(await page.getByRole('banner').count()).toBe(0)
      })

      test('on a detail route the back link is in the page, and keeps a 44px target (#4028)', async ({
        page,
      }) => {
        // #3825 left the back link as the one control in the phone bar; #4028
        // moved it into the page, above the title. #4029 deleted the bar that
        // used to hold it, so the link the user reaches is the page's —
        // measured with the same finger's-view walk as the toggle.
        // The shared fixture seeds `agent-e2e` only; the detail page resolves
        // its agent from the list read, so `/agents/agent-research` needs the
        // same overlay every other agent-detail spec uses. (Its absence was
        // the pre-existing "Frontend browser smoke" red on #4037's merge
        // commit — the h1 here was the not-found card's, and the assertions
        // below measured a page that was never the one under test.)
        await serveAgentDetailResponses(page, 'agent-research')
        await page.goto('/agents/agent-research')
        // Wait for the agent's OWN title: the loading branch renders the
        // same BackLink with no h1, and the not-found card has a BackLink
        // above a different h1, so either would measure the wrong thing.
        await expect(page.locator('#main-content h1')).toHaveText('Research agent', { timeout: 60_000 })

        // No banner landmark here either — the bar's absence is a property of
        // the shell, not of one route (see assertion 8 above).
        expect(await page.getByRole('banner').count()).toBe(0)

        const back = await measurePageBackLink(page, '/agents')
        expect(back.label).toBe('Agents')
        // It is the thing a finger reaches at its own centre.
        expect(back.reachableAtCentre).toBe(true)
        // The extended target, measured: 44px tall although it paints ~20px.
        expect(back.hit.h).toBeGreaterThanOrEqual(BACK_LINK_MIN_HIT_PX)
        expect(back.painted.h).toBeLessThan(BACK_LINK_MIN_HIT_PX)
        expect(back.hit.w).toBeGreaterThanOrEqual(BACK_LINK_MIN_HIT_W_PX)
        // Above the page title, inside the viewport, on the left.
        expect(back.left).toBeGreaterThanOrEqual(0)
        expect(back.right).toBeLessThanOrEqual(width / 2)
        expect(Number.isFinite(back.titleTop)).toBe(true)
        expect(back.bottom).toBeLessThanOrEqual(back.titleTop)
      })
    })
  }

  test.describe('at the project viewport', () => {
    // #1749 made this control reachable at all. An overlay is exactly the kind
    // of change that can re-break it — a stray `relative` would un-fix the
    // button (the #1749 defect class) — so the reachability half is
    // re-asserted here with a NON-forced click, which runs Playwright's own
    // hit-test before it fires.
    test('the More cell opens the sheet, and its edge is live', async ({ page }) => {
      await page.goto('/dashboard')
      const open = page.getByRole('button', { name: 'Open sidebar' })
      await open.waitFor()

      // Tap 1px INSIDE the left edge — the seam with the Accounts tab (#2731).
      //
      // The original tapped 4px OUTSIDE the painted box, because the whole of
      // #1766 was an invisible 44px overlay around a 32px control. There is no
      // overlay now: the painted cell IS the target. The analogous pixel-level
      // fact is the seam — one pixel the wrong side of it navigates to
      // /accounts instead of opening the sheet, and a thumb does not know
      // which side it landed on.
      const box = (await open.boundingBox())!
      await page.mouse.click(box.x + 1, box.y + box.height / 2)

      const nav = page.locator('[data-more-sheet]').getByRole('navigation', { name: 'All sections' })
      await expect(nav.getByRole('link', { name: 'Marketplace' })).toBeVisible()

      // ...and the sheet's own ✕ closes it (#4058: the cell is covered).
      await page.getByRole('button', { name: 'Close sidebar' }).click()
      await expect(page.locator('[data-more-sheet]')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible()
    })

    // The OPEN state, which the closed-state measurements above cannot see.
    // Re-aimed by #4053, and inverted by #4058: the sheet now floats OVER the
    // bar, so the claim is that its top row (the account) and its ✕ are each
    // reachable at their own centre, and that the More cell is NOT — it is
    // covered by the sheet or its scrim, never the topmost thing in its slot.
    test('with the sheet open, its account row and ✕ are reachable, and the More cell is covered', async ({ page }) => {
      await page.goto('/dashboard')
      await page.getByRole('button', { name: 'Open sidebar' }).click()

      // Wait for the slide-up to FINISH: hit-testing a moving element lands
      // on a part-way sheet and reports a defect that does not exist.
      await waitForDrawerOpen(page)

      const reach = await page.evaluate(() => {
        const probe = (el: Element) => {
          const b = el.getBoundingClientRect()
          const top = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
          return {
            ok: !!top && (top === el || el.contains(top)),
            takenBy: top
              ? `${top.tagName.toLowerCase()}.${String(top.className).trim().split(/\s+/).slice(0, 2).join('.')}`
              : 'nothing',
          }
        }
        const account = document.querySelector('[data-more-sheet] a[href="/profile"]')!
        const close = document.querySelector('[data-more-sheet-close]')!
        const more = document.querySelector('[data-more-toggle]')!
        const mb = more.getBoundingClientRect()
        const atMore = document.elementFromPoint(Math.round(mb.left + mb.width / 2), Math.round(mb.top + mb.height / 2))
        return {
          account: probe(account),
          close: probe(close),
          moreCoveredBy: atMore?.closest('[data-more-sheet]')
            ? 'sheet'
            : atMore?.closest('[data-more-sheet-scrim]')
              ? 'scrim'
              : (atMore?.tagName.toLowerCase() ?? 'nothing'),
        }
      })
      expect(reach.account, `account row taken by ${reach.account.takenBy}`).toMatchObject({ ok: true })
      expect(reach.close, `✕ taken by ${reach.close.takenBy}`).toMatchObject({ ok: true })
      expect(['sheet', 'scrim']).toContain(reach.moreCoveredBy)
    })
  })
})
