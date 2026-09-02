/**
 * `/accounts`: the card's set-active control on a real touch device (#2241),
 * and the ABSENCE of a set-default control on it (#2374).
 *
 * ## What #2374 changed here
 *
 * This file used to be about a PAIR. The second control — an unlabelled
 * `Set as default` star, 26x26 painted with an `h-11 w-11` target — was
 * dropped from the card by owner decision: after #2241 made it permanently
 * visible on touch it was a bare glyph whose meaning lived only in
 * `aria-label`, and every way of explaining it in place cost the title row
 * width that #2223 / #2235 / #2236 had already spent three issues protecting.
 * Setting a default now happens on `/accounts/<id>` only.
 *
 * Three consequences for this spec, all of them stated rather than silently
 * absorbed:
 *
 *  - the star's own geometry checks are GONE, not weakened — there is nothing
 *    left to measure;
 *  - the star-versus-neighbour clearance test is replaced by an ABSENCE pin
 *    (`the card offers no set-default control`), which carries its own
 *    non-vacuity: the same scan that must find nothing matching /default/ must
 *    find the set-active control, or it is proving that the page failed to
 *    render;
 *  - the real-tap test loses HALF of what it could observe, and that is a real
 *    loss of coverage rather than a tidy-up. See its own note.
 *
 * ## TWO defects, and they are different kinds
 *
 * **1. Hover-gated — a functional defect, not polish.** The wrapper was
 * `opacity-0 group-hover:opacity-100 focus-within:opacity-100`. On a device
 * with no hover the `group-hover` branch can never fire, so the control
 * painted nothing.
 *
 * The issue described that as the controls being "effectively keyboard/AT-only
 * -reachable … never surfaced by touch alone", and that is **not what the
 * measurement showed**. `opacity: 0` suppresses painting and does not touch
 * hit-testing: on unchanged `dev` at Pixel 5, `elementFromPoint` at each
 * button's centre returned the button. The card therefore carried an invisible
 * **73 x 24px** "Set active" and (then) an invisible **26 x 26px** star in its
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
 * hit rectangles on unchanged `dev`: **73 x 24** for "Set active" (a macOS
 * reading; the same button renders 75 wide on the Linux CI runner, which is
 * why only the HEIGHT is pinned hard — see `PAINT` below). Fixed with the
 * transparent-`::after` mechanism that section documents — vertical-only for a
 * labelled button. The both-axes variant for an icon square (#1766's
 * deviation) applied to the star and left with it; the rule itself is
 * general and still documented, and `WalletButton.tsx` still borrows it.
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
 *  - The set-default control is asserted ABSENT, page-wide and by two
 *    spellings (an `aria-label` and a visible label), because #2374 is a
 *    removal and a removal that nothing pins comes back. Its non-vacuity is
 *    the set-active control the same scan must still find.
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
 * assertion's clothes. The remaining figure here is geometry — the height comes
 * from the `text-xs`/`py-1` line box — so it stays pinned hard.
 *
 * `setActive.w` is therefore kept only as a CEILING with real headroom, paired
 * with the relational check below that expresses the actual rule ("the target
 * grew sideways, the button did not"). A number nobody can reproduce on their
 * own machine is worse than no number.
 */
const PAINT = {
  setActive: { h: 24, maxW: 90 },
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
  /**
   * #2374's absence pin, gathered PAGE-WIDE rather than per card, and paired
   * with its own non-vacuity control.
   *
   * `setDefaultControls` must be empty and `setActiveControls` must not be, so
   * a run in which `/accounts` rendered nothing at all fails LOUDLY instead of
   * reading as a clean absence. Two spellings are scanned because a
   * reintroduction could arrive as either the old `aria-label`-only star or as
   * the labelled variant #2374 rejected: any button or link whose accessible
   * name OR visible text mentions "default" counts. The `default` BADGE is a
   * `span`, so it is not swept up by this.
   */
  setDefaultControls: string[]
  setActiveControls: string[]
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

    /*
      #2374. Scan the WHOLE document, not this card: the control was removed
      from every card, and a pin that only looked at one of them would pass on
      a reintroduction that landed on the others.
    */
    const nameOf = (el: Element) =>
      `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.trim()
    const controls = Array.from(document.querySelectorAll('button, a[role="button"]'))
    const matching = (re: RegExp) =>
      controls.map(nameOf).filter((n) => re.test(n))

    return {
      wrapOpacity: Number(getComputedStyle(wrap).opacity),
      hoverNone: window.matchMedia('(hover: none)').matches,
      pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
      buttons: buttons.map(measure),
      setDefaultControls: matching(/default/i),
      setActiveControls: matching(/active/i),
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
  ).toEqual([`Set ${ACTION_CARD} as active`])

  // Defect 1. Nothing was hovered, tapped or focused before this read.
  expect(
    probe.wrapOpacity,
    `the card's actions are at opacity ${probe.wrapOpacity} on a device that cannot hover — a touch user sees nothing where a live control is`,
  ).toBeGreaterThan(0.99)

  /*
    And the visibility was not bought by growing the buttons. Both halves,
    because a reveal that also inflates the paint spends the title row's width
    — the measure #2223/#2235/#2236 exist to protect.
  */
  const [setActive] = probe.buttons
  expect(
    setActive.paint.h,
    `"Set active" paints ${setActive.paint.w}x${setActive.paint.h}px — the height is not the documented ${PAINT.setActive.h}`,
  ).toBeCloseTo(PAINT.setActive.h, 0)
  expect(
    setActive.paint.w,
    `"Set active" paints ${setActive.paint.w}px wide, past the ${PAINT.setActive.maxW}px ceiling — that is a label or a padding change, not a reveal`,
  ).toBeLessThanOrEqual(PAINT.setActive.maxW)
})

test('/accounts: the card action clears the 44px touch-target floor without moving a pixel', async ({
  page,
}) => {
  test.slow()
  const probe = await openAccountsWithBothCards(page)
  const [setActive] = probe.buttons

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
    `"Set active"'s target is ${setActive.hit.w}px against a ${setActive.paint.w}px box — it has grown SIDEWAYS, which the vertical-only rule forbids for a labelled control`,
  ).toBeLessThanOrEqual(PAINT_TOLERANCE)
})

/**
 * #2374 — the removal, pinned.
 *
 * An absence assertion is weak by nature, so this one is built the way the
 * `/accounts` inflow-closure tests are: scan PAGE-WIDE, match the strings a
 * reintroduction would actually have to render, and carry a positive control
 * in the same test so a blank page cannot read as a pass.
 *
 * WHY THE SCAN IS ON /default/i AND NOT ON THE OLD `aria-label`. The star's
 * accessible name was `Set <account> as default`. Pinning that exact string
 * would pass on the labelled `Set default` variant the decision explicitly
 * rejected, and on a kebab-menu item added to the card later. Matching any
 * button whose accessible name or visible text mentions "default" is the
 * scope of the decision rather than the shape of the thing removed. The
 * `default` BADGE is a `span` and is untouched by it — deliberately: the chip
 * that NAMES the state stays, only the control that SETS it from the card is
 * gone.
 */
test('/accounts: the card offers no set-default control', async ({ page }) => {
  test.slow()
  const probe = await openAccountsWithBothCards(page)

  // Non-vacuity FIRST, and it is the whole reason this test can be trusted:
  // the same scan, on the same page, must still find the control that IS
  // meant to be there. Without this an empty `/accounts` is a green run.
  // `.some(includes)` rather than `toContain`: the scan concatenates the
  // accessible name with the visible text, so this entry reads
  // "Set Imported Safe as active Set active" — an exact match would be pinning
  // the concatenation format rather than the control's presence. The same scan
  // also sees the sidebar's account switcher, which is why the /default/i arm
  // below is written as "nothing mentions default" rather than "no buttons".
  expect(
    probe.setActiveControls.some((n) => n.includes(`Set ${ACTION_CARD} as active`)),
    `the page rendered no set-active control either — this run proves nothing about an absence. The scan saw ${JSON.stringify(probe.setActiveControls)}`,
  ).toBe(true)

  expect(
    probe.setDefaultControls,
    `the card renders ${JSON.stringify(probe.setDefaultControls)} — #2374 removed the set-default control from /accounts; it lives on /accounts/<id> only`,
  ).toEqual([])
})

/**
 * The geometry above is geometry over a DECORATION unless a finger actually
 * works the control, and `page.tap()` dispatches a genuine touch sequence only
 * under `chromium-mobile`.
 *
 * ## WHAT THIS TEST LOST TO #2374, said plainly
 *
 * It used to tap the STAR, and it could assert two containment properties
 * because the star's effect (`setDefault` -> `PUT /user/safes/:id/default`)
 * was DISTINGUISHABLE from the card link's own effect (`setActiveSafe` ->
 * `localStorage['haven_active_safe_id']`). With the star gone the only control
 * left is "Set active", whose handler calls `setActiveSafe(safe)` — **the
 * identical call the card's own `onClick` makes, with the identical argument.**
 *
 * So `stopPropagation()` is no longer observable here: whether the card's
 * handler also ran or not, the observable state is the same value written to
 * the same key. That half is therefore REMOVED rather than reworded into a
 * check that cannot fail — the same standard this file applied when it killed
 * its own "the URL did not change" assertion for being unable to distinguish
 * "navigation was suppressed" from "navigation never happens here".
 *
 * A guard that cannot fail is not a guard, and pretending otherwise here would
 * be worse than the gap: it would read as covered.
 *
 * WHAT IS STILL ASSERTED, and it is not nothing:
 *
 *   - the tap WORKS — the active account really changes, so every hit
 *     rectangle above is geometry over a live control;
 *   - the click ends `defaultPrevented`, so the anchor's native navigation is
 *     off and the tap does not double as "open the account". This is the half
 *     that still has an independent signal, and it is read AFTER dispatch
 *     completes (a capture-phase listener holding the event, drained on a
 *     macrotask), because `defaultPrevented` during capture is always false
 *     and would assert nothing;
 *   - no set-default write leaves the page. Kept from the old test and
 *     repurposed: `PUT /user/safes/:id/default` is intercepted and must never
 *     fire, which is a second, network-level reading of #2374's removal.
 */
test('/accounts: a real tap on the visible "Set active" switches the account and does not navigate', async ({
  page,
}) => {
  test.slow()
  await openAccountsWithBothCards(page)

  /*
    The write the REMOVED control used to make. Intercepted so that a
    reintroduced star — or any tap that reaches one — shows up here as a
    network event rather than as a silent success.
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

  await page.tap(`a[aria-label="${ACTION_CARD}"] button[aria-label="Set ${ACTION_CARD} as active"]`)
  await page.waitForTimeout(1200)
  const probe = await page.evaluate(
    () => (window as unknown as { __tapProbe: { defaultPrevented: boolean | null } }).__tapProbe,
  )
  const activeSafeAfter = await page.evaluate(() => localStorage.getItem('haven_active_safe_id'))

  // Non-vacuity: the seeded id has to be readable AND has to be the other
  // account, or "it changed" is trivially true or trivially impossible.
  expect(activeSafeBefore, 'no active safe was seeded — a change reading proves nothing').not.toBeNull()
  expect(
    activeSafeAfter,
    `tapping "Set active" left the active account at ${activeSafeAfter} — the visible control is a decoration`,
  ).not.toBe(activeSafeBefore)

  expect(
    probe.defaultPrevented,
    'no click reached the document — the containment assertion below would be vacuous',
  ).not.toBeNull()
  expect(
    probe.defaultPrevented,
    "the click ended un-prevented — the card link's native navigation is still armed under the button",
  ).toBe(true)

  expect(
    defaultWrite,
    `tapping "Set active" sent ${defaultWrite} — a set-default write left a page that has no set-default control (#2374)`,
  ).toBeNull()
})
