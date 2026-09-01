/**
 * `/accounts`: the card's set-active / set-default controls on a real touch
 * device (#2241).
 *
 * ## TWO defects, and they are different kinds
 *
 * **1. Hover-gated — a functional defect, not polish.** The wrapper was
 * `opacity-0 group-hover:opacity-100 focus-within:opacity-100`. On a device
 * with no hover the `group-hover` branch can never fire, so the controls
 * painted nothing.
 *
 * The issue described that as the controls being "effectively keyboard/AT-only
 * -reachable … never surfaced by touch alone", and that is **not what the
 * measurement showed**. `opacity: 0` suppresses painting and does not touch
 * hit-testing: on unchanged `dev` at Pixel 5, `elementFromPoint` at each
 * button's centre returned the button. The card therefore carried an invisible
 * **73 x 24px** "Set active" and an invisible **26 x 26px** star in its
 * top-right corner — where a finger lands to open the account — and both
 * handlers call `preventDefault()` + `stopPropagation()`, so a tap there did
 * not navigate. It silently wrote a new default account.
 *
 * So the controls were not unreachable. They were INVISIBLE AND STILL LIVE:
 * undiscoverable and tap-stealing at once, which is strictly worse than the
 * diagnosis in the issue. Fixed by gating the hover treatment itself on
 * `(hover: hover)`, so a touch device never enters it and the wrapper keeps
 * its default opacity 1.
 *
 * **2. Under the touch-target floor — an ergonomics defect.** The documented
 * floor is 44px (`docs/product/design-system.md` § Buttons *Tap targets*,
 * #1726; `docs/product/design-review.md` § Responsive And States). Measured
 * hit rectangles on unchanged `dev`: **73 x 24** and **26 x 26** (the 73 is a
 * macOS reading; the same button renders 75 wide on the Linux CI runner, which
 * is why only the HEIGHT is pinned hard — see `PAINT` below). Fixed with
 * the transparent-`::after` mechanism that section documents — vertical-only
 * for the labelled button, both axes for the icon square (#1766's deviation).
 *
 * ## Why a browser, and why `chromium-mobile` specifically
 *
 * Neither defect exists in jsdom, which has no layout, no `(hover: *)` media
 * evaluation and no hit-testing — `getBoundingClientRect` reports 26 x 26 for
 * a perfectly working overlay, and a class assertion reads the same string
 * whether or not the resulting rectangle is 44px. `chromium-mobile` is Pixel 5
 * device emulation — `(hover: none)`, `(pointer: coarse)`, real touch points,
 * not a viewport override on a desktop browser (#1768) — so it is the only
 * project here in which "what does a touch user get" is a real question.
 *
 * And no screenshot can stand in for it. `/accounts` has **no committed visual
 * baseline at any width**: `e2e/__screenshots__/` holds baselines for four
 * specs — `design-system`, `agent-panel-states`, `focus-visible` and
 * `wallet-button-collapsed-states` — and not one of them renders this route,
 * while the blocking *Design visual regression* job pixel-compares
 * `/design-system`. So the pixel gate could not see this before and cannot see
 * it now. A capture would in any case show a transparent overlay as nothing at
 * all — the same reason #2038's touch defects survived both a pixel gate and a
 * rendered design review.
 *
 * ## What is asserted, and why each half needs the other
 *
 * Every test asserts its own claim AND the thing that claim could have been
 * bought with:
 *
 *  - VISIBILITY is asserted together with the PAINT being unchanged. A reveal
 *    bought by enlarging the buttons is a different change with a real cost to
 *    the title row, and #2223/#2235/#2236 spent three issues on that row's
 *    width.
 *  - The 44px HIT rectangle is asserted together with the PAINT being
 *    unchanged, exactly as `e2e/investor-briefing-tap-target.mobile.spec.ts`
 *    does: a "fix" that raises the painted height satisfies the floor and
 *    breaks the density the compact sizes exist for, which is the call #1726
 *    made and this borrows.
 *  - The star's widened target is asserted NOT to reach its neighbour. An
 *    invisible overlay that swallows the adjacent button's taps trades one
 *    mis-tap for another and nothing but a measurement would ever notice —
 *    #1766's lesson, and the reason `gap-1` became `gap-2.5` here.
 *  - A tap is asserted to actually WORK, so none of the geometry above is
 *    geometry over a decoration.
 */
import { expect, test, type Page } from '@playwright/test'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession, testSafe, testUser } from './fixtures/haven-api'

/**
 * The documented floor — `docs/product/design-system.md` § Buttons *Tap
 * targets*, and `docs/product/design-review.md` § Responsive And States
 * ("Primary and risk-bearing mobile touch targets are at least 44px").
 */
const TOUCH_TARGET_FLOOR = 44

/**
 * The only card that renders actions: both buttons are gated on `!isActive` /
 * `!safe.is_default`, so the seeded active+default account renders neither.
 */
const ACTION_CARD = 'Imported Safe'
const ACTIVE_DEFAULT_CARD = 'Operating wallet'

/**
 * The painted boxes, measured on unchanged `dev` at Pixel 5 and asserted to be
 * UNCHANGED by this fix. Both defects here are fixed without moving a pixel,
 * which is the whole point of the `::after` mechanism and of gating the
 * existing hover treatment rather than adding an override.
 *
 * WHICH OF THESE FOUR NUMBERS IS PLATFORM-STABLE, because one of them is not
 * and it failed CI before this note existed. `Set active`'s WIDTH is a text
 * measurement: it renders **72.6px on macOS and 75px on the Linux CI runner**,
 * and an absolute pin on it is a font-metric assertion wearing a layout
 * assertion's clothes. Every other figure here is geometry — the two heights
 * come from `text-xs`/`py-1` and `p-1.5` line boxes, and the star's width is
 * `p-1.5` twice plus a `w-3.5` icon, 6 + 14 + 6 — so those stay pinned hard.
 *
 * `setActive.w` is therefore kept only as a CEILING with real headroom, paired
 * with the relational check below that expresses the actual rule ("the target
 * grew sideways, the button did not"). A number nobody can reproduce on their
 * own machine is worse than no number.
 */
const PAINT = {
  setActive: { h: 24, maxW: 90 },
  star: { w: 26, h: 26 },
}
/** Sub-pixel tolerance on a paint assertion. Deliberately tight. */
const PAINT_TOLERANCE = 1.5

type Probe = {
  wrapOpacity: number
  hoverNone: boolean
  pointerCoarse: boolean
  buttons: {
    label: string | null
    paint: { w: number; h: number }
    hit: { w: number; h: number }
    centreHitsSelf: boolean
  }[]
  /** How far the star's hit rectangle reaches left, and what owns the pixel beyond it. */
  starLeftReach: number
  starLeftNeighbour: string
  /** The painted gap between the two buttons' border boxes. */
  paintedGap: number | null
}

/**
 * Anchor on `aria-label`, never on a class string — the class strings are what
 * this fix changes.
 */
async function probeCard(page: Page, label: string): Promise<Probe> {
  return page.evaluate((accountName) => {
    const card = document.querySelector(`a[aria-label="${accountName}"]`) as HTMLElement | null
    if (!card) throw new Error(`no /accounts card labelled "${accountName}"`)
    const buttons = Array.from(card.querySelectorAll('button')) as HTMLElement[]
    if (buttons.length === 0) throw new Error(`the card labelled "${accountName}" renders no action buttons`)
    const wrap = buttons[0].parentElement as HTMLElement

    /*
      Walk outward from an element's centre until a tap stops landing on it.
      This is the HIT rectangle — the border box plus whatever the `::after`
      overlay adds, minus whatever another element has taken — and it is the
      only measurement that distinguishes a working overlay from an inert one.
      `getBoundingClientRect` returns the border box and reports 26x26 even
      when the overlay works perfectly (#1766).

      `max` must exceed the element's own half extent, or the walk stops on the
      CAP and reports a hit rectangle smaller than reality — a false "something
      is covering this". 120 clears the widest control here (73px) with room.
    */
    const walk = (el: HTMLElement, cx: number, cy: number, dx: number, dy: number, max = 120) => {
      let n = 0
      while (n < max) {
        const x = cx + dx * (n + 1)
        const y = cy + dy * (n + 1)
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) break
        const top = document.elementFromPoint(x, y)
        if (!(!!top && (top === el || el.contains(top)))) break
        n += 1
      }
      return n
    }
    const measure = (el: HTMLElement) => {
      const b = el.getBoundingClientRect()
      const cx = Math.round(b.left + b.width / 2)
      const cy = Math.round(b.top + b.height / 2)
      const top = document.elementFromPoint(cx, cy)
      return {
        label: el.getAttribute('aria-label'),
        paint: { w: +b.width.toFixed(1), h: +b.height.toFixed(1) },
        hit: {
          w: walk(el, cx, cy, -1, 0) + walk(el, cx, cy, 1, 0) + 1,
          h: walk(el, cx, cy, 0, -1) + walk(el, cx, cy, 0, 1) + 1,
        },
        centreHitsSelf: !!top && (top === el || el.contains(top)),
      }
    }

    const star = buttons[buttons.length - 1]
    const starBox = star.getBoundingClientRect()
    const starCx = Math.round(starBox.left + starBox.width / 2)
    const starCy = Math.round(starBox.top + starBox.height / 2)
    const starLeftReach = walk(star, starCx, starCy, -1, 0)
    const beyond = document.elementFromPoint(starCx - starLeftReach - 1, starCy)
    /*
      Name what owns the pixel just past the star's reach, so a red run says
      WHAT is in the way rather than just a number. The healthy answer is the
      wrapper `div` (dead space in the gap); the answer this assertion exists
      to forbid is the "Set active" button.
    */
    const describe = (el: Element | null) => {
      if (!el) return 'nothing'
      const aria = el.getAttribute('aria-label')
      return aria ? `${el.tagName.toLowerCase()}[aria-label="${aria}"]` : el.tagName.toLowerCase()
    }

    return {
      wrapOpacity: Number(getComputedStyle(wrap).opacity),
      hoverNone: window.matchMedia('(hover: none)').matches,
      pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
      buttons: buttons.map(measure),
      starLeftReach,
      starLeftNeighbour: describe(beyond),
      paintedGap:
        buttons.length >= 2
          ? +(
              buttons[1].getBoundingClientRect().left - buttons[0].getBoundingClientRect().right
            ).toFixed(1)
          : null,
    }
  }, label)
}

async function serveAccounts(page: Page, safes: unknown[]) {
  await page.route('**/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...testUser, safes }),
    })
  })
}

async function openAccountsWithBothCards(page: Page) {
  await mockHavenApi(page)
  await seedAuthenticatedSession(page)
  await serveAccounts(page, [
    { ...testSafe, name: ACTIVE_DEFAULT_CARD, is_default: true },
    {
      ...testSafe,
      id: 'safe-second',
      safe_address: '0x4444444444444444444444444444444444444444',
      name: ACTION_CARD,
      is_default: false,
      created_at: '2026-04-20T10:00:00.000Z',
    },
  ])
  await page.goto('/accounts')
  await page.waitForSelector('a[aria-label] h3', { timeout: 60_000 })
  /*
    Below `lg` the nav drawer overlays the grid and would own every
    `elementFromPoint` reading underneath it (#1749). The established call, and
    the same one `accounts-name-measure.spec.ts` and
    `tooltip-reachability.spec.ts` make before their own hit-dependent reads.
  */
  await dismissMobileSidebar(page)
  await page.locator(`a[aria-label="${ACTION_CARD}"]`).scrollIntoViewIfNeeded()
  /*
    The wrapper carries `transition-opacity`. Reading it mid-transition would
    make the visibility assertion flaky in the direction that hides a
    regression, so settle until two consecutive reads agree.
  */
  let probe = await probeCard(page, ACTION_CARD)
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150)
    const again = await probeCard(page, ACTION_CARD)
    if (JSON.stringify(again) === JSON.stringify(probe)) break
    probe = again
  }
  return probe
}

test('/accounts: the card actions are VISIBLE on a touch device, with no hover and no paint change', async ({
  page,
}) => {
  test.slow()
  const probe = await openAccountsWithBothCards(page)

  /*
    Non-vacuity FIRST. Everything below is a claim about a device with no
    hover; if this project ever stopped being device emulation the assertions
    would pass for the wrong reason, which is exactly the #1768 trap.
  */
  expect(probe.hoverNone, 'this project is not emulating a hover-less device').toBe(true)
  expect(probe.pointerCoarse, 'this project is not emulating a coarse pointer').toBe(true)
  expect(
    probe.buttons.map((b) => b.label),
    'the action card renders the wrong button set',
  ).toEqual([`Set ${ACTION_CARD} as active`, `Set ${ACTION_CARD} as default`])

  // Defect 1. Nothing was hovered, tapped or focused before this read.
  expect(
    probe.wrapOpacity,
    `the card's actions are at opacity ${probe.wrapOpacity} on a device that cannot hover — a touch user sees nothing where two live controls are`,
  ).toBeGreaterThan(0.99)

  /*
    And the visibility was not bought by growing the buttons. Both halves,
    because a reveal that also inflates the paint spends the title row's width
    — the measure #2223/#2235/#2236 exist to protect.
  */
  const [setActive, star] = probe.buttons
  expect(
    setActive.paint.h,
    `"Set active" paints ${setActive.paint.w}x${setActive.paint.h}px — the height is not the documented ${PAINT.setActive.h}`,
  ).toBeCloseTo(PAINT.setActive.h, 0)
  expect(
    setActive.paint.w,
    `"Set active" paints ${setActive.paint.w}px wide, past the ${PAINT.setActive.maxW}px ceiling — that is a label or a padding change, not a reveal`,
  ).toBeLessThanOrEqual(PAINT.setActive.maxW)
  expect(
    star.paint.w,
    `the star paints ${star.paint.w}x${star.paint.h}px, not the documented ${PAINT.star.w}x${PAINT.star.h}`,
  ).toBeCloseTo(PAINT.star.w, 0)
  expect(star.paint.h).toBeCloseTo(PAINT.star.h, 0)
})

test('/accounts: both card actions clear the 44px touch-target floor without moving a pixel', async ({
  page,
}) => {
  test.slow()
  const probe = await openAccountsWithBothCards(page)
  const [setActive, star] = probe.buttons

  for (const b of probe.buttons) {
    // A hit rectangle read through an element that is not the button itself is
    // not a reading of that button.
    expect(b.centreHitsSelf, `a tap at the centre of "${b.label}" does not reach it`).toBe(true)
    expect(
      b.hit.w,
      `"${b.label}" has a ${b.hit.w}x${b.hit.h}px hit rectangle (paints ${b.paint.w}x${b.paint.h}) — the floor is ${TOUCH_TARGET_FLOOR}px`,
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR)
    expect(
      b.hit.h,
      `"${b.label}" has a ${b.hit.w}x${b.hit.h}px hit rectangle (paints ${b.paint.w}x${b.paint.h}) — the floor is ${TOUCH_TARGET_FLOOR}px`,
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR)
  }

  /*
    The other half of #1726's call, asserted for the same reason
    `investor-briefing-tap-target.mobile.spec.ts` asserts it: a "fix" that
    raises the painted height clears the floor and destroys the density the
    compact control was chosen for. Without this the floor check above would
    bless exactly the wrong fix.
  */
  expect(
    Math.abs(setActive.paint.h - PAINT.setActive.h),
    `"Set active" now paints ${setActive.paint.h}px tall — the target was supposed to grow, not the button`,
  ).toBeLessThanOrEqual(PAINT_TOLERANCE)
  /*
    The vertical-only rule for the labelled button, stated as a RELATIONSHIP so
    it holds on any platform's font metrics. `after:inset-x-0` means the
    overlay spans the button's own width and adds none, so the hit rectangle
    must be the border box sideways however wide the label renders. This is
    what the absolute width pin used to imply and could not survive: 72.6px on
    macOS, 75px on Linux CI.
  */
  expect(
    setActive.hit.w - setActive.paint.w,
    `"Set active"'s target is ${setActive.hit.w}px against a ${setActive.paint.w}px box — it has grown SIDEWAYS, which is what would let it swallow the star's taps`,
  ).toBeLessThanOrEqual(PAINT_TOLERANCE)
  expect(
    Math.abs(star.paint.h - PAINT.star.h),
    `the star now paints ${star.paint.h}px tall — the target was supposed to grow, not the button`,
  ).toBeLessThanOrEqual(PAINT_TOLERANCE)
  expect(Math.abs(star.paint.w - PAINT.star.w)).toBeLessThanOrEqual(PAINT_TOLERANCE)
})

test('/accounts: the star’s widened target does not swallow "Set active"', async ({ page }) => {
  test.slow()
  const probe = await openAccountsWithBothCards(page)

  /*
    The star paints 26px and its target is 44px, so it overhangs 9px per edge.
    At the original `gap-1` (4px) that reached 5px INTO "Set active"'s own box.
    The gap is 10px now, so the two targets get 1px of clearance — measured,
    and the reason the gap moved at all.

    Asserted as "what owns the pixel past the star's reach", not as an
    arithmetic comparison of two numbers, because the arithmetic version
    passes on a layout where something else has already taken the pixels.
  */
  expect(
    probe.starLeftNeighbour,
    `the pixel past the star's ${probe.starLeftReach}px leftward reach belongs to ${probe.starLeftNeighbour} — the star's invisible target is swallowing its neighbour's taps`,
  ).not.toContain(`aria-label="Set ${ACTION_CARD} as active"`)

  // Non-vacuity: the reach must actually exceed the painted half-width, or the
  // assertion above is about an overlay that never widened anything.
  expect(
    probe.starLeftReach,
    `the star reaches only ${probe.starLeftReach}px left of its centre — the overlay is not widening it, so the clearance check above proves nothing`,
  ).toBeGreaterThan(PAINT.star.w / 2)
  expect(
    probe.paintedGap,
    `the buttons' painted boxes are ${probe.paintedGap}px apart`,
  ).toBeGreaterThanOrEqual(9)
})

/**
 * The geometry above is geometry over a DECORATION unless a finger actually
 * works the control, and `page.tap()` dispatches a genuine touch sequence only
 * under `chromium-mobile`.
 *
 * WHAT THIS DOES NOT ASSERT, AND WHY — the instrument was proven unable to say
 * yes before any absence here was believed. The obvious second half is "the
 * URL did not change". It was written, and then killed by its own mutation:
 * with BOTH `preventDefault()` and `stopPropagation()` removed from the star's
 * handler the URL check still passed, because in this mocked harness the card
 * link does not navigate on tap AT ALL — a control tap on the card's own `h3`
 * leaves `page.url()` at `/accounts` for at least 3s too. A check that cannot
 * distinguish "navigation was suppressed" from "navigation never happens here"
 * is not evidence, so it is replaced rather than kept as decoration.
 *
 * What IS asserted instead is the two things the handler actually does, read
 * off the event rather than off the address bar:
 *
 *   - the card's own `onClick` never runs (`stopPropagation`). Observed
 *     through its ONE side effect — `AuthContext.setActiveSafe` writes the
 *     safe id to `localStorage['haven_active_safe_id']` — rather than through
 *     a DOM listener on the anchor, which a first draft used and which cannot
 *     work: React 17+ delegates to the root container, so the NATIVE click has
 *     already bubbled past the anchor before `stopPropagation()` is called on
 *     the synthetic event. That draft failed on the unmutated tree, which is
 *     how it was caught;
 *   - the click ends with `defaultPrevented`, so the anchor's native
 *     navigation is off.
 *
 * Both are read AFTER dispatch completes (a capture-phase listener holding the
 * event, drained on a macrotask), because `defaultPrevented` during capture is
 * always false and would assert nothing.
 */
test('/accounts: a real tap on the visible star writes the default and is contained', async ({
  page,
}) => {
  test.slow()
  await openAccountsWithBothCards(page)

  /*
    The write this control makes — `useUserSafes.setDefault` calls
    `PUT /user/safes/:id/default`. Intercepted rather than read back through
    the UI, because this spec pins `/auth/me` and it would not reflect it.
  */
  let defaultWrite: string | null = null
  await page.route('**/user/safes/*/default', async (route, request) => {
    defaultWrite = `${request.method()} ${new URL(request.url()).pathname}`
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  const activeSafeBefore = await page.evaluate(() => localStorage.getItem('haven_active_safe_id'))
  await page.evaluate(() => {
    const probe = { defaultPrevented: null as boolean | null }
    ;(window as unknown as { __tapProbe: typeof probe }).__tapProbe = probe
    document.addEventListener(
      'click',
      (e) => {
        setTimeout(() => {
          probe.defaultPrevented = e.defaultPrevented
        }, 0)
      },
      true,
    )
  })

  await page.tap(`a[aria-label="${ACTION_CARD}"] button[aria-label="Set ${ACTION_CARD} as default"]`)
  await page.waitForTimeout(1200)
  const probe = await page.evaluate(
    () => (window as unknown as { __tapProbe: { defaultPrevented: boolean | null } }).__tapProbe,
  )
  const activeSafeAfter = await page.evaluate(() => localStorage.getItem('haven_active_safe_id'))

  expect(
    defaultWrite,
    'tapping the star sent no write — the visible control is a decoration',
  ).not.toBeNull()
  // Non-vacuity for the two containment reads: the click has to have happened.
  expect(
    probe.defaultPrevented,
    'no click reached the document — the containment assertions below would be vacuous',
  ).not.toBeNull()
  // Non-vacuity: the seeded id has to be readable, or "unchanged" is trivial.
  expect(activeSafeBefore, 'no active safe was seeded — an unchanged reading proves nothing').not.toBeNull()
  expect(
    activeSafeAfter,
    `tapping the star moved the active account from ${activeSafeBefore} to ${activeSafeAfter} — the card's own handler fired alongside it`,
  ).toBe(activeSafeBefore)
  expect(
    probe.defaultPrevented,
    'the click ended un-prevented — the card link\'s native navigation is still armed under the star',
  ).toBe(true)
})
