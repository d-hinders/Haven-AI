import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, waitForDrawerOpen } from './fixtures/haven-api'

/**
 * Mobile navigation layering (#1749).
 *
 * The `Open sidebar` toggle is `position: fixed` and, for most of the shell's
 * life, sat in the same 56px band the top bar occupied. Whichever of the two
 * won the stacking contest owned the clicks in that band, and for that whole
 * period the bar did — so primary navigation was unopenable below `lg` on
 * every authenticated route. (#4029 deleted the bar. Since #4053 the control
 * is the tab bar's More cell and opens a bottom sheet that stops at the bar's
 * top edge, so nothing floats over anything: the hit-tests below now prove
 * the More cell is reachable before AND while the sheet is open.)
 *
 * Measured on the pre-fix code, at 320 / 390 / 768 / 1023px on `/dashboard`:
 *
 *   computed z-index            toggle 60, header 100
 *   elementFromPoint(32, 32)    div.flex.items-center.gap-3   ← the bar's inner div
 *   non-forced .click()         "…intercepts pointer events"
 *
 * ...and after it, at the same four widths:
 *
 *   computed z-index            toggle 150, header 100
 *   elementFromPoint(32, 32)    path                          ← the toggle's own icon
 *   non-forced .click()         opens the drawer
 *
 * ── Why this is a browser spec and not a unit test ──────────────────────────
 * A jsdom test can assert the class strings and would have passed throughout
 * the entire period the bug was live: jsdom has no layout, no stacking
 * contexts and no hit-testing, so `elementFromPoint` and "is this element
 * actionable" do not exist there in any meaningful form. The defect is purely
 * a rendered-layout property. Only a real engine can see it.
 *
 * ── Which project this runs in, and why it still declares viewports ─────────
 * This was `mobile-nav-layering.spec.ts` in `chromium-desktop`, using
 * `test.use({ viewport })` — for the reason its original header stated
 * plainly: the gating CI job ran `test:e2e:desktop`, `chromium-mobile` ran
 * only on a manual `ui_suite=full` dispatch, and so a mobile-project spec
 * would not have gated a pull request at all. #1768 removed that constraint.
 * Both projects now gate every PR, `*.mobile.spec.ts` selects into the Pixel 5
 * one, and the workaround is retired: the spec lives in the project it always
 * belonged to.
 *
 * The gain is not cosmetic. A viewport override inside `chromium-desktop`
 * leaves `maxTouchPoints` at 0, `pointer: coarse` false and the UA desktop —
 * so every hit-test below was being answered for a MOUSE in a narrow window.
 * They now run under real device emulation, which is the pointer a phone
 * actually uses, on the one defect class where that distinction is the whole
 * point.
 *
 * `test.use({ viewport })` stays, and is no longer a lie about the project: a
 * project pins ONE viewport, and the point of this spec is the sweep across
 * the widths the toggle is `lg:hidden` for. The override sets the width; the
 * touch/UA emulation the project provides is unaffected by it.
 */

// The toggle is `lg:hidden`, so everything from the narrowest phone up to one
// pixel below the `lg` breakpoint is affected. 1023 is where a regression
// would most plausibly reappear.
const MOBILE_WIDTHS = [320, 390, 768, 1023]

/**
 * Every check that needs the shell rendered, against ONE page load.
 *
 * Deliberately not split into a test per assertion: each test costs a full
 * navigation, and at four viewports that turned a layering check into 17 page
 * loads in a smoke suite that is supposed to be fast.
 */
async function expectNavigationReachable(page: Page) {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  await expect(open).toBeVisible()

  // 0. The VIEWPORT-ABSOLUTE anchor (#1779), asserted BEFORE the hit-tests
  //    because it is the frame they are all read in.
  //
  //    Every other assertion in this function measures one element against
  //    another: the toggle against whatever `elementFromPoint` returns at the
  //    toggle's own centre, the sheet against its own logo band. Those are
  //    all preserved by a transformation that moves the whole shell, so this
  //    spec passed the mutation that exposed the gap — the toggle's `fixed`
  //    swapped for `relative`, which drops it into flow and shifts the chrome
  //    from x=0 to x=32 while every relative reading holds. Measured, not
  //    predicted.
  //
  //    The app FRAME (`[data-app-frame]`, the `h-screen` flex row holding the
  //    sidebar and the scroll column) spanning the viewport edge to edge is
  //    the right anchor for THIS spec: it is the box every layered element
  //    overlays, so pinning it to the screen says the geometry the
  //    layering claims are made against has not moved under them. (It was the
  //    top bar's `<header>` until the bar was deleted, #4029 — a bare
  //    `querySelector('header')` now finds `PageHeader`'s header INSIDE the
  //    scroll region, which is exactly the silent re-point this comment
  //    refuses.)
  //
  //    Computed here rather than through `expectNoHorizontalOverflow`, on
  //    purpose. `navigation.mobile.spec.ts` gets its anchor from that shared
  //    helper; if this one did too, a single weakened helper would blind every
  //    mobile suite at once and nothing would go red — one shared reference
  //    frame that everything trusts is precisely the defect #1779 is about, and
  //    re-introducing it one layer up would be the same mistake wearing the
  //    fix's clothes. Two independently-computed anchors can disagree.
  //
  //    Expressed as two GAPS rather than as `right === innerWidth`, so a
  //    failure prints how far the frame is off each edge instead of two
  //    absolute numbers the reader then has to subtract.
  const shell = await page.evaluate(() => {
    const frame = document.querySelector('[data-app-frame]')
    if (!frame) return null
    const b = frame.getBoundingClientRect()
    return {
      leftGap: Math.round(b.left),
      rightGap: Math.round(window.innerWidth - b.right),
      viewportWidth: window.innerWidth,
      frameWidth: Math.round(b.width),
    }
  })
  expect(shell, 'no [data-app-frame] — the shell never rendered').not.toBeNull()
  expect(
    { leftGap: shell!.leftGap, rightGap: shell!.rightGap },
    `app frame is not anchored to the viewport: ${JSON.stringify(shell)}`,
  ).toEqual({ leftGap: 0, rightGap: 0 })

  // 1. The hit-test from the original report. `elementFromPoint` answers "what
  //    would a tap here actually reach", which is the only question that
  //    matters — the button's own computed style was always correct.
  const hit = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Open sidebar"]')
    if (!btn) return { error: 'toggle not found' }
    const r = btn.getBoundingClientRect()
    const top = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(r.top + r.height / 2),
    )
    return {
      reachesToggle: top === btn || btn.contains(top),
      // Named so a failure says WHAT is covering it rather than just "false" —
      // the first question anyone asks next. On the pre-fix code this read
      // `div.flex.items-center.gap-3`, TopBar's inner row.
      obstructedBy: top
        ? `${top.tagName.toLowerCase()}.${String(top.className).trim().split(/\s+/).slice(0, 3).join('.')}`
        : null,
    }
  })
  expect(hit).toMatchObject({ reachesToggle: true })

  // 2. A NON-forced click. Playwright's actionability check runs the same
  //    hit-test before clicking, so an obstructed toggle fails here with
  //    "intercepts pointer events" rather than silently passing.
  await open.click()

  // Scoped to the SHEET's landmark (#2731, #4053). A bare
  // `getByRole('navigation')` is a strict-mode violation rather than a
  // silent wrong answer, which is the good failure mode. Marketplace, not
  // Dashboard: the sheet carries only what the tab bar does not.
  const sheet = page.locator('[data-more-sheet]')
  const nav = sheet.getByRole('navigation', { name: 'All sections' })
  await expect(nav.getByRole('link', { name: 'Marketplace' })).toBeVisible()

  // 3. The sheet owns its own top band, and the tab bar stays the topmost
  //    thing in its own band (#4053). Wait for the slide-up to FINISH first:
  //    a moving element still has a non-empty box, so hit-testing mid-slide
  //    lands on the scrim and reports a defect that does not exist (#1749's
  //    false failures on three of four widths).
  await waitForDrawerOpen(page)

  const layering = await page.evaluate(() => {
    const sheetEl = document.querySelector('[data-more-sheet]')!
    const band = sheetEl.querySelector('[data-logo-band]')!.getBoundingClientRect()
    const r = sheetEl.getBoundingClientRect()
    const topOfSheet = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(band.top + band.height / 2),
    )
    const bar = document.querySelector('[data-mobile-tab-bar]')!
    const more = bar.querySelector('[data-more-toggle]')!.getBoundingClientRect()
    const atMore = document.elementFromPoint(
      Math.round(more.left + more.width / 2),
      Math.round(more.top + more.height / 2),
    )
    return {
      sheetOwnsItsTopBand: sheetEl.contains(topOfSheet),
      moreCellIsTopmost: !!atMore && bar.contains(atMore),
      // The sheet ends at the bar's top edge — never overlapping it.
      sheetBottomAtBarTop: Math.round(r.bottom) === Math.round(bar.getBoundingClientRect().top),
      topElement: topOfSheet?.tagName.toLowerCase() ?? null,
    }
  })
  expect(layering).toMatchObject({ sheetOwnsItsTopBand: true, moreCellIsTopmost: true, sheetBottomAtBarTop: true })

  // 4. ...and back out, through the same cell.
  const close = page.getByRole('button', { name: 'Close sidebar' })
  await expect(close).toBeVisible()
  await close.click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible()
}

test.describe('mobile navigation is reachable below lg (#1749)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const width of MOBILE_WIDTHS) {
    test.describe(`at ${width}px`, () => {
      test.use({ viewport: { width, height: 844 } })

      test('More is hit-testable and the sheet owns its top band without covering the bar', async ({ page }) => {
        await page.goto('/dashboard')
        await expectNavigationReachable(page)
      })
    })
  }

  test.describe('on a second route', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    // Both z-index values are hardcoded and route-independent, so one more
    // route is enough to show this is the shell and not a `/dashboard` quirk —
    // "route-independent" was an assumption in the original report rather than
    // something anyone had checked.
    test('the same holds on /agents', async ({ page }) => {
      await page.goto('/agents')
      await expectNavigationReachable(page)
    })
  })

  test.describe('at the lg breakpoint', () => {
    test.use({ viewport: { width: 1024, height: 844 } })

    // The complement of the checks above: `lg:hidden` must still hide it, so a
    // fix that raised the toggle above the chrome cannot have leaked a floating
    // hamburger onto the desktop shell.
    test('no mobile toggle renders at 1024px', async ({ page }) => {
      await page.goto('/dashboard')
      await expect(
        page.getByRole('navigation', { name: 'All sections' }).getByRole('link', { name: 'Dashboard' }),
      ).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeHidden()
      await expect(page.getByRole('button', { name: 'Close sidebar' })).toBeHidden()
    })
  })
})

/**
 * The rail must leave the screen when the viewport CROSSES into mobile
 * (#2586).
 *
 * #2586's defect: below `lg` the old drawer was `fixed inset-y-0 left-0` and
 * only a JS-decided `-translate-x-full` kept it off screen, so a window that
 * started at desktop width and then narrowed left the whole sidebar parked on
 * top of the page. #4053 changed the mechanism — the rail is `hidden` below
 * `lg` by CSS, and the phone menu is a separate sheet that starts closed — but
 * the claim this spec holds is unchanged and still rendered-only: after the
 * crossing, the coordinate the rail's footer occupied belongs to the page.
 *
 * ── Why this could not have been caught by a visual baseline ────────────────
 * It reproduces only after a CROSSING. `scripts/screenshot.mjs` sets the
 * viewport BEFORE it navigates, so the initialiser always sees the narrow width
 * and a fresh 390px capture is clean — verified, by capturing the `/agents`
 * empty state at 390 on the unfixed code and finding the prompt card and its
 * footer link fully visible. #2586's third acceptance criterion asks whether a
 * whole-page mobile baseline for `/agents` would have caught this. It would
 * not, and no baseline could: the harness cannot express a resize. That is the
 * answer to the criterion, and it is why the guard is here rather than there.
 *
 * ── Why a browser and not jsdom ────────────────────────────────────────────
 * The unit sibling in `Sidebar.test.tsx` asserts the class string, which is the
 * cheap half and pins the state machine. It cannot see whether the element
 * actually covers anything: jsdom has no layout, so a drawer at
 * `translate-x-0` and one at `-translate-x-full` occupy the same nothing. The
 * claim that matters — page content at that coordinate is reachable — is a
 * rendered property.
 */
test.describe('the rail leaves the screen when the viewport narrows (#2586)', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    // `/agents` with no agents is #2586's own route and state: the empty state
    // is the first screen tall enough to reach the coordinate in question.
    await page.route('**/api/agents*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agents: [] }),
      })
    })
  })

  test('narrowing past lg hides the rail and hands the coordinate back to the page', async ({
    page,
  }) => {
    await page.goto('/agents')
    // Hide Next's dev-tools indicator, exactly as `scripts/screenshot.mjs`
    // does. Under `next dev` that badge sits at the bottom-left of every page
    // and OWNS this spec's hit-test coordinate — so without it the assertions
    // below are answered by dev chrome rather than by the product. It is also
    // the element #2586 mistook for the sidebar's avatar.
    //
    // AFTER the navigation, not in `beforeEach`: an earlier copy ran before
    // any `goto`, so the injected style was discarded by the navigation and
    // its `.catch(() => {})` hid that it never applied (review nit).
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' })
    // The shell renders after the auth context resolves, and at 1280 the
    // `Open sidebar` toggle this spec's sibling waits on is `lg:hidden` — so
    // wait on the rail itself rather than on a control that is correctly
    // absent at this width.
    await page.waitForSelector('aside', { state: 'attached', timeout: 15_000 })

    // Mounted wide: on screen and in flow, which is correct — at `lg` the
    // rail is `static`, not an overlay. Asserted so the crossing below is
    // measured against a known start rather than an assumed one.
    const wide = await page.evaluate(() => {
      const r = document.querySelector('aside')!.getBoundingClientRect()
      return { left: Math.round(r.left), width: Math.round(r.width) }
    })
    expect(wide.width).toBeGreaterThan(0)
    expect(wide.left).toBe(0)

    await page.setViewportSize({ width: 390, height: 844 })

    // The rail is `hidden` below `lg` (#4053): no box at all after the
    // crossing, and no sheet either — narrowing never opens the menu.
    await page.waitForFunction(
      () => {
        const r = document.querySelector('aside')?.getBoundingClientRect()
        return !!r && r.width === 0 && r.height === 0
      },
      undefined,
      { timeout: 10_000 },
    )

    // 1. The rail is gone from the viewport, and no sheet opened.
    const narrow = await page.evaluate(() => {
      const r = document.querySelector('aside')!.getBoundingClientRect()
      return { width: Math.round(r.width), sheet: !!document.querySelector('[data-more-sheet]') }
    })
    expect(narrow, `rail still intrudes: ${JSON.stringify(narrow)}`).toEqual({ width: 0, sheet: false })

    // 2. The claim that actually matters, asked the way a tap asks it: at the
    //    bottom-left coordinate the sidebar's footer row occupied, what would
    //    the user reach? Anything inside `aside` here is the reported defect.
    //    `insideDrawer: false` alone is too weak, and was (review finding): it
    //    passes when the coordinate is owned by ANYTHING that is not the aside
    //    — the `fixed inset-0` scrim included, which would obscure the entire
    //    page. So the element is named and required to be inside `<main>`.
    const hit = await page.evaluate(() => {
      const aside = document.querySelector('aside')
      const bar = document.querySelector('[data-mobile-tab-bar]')
      const barH = bar ? Math.round(bar.getBoundingClientRect().height) : 0
      // ABOVE the tab bar (#2731). The probe used to sit 40px off the bottom,
      // which was page content then and is the bar's own band now — the bar is
      // 56px tall and `fixed`. Reading the old coordinate would have reported
      // "the page is covered" about chrome that is supposed to be there, which
      // is a false defect rather than a missed one, but still a spec measuring
      // the wrong box.
      const top = document.elementFromPoint(24, window.innerHeight - barH - 40)
      // ...and the bar's OWN band, which is new ground this spec should hold:
      // after the crossing, the bottom strip must belong to the tab bar
      // and not to the rail.
      const inBar = bar ? document.elementFromPoint(24, window.innerHeight - barH / 2) : null
      return {
        insideDrawer: !!(top && aside?.contains(top)),
        insidePageContent: !!top?.closest('main'),
        // Named so a failure says WHAT is covering the page rather than just
        // `true` — the first question anyone asks next.
        topElement: top?.tagName.toLowerCase() ?? null,
        barBandIsTheBar: !!(inBar && bar?.contains(inBar)),
        barBandInsideDrawer: !!(inBar && aside?.contains(inBar)),
      }
    })
    expect(hit).toMatchObject({
      insideDrawer: false,
      insidePageContent: true,
      barBandIsTheBar: true,
      barBandInsideDrawer: false,
    })

    // 3. The symptom #2586 actually reported, asserted on the element it named:
    //    the empty state's footer link must be reachable, not clipped by
    //    anything. `toBeVisible` is not enough — a covered element is still
    //    visible — so this hit-tests the link's own centre.
    const guide = page.getByRole('link', { name: 'Read the agent guide' })
    await expect(guide).toBeVisible()
    // The shell is `h-screen overflow-hidden` with `<main>` as the only
    // scroller, and the empty state is taller than the viewport — so the link
    // starts BELOW the fold and `elementFromPoint` at its coordinates returns
    // null (measured: `covering: null`, which reads as "covered" while nothing
    // is covering it). Scroll it into view before hit-testing.
    // No fixed wait after this: nothing in `src/` sets `scroll-behavior:
    // smooth`, so the scroll completes synchronously, and a sleep in a spec
    // whose own comment above argues for `waitForFunction` over fixed waits is
    // the wrong example to leave behind (review nit). The link's own position
    // is what the probe reads, and it is settled by the time this returns.
    await guide.scrollIntoViewIfNeeded()
    const linkReachable = await guide.evaluate((el) => {
      // Per LINE BOX, not the bounding box. This link WRAPS at 390px, and the
      // centre of a two-line inline element's bounding box falls in the gap
      // between the lines — which returns the parent and reads as "covered"
      // when nothing is covering it. Measured: the first assertion written
      // this way failed on a page with the link fully legible.
      const rects = Array.from(el.getClientRects())
      const probes = rects.map((r) => {
        const top = document.elementFromPoint(
          Math.round(r.left + r.width / 2),
          Math.round(r.top + r.height / 2),
        )
        return { reachable: top === el || el.contains(top), covering: top?.tagName.toLowerCase() ?? null }
      })
      return {
        lineBoxes: rects.length,
        reachable: probes.length > 0 && probes.every((p) => p.reachable),
        covering: probes.find((p) => !p.reachable)?.covering ?? null,
      }
    })
    expect(linkReachable).toMatchObject({ reachable: true })
  })
})
