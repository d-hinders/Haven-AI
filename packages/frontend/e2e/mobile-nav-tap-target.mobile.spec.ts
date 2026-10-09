import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, waitForDrawerOpen } from './fixtures/haven-api'

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
 * #2730 rewrote both as `top-[calc(0.75rem+var(--v2-safe-top))]` and
 * `left-[max(1rem,var(--v2-safe-left))]`; both resolve to the same 12px and
 * 16px wherever the safe-area insets are 0, which is every viewport this spec
 * runs at, so every number above still verifies. The centring also survives a
 * non-zero top inset on a real phone, because `TopBar` grows by that same
 * inset: the bar's content band becomes inset..inset+56 and the toggle's centre
 * inset+28.
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
 * happily measured the next control along (the notification bell, 160px away —
 * the bell has since been deleted by #1989; this records what was measured at
 * the time).
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
/**
 * The floor for the gap between two controls INSIDE the bar. 8px is the number
 * § Buttons names for adjacent targets, and the row's own rhythm is `gap-3`
 * (12px), so this is deliberately the weaker of the two — it is here to catch
 * "they touch", not to police the layout's spacing choices.
 */
const MIN_CONTROL_GAP_PX = 8
/**
 * The least a bar control's measured hit rectangle may be on either axis. The
 * back link is a 13px text row, not a 44px target, so this is deliberately a
 * "not collapsed / not covered" floor and not the comfort target.
 */
const BACK_LINK_MIN_HIT_PX = 12

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
  /** Smallest gap between two consecutive controls inside the bar, in px. */
  smallestBarGap: number | null
  /** How many controls sit in the bar's band — what `smallestBarGap` is over. */
  barControlCount: number
  /** Account chips in the header — 0 since #3719 removed the global account picker. */
  accountChipCount: number
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
      // whatever sits one control further along, which is a different defect of
      // the same shape. (That neighbour was the notification bell when this was
      // written; #1989 deleted it. The geometry argument is unchanged — the
      // sweep reads the real bar, not a named control.)
      // Reported as the smallest GAP rather than the worst overlap: "they do
      // not overlap" was satisfied at 390px by two controls touching at exactly
      // 210.61 — a coincidence of the current account name, one line away from
      // this suite rejecting a 6px gap elsewhere as too tight (#1767, raised in
      // design review). A floor is a decision; zero-by-luck is not.
      // Starts at Infinity so `Math.min` works, but an EMPTY set must report
      // null rather than Infinity — `expect(...).not.toBeNull()` passed on a
      // set of zero controls otherwise, which is the guard's own comment
      // describing something it did not do (#2731 review).
      let smallestBarGap = Number.POSITIVE_INFINITY
      const inBar = Array.from(
        header.querySelectorAll<HTMLElement>('button, a[href], [role="button"]'),
      )
        .map((el) => el.getBoundingClientRect())
        // Keyed on the HEADER's own band, not on the toggle's box (#2731).
        // The toggle used to sit inside this row, so its box was a fair proxy
        // for "vertically in the bar"; it is now at the bottom of the screen,
        // and the old filter would have selected NOTHING and reported
        // `smallestBarGap: null` — an assertion measuring an empty set while
        // looking green.
        .filter((b) => {
          const band = header.getBoundingClientRect()
          return b.width > 0 && b.height > 0 && b.bottom >= band.top && b.top <= band.bottom
        })
        .sort((a, b) => a.left - b.left)
      for (let i = 1; i < inBar.length; i += 1) {
        smallestBarGap = Math.min(smallestBarGap, inBar[i].left - inBar[i - 1].right)
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
        barControlCount: inBar.length,
        smallestBarGap: inBar.length >= 2 && Number.isFinite(smallestBarGap)
          ? Math.round(smallestBarGap * 100) / 100
          : null,
        accountChipCount: header.querySelectorAll('button[aria-label^="Active account"]').length,
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

/**
 * What the top bar's band holds, read from the live DOM (#3825).
 *
 * Found by the `[data-app-bar]` contract and the header's own scope, never by
 * the pill's label: the point is that NOTHING interactive lives in the right
 * cluster any more, and an assertion that located the pill by name could not
 * notice a different control arriving in its place. `controls` are the visible
 * links/buttons in the band left to right, each with a hit rectangle walked
 * with `elementFromPoint` (a finger's view, not a border box).
 */
async function measureBar(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('header[data-app-chrome]')!
    const bar = header.querySelector<HTMLElement>('[data-app-bar]')!
    const selector = 'button, a[href], [role="button"], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    const visible = (el: HTMLElement) => {
      const b = el.getBoundingClientRect()
      return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden'
    }
    const nameOf = (el: HTMLElement) =>
      (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40)
    const walk = (el: HTMLElement, ox: number, oy: number, dx: number, dy: number, cap: number) => {
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
    const all = Array.from(header.querySelectorAll<HTMLElement>(selector)).filter(visible)
    const controls = all
      .map((el) => {
        const b = el.getBoundingClientRect()
        const cx = Math.round(b.left + b.width / 2)
        const cy = Math.round(b.top + b.height / 2)
        const top = document.elementFromPoint(cx, cy)
        const cap = Math.ceil(Math.max(b.width, b.height) / 2) + 12
        return {
          label: nameOf(el),
          left: Math.round(b.left),
          right: Math.round(b.right),
          reachableAtCentre: !!top && (top === el || el.contains(top)),
          hit: {
            w: walk(el, cx, cy, -1, 0, cap) + walk(el, cx, cy, 1, 0, cap) + 1,
            h: walk(el, cx, cy, 0, -1, cap) + walk(el, cx, cy, 0, 1, cap) + 1,
          },
        }
      })
      .sort((a, b) => a.left - b.left)
    // The right cluster is the bar's LAST direct child region (`ml-auto`).
    const cluster = bar.lastElementChild as HTMLElement | null
    const rightClusterControls = cluster
      ? Array.from(cluster.querySelectorAll<HTMLElement>(selector)).filter(visible).map(nameOf)
      : ['(no right cluster)']
    // Every wallet-state name the retired pill could announce as, anywhere in
    // the chrome band.
    const WALLET_NAMES = /^(connect wallet|wrong wallet|wrong network|passkey|0x[0-9a-f]{4}…[0-9a-f]{4})$/i
    return {
      controls,
      rightClusterControls,
      chromeControlNames: all.map(nameOf).filter((n) => WALLET_NAMES.test(n)),
      scrollOverflowPx: Math.round(bar.scrollWidth - bar.clientWidth),
    }
  })
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
      // Flush to the bottom of the viewport, and spanning it.
      barBottomGap: Math.round(window.innerHeight - barBox.bottom),
      barSpansViewport:
        Math.round(barBox.left) === 0 && Math.round(barBox.right) === Math.round(window.innerWidth),
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

        // #2731 moved this control out of the top bar and into the bottom tab
        // bar's fifth slot. Assertions 1-7 below are the SAME seven questions
        // translated to that geometry, not a smaller set: a hit area, its
        // corners, its painted size, its neighbour, the absolute anchor, the
        // reservation that keeps content clear of it, and its placement in its
        // own band.
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
        //    replaces that guard is exactness: More is one fifth of the bar,
        //    the same height as the tabs beside it. A control that drifted to
        //    a different width would look like a design decision and be a
        //    misalignment.
        expect(t.slots[4].w).toBe(Math.round(width / 5))
        expect(t.slots[4].h).toBe(t.slots[0].h)

        // 4. It did not eat its neighbour, and did not leave a dead strip
        //    either. The old neighbour was `NetworkSwitcher` 14px away in the
        //    header row; the new one is the last tab, and tabs ABUT by design,
        //    so the floor becomes an equality. A negative seam is an overlap
        //    (a thumb on Accounts opens the drawer); a positive one is a gap
        //    that swallows taps.
        expect(t.seam).toBe(0)

        // 5. Nothing consumes layout. UNCHANGED from the original, and it is
        //    the assertion that earned its place: swapping `fixed` for
        //    `relative` on the old toggle passed every other check while
        //    shifting the whole shell 32px. Two fixed elements depend on it
        //    now, so it guards more than it did.
        expect(m.headerLeft).toBe(0)

        // 6. `<main>` reserves the bar's height. This replaces the 32px
        //    TopBar slot, and it is the same KIND of assertion: a reservation
        //    that a naive edit drops, whose absence is invisible until the
        //    last row of a long page sits under the chrome. The bar is
        //    `fixed`, so nothing else keeps content clear of it.
        expect(t.mainPaddingBottom).toBeGreaterThanOrEqual(t.barHeight)

        // 7. Flush to the bottom, spanning the width. The old control was
        //    centred in the header band; this one owns its own band, and the
        //    failure it replaces is the same shape — a control placed against
        //    the wrong box. A bar floating a few pixels off the bottom leaves
        //    a strip of page showing under it that scrolls, which reads as a
        //    rendering bug rather than a design.
        expect(t.barBottomGap).toBe(0)
        expect(t.barSpansViewport).toBe(true)

        // 8. The top bar's band paints NO control on the dashboard (#3825).
        //    The wallet pill was the only interactive item the phone bar held
        //    here (`EnvBadge` is a span, the theme toggle is `hidden` below
        //    `lg`), so removing it leaves an EMPTY band. That is asserted as a
        //    count rather than assumed: `barControlCount` is the same scan the
        //    gap floor used to run over, now required to find nothing, so a
        //    control re-added to the bar (the pill, or any other) fails here
        //    with the number instead of silently re-crowding a 320px row.
        //    The right cluster is checked on its own as well, because "the bar
        //    has no controls" would still pass if a control had merely moved
        //    to the left region.
        const bar = await measureBar(page)
        expect(m.barControlCount).toBe(0)
        expect(m.smallestBarGap).toBeNull()
        expect(bar.rightClusterControls).toEqual([])
        //    ...and no wallet-state control by NAME anywhere in the chrome
        //    band, so a pill that rendered outside the two regions fails too.
        expect(bar.chromeControlNames).toEqual([])

        // 9. The account chip is GONE (#3719 removed the global active
        //    account and its picker); a reintroduced one would reopen every
        //    width question the bar used to have (#1767, #1803).
        expect(m.accountChipCount).toBe(0)
      })

      test('on a detail route the bar keeps exactly its back link, which is reachable and clear of the edges (#3825)', async ({
        page,
      }) => {
        // The one control the phone bar still holds. This is the "remaining
        // items keep their tap target and do not overlap" half of the pill's
        // removal: with the right cluster empty the back link is alone in the
        // band, so a regression that re-crowds it shows as a second control
        // (count) or as an overlap (gap floor), at the widths where the old
        // row ran out of room.
        await page.goto('/agents/agent-research')
        await page.locator('header[data-app-chrome] a[href="/agents"]').waitFor()

        const bar = await measureBar(page)

        // Exactly the back link: one control, labelled, in the LEFT region.
        expect(bar.controls.map((c) => c.label)).toEqual(['Agents'])
        expect(bar.rightClusterControls).toEqual([])
        expect(bar.chromeControlNames).toEqual([])

        const back = bar.controls[0]
        // It is the thing a finger reaches at its own centre: nothing in the
        // chrome (and no stale overlay) has taken its taps.
        expect(back.reachableAtCentre).toBe(true)
        // Measured hit rectangle, the same walk the toggle's uses. The link is
        // a 13px text row, so this records the real number instead of a
        // comfort target it never had; the floor is "not collapsed".
        expect(back.hit.h).toBeGreaterThanOrEqual(BACK_LINK_MIN_HIT_PX)
        expect(back.hit.w).toBeGreaterThanOrEqual(BACK_LINK_MIN_HIT_PX)
        // On the left, inside the viewport, and nowhere near the right edge
        // the pill used to occupy.
        expect(back.left).toBeGreaterThanOrEqual(0)
        expect(back.right).toBeLessThanOrEqual(width / 2)
        // Nothing overflowed the bar sideways.
        expect(bar.scrollOverflowPx).toBeLessThanOrEqual(0)
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

      // Tap 1px INSIDE the left edge — the seam with the Accounts tab (#2731).
      //
      // The original tapped 4px OUTSIDE the painted box, because the whole of
      // #1766 was an invisible 44px overlay around a 32px control. There is no
      // overlay now: the painted cell IS the target. The analogous pixel-level
      // fact is the seam — one pixel the wrong side of it navigates to
      // /accounts instead of opening the drawer, and a thumb does not know
      // which side it landed on.
      const box = (await open.boundingBox())!
      await page.mouse.click(box.x + 1, box.y + box.height / 2)

      const nav = page.getByRole('navigation', { name: 'All sections' })
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
      await waitForDrawerOpen(page)

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
