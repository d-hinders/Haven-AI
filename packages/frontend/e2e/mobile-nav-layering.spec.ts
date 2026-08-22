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
 * ── Why it declares its own viewport ────────────────────────────────────────
 * The gating CI job runs `test:e2e:desktop` (`--project=chromium-desktop`);
 * the `chromium-mobile` project runs only on a manual `ui_suite=full`
 * dispatch. A mobile-project spec therefore would NOT gate a pull request —
 * which is a large part of why this survived. `test.use({ viewport })`
 * overrides the project's viewport, so these run inside the desktop project
 * and are genuinely blocking.
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
