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
 *   MEASURED hit rectangle             44 x 44   (x 10-53, y 10-53)
 *   corners of the intended 44px area  all four reach the toggle
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

// The toggle is `lg:hidden`. The measured geometry is width-independent, so two
// widths are enough to say so honestly: the narrowest phone we support, and the
// last pixel below the `lg` breakpoint, where a regression would most plausibly
// reappear. (`mobile-nav-layering.mobile.spec.ts` already proves the toggle
// vanishes AT 1024px.)
const WIDTHS = [320, 1023]

const PAINTED_PX = 32
const COMFORTABLE_TAP_TARGET_PX = 44

type Measurement = {
  painted: { w: number; h: number }
  hit: { left: number; right: number; top: number; bottom: number; w: number; h: number }
  corners: Record<string, string>
  /** Nearest interactive control to the toggle's right, inside the top bar. */
  neighbour: { label: string; left: number } | null
  /**
   * Where the top bar starts. The toggle is `fixed`, so it consumes NO layout —
   * the bar it floats over begins at the viewport edge. See the assertion.
   */
  headerLeft: number
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

      const reaches = (x: number, y: number) => {
        const top = document.elementFromPoint(x, y)
        return !!top && (top === btn || btn.contains(top))
      }

      // Walk outward until a tap stops landing on the toggle. This is the hit
      // rectangle — the border box plus whatever the overlay adds — and it is
      // the only measurement that can tell a working overlay from an inert one.
      const walk = (dx: number, dy: number) => {
        let n = 0
        while (n < 80) {
          const x = cx + dx * (n + 1)
          const y = cy + dy * (n + 1)
          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) break
          if (!reaches(x, y)) break
          n += 1
        }
        return n
      }
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

      // The nearest interactive control to the toggle's right that shares its
      // vertical band. The invisible target must not reach it: an overlay that
      // swallows a neighbour's taps trades one mis-tap for another, and it is
      // invisible by construction, so nothing but a measurement would notice.
      const header = document.querySelector('header')!
      let neighbour: { label: string; left: number } | null = null
      for (const el of Array.from(
        header.querySelectorAll<HTMLElement>('button, a[href], [role="button"]'),
      )) {
        const b = el.getBoundingClientRect()
        if (b.width === 0 || b.height === 0) continue
        if (b.left <= box.right) continue
        if (b.bottom < box.top || b.top > box.bottom) continue
        if (!neighbour || b.left < neighbour.left) {
          neighbour = {
            label: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40),
            left: Math.round(b.left),
          }
        }
      }

      return {
        painted: { w: Math.round(box.width), h: Math.round(box.height) },
        hit: { left: cx - l, right: cx + r, top: cy - u, bottom: cy + d, w: l + r + 1, h: u + d + 1 },
        corners,
        neighbour,
        headerLeft: Math.round(header.getBoundingClientRect().left),
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
        //    starts at x=68 in this bar; the 44px target's right edge is x=54.
        expect(m.neighbour).not.toBeNull()
        expect(m.hit.right).toBeLessThan(m.neighbour!.left)

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
  })
})
