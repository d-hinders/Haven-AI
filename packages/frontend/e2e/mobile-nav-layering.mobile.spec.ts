import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

/**
 * Mobile navigation layering (#1749).
 *
 * The `Open sidebar` toggle is `position: fixed` in the same 56px band that
 * `TopBar` occupies. Whichever of the two wins the stacking contest owns the
 * clicks in that band, and for the whole life of the shell `TopBar` did — so
 * primary navigation was unopenable below `lg` on every authenticated route.
 *
 * Measured on the pre-fix code, at 320 / 390 / 768 / 1023px on `/dashboard`:
 *
 *   computed z-index            toggle 60, header 100
 *   elementFromPoint(32, 32)    div.flex.items-center.gap-3   ← TopBar's inner div
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
 * the band the toggle is `lg:hidden` for. The override sets the width; the
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
  //    toggle's own centre, the drawer against the header's own height. Those
  //    are all preserved by a transformation that moves the whole shell, so
  //    this spec passed the mutation that exposed the gap — the toggle's
  //    `fixed` swapped for `relative`, which drops it into flow as a 32px flex
  //    item and shifts `<header>` from x=0 to x=32 while every relative
  //    reading holds. Measured, not predicted.
  //
  //    The top bar spanning the viewport edge to edge is the right anchor for
  //    THIS spec specifically: the 56px band is its whole subject — the band
  //    where the toggle and `TopBar` contest the stacking order — so pinning
  //    that band to the screen says the geometry the layering claims are made
  //    against has not moved under them.
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
  //    failure prints how far the bar is off each edge instead of two absolute
  //    numbers the reader then has to subtract.
  const shell = await page.evaluate(() => {
    const header = document.querySelector('header')
    if (!header) return null
    const b = header.getBoundingClientRect()
    return {
      leftGap: Math.round(b.left),
      rightGap: Math.round(window.innerWidth - b.right),
      viewportWidth: window.innerWidth,
      headerWidth: Math.round(b.width),
    }
  })
  expect(shell, 'no <header> — the shell never rendered').not.toBeNull()
  expect(
    { leftGap: shell!.leftGap, rightGap: shell!.rightGap },
    `top bar is not anchored to the viewport: ${JSON.stringify(shell)}`,
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

  const nav = page.getByRole('navigation')
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible()

  // 3. The drawer owns its own top band. It is `inset-y-0`, so its 56px logo
  //    band shares that band with TopBar; if TopBar wins there the drawer is
  //    decapitated and the scrim dims everything except the bar it exists to
  //    dim — the same root cause as the toggle, one layer down.
  //
  //    Wait for the 200ms slide to FINISH first. A visible link is not enough:
  //    a transforming element still has a non-empty box, so hit-testing here
  //    can land on a part-way drawer, return the scrim, and report a layering
  //    defect that does not exist. That false failure hit three of four widths
  //    on this spec's first run.
  await page.waitForFunction(
    () => Math.round(document.querySelector('aside')!.getBoundingClientRect().left) === 0,
    undefined,
    { timeout: 10_000 },
  )

  const layering = await page.evaluate(() => {
    const aside = document.querySelector('aside')!
    const header = document.querySelector('header')!
    const r = aside.getBoundingClientRect()
    const top = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(header.getBoundingClientRect().height / 2),
    )
    return {
      drawerOwnsItsTopBand: aside.contains(top),
      topElement: top?.tagName.toLowerCase() ?? null,
    }
  })
  expect(layering).toMatchObject({ drawerOwnsItsTopBand: true })

  // 4. ...and back out. The Close affordance is the SAME button, so if the
  //    drawer or its scrim covered it, the sidebar could be opened and then
  //    never closed by the control that opened it.
  const close = page.getByRole('button', { name: 'Close sidebar' })
  await expect(close).toBeVisible()
  await close.click()
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

      test('the toggle is hit-testable and the drawer layers above the top bar', async ({ page }) => {
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
    // fix that raised the toggle above TopBar cannot have leaked a floating
    // hamburger onto the desktop shell.
    test('no mobile toggle renders at 1024px', async ({ page }) => {
      await page.goto('/dashboard')
      await expect(page.getByRole('navigation').getByRole('link', { name: 'Dashboard' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeHidden()
      await expect(page.getByRole('button', { name: 'Close sidebar' })).toBeHidden()
    })
  })
})
