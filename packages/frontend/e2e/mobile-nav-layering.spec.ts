import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

/**
 * Mobile navigation layering (#1749).
 *
 * The `Open sidebar` toggle is `position: fixed` in the same 56px band that
 * `TopBar` occupies. Whichever of the two wins the stacking contest owns the
 * clicks in that band, and for the whole life of the shell `TopBar` did — so
 * primary navigation was unopenable below `lg` on every authenticated route.
 *
 * ── Why this spec is a browser spec and not a unit test ─────────────────────
 * A jsdom test can assert the class strings and would have passed throughout
 * the entire period the bug was live: jsdom has no layout, no stacking
 * contexts, and no hit-testing, so `elementFromPoint` and "is this element
 * actionable" do not exist there in any meaningful form. The defect is
 * *purely* a rendered-layout property. Only a real engine can see it.
 *
 * ── Why it declares its own viewport ────────────────────────────────────────
 * The gating CI job runs `test:e2e:desktop` (`--project=chromium-desktop`);
 * the `chromium-mobile` project runs only on a manual `ui_suite=full`
 * dispatch. A mobile-project spec therefore would NOT gate a pull request —
 * which is a large part of why this survived. `test.use({ viewport })`
 * overrides the project's viewport, so these run inside the desktop project
 * and are genuinely blocking.
 */

// Deliberately several widths, not just 390: the toggle is `lg:hidden`, so
// everything from the narrowest phone up to one pixel below the `lg`
// breakpoint is affected, and 1023 is the width where a regression would most
// plausibly reappear.
const MOBILE_WIDTHS = [320, 390, 768, 1023]

// Every authenticated route renders the same shell, and both z-index values
// are hardcoded and route-independent — but "route-independent" was an
// assumption in the original report, so two different routes are checked
// rather than argued about.
const ROUTES = ['/dashboard', '/agents']

test.describe('mobile navigation is reachable below lg (#1749)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const width of MOBILE_WIDTHS) {
    test.describe(`at ${width}px`, () => {
      test.use({ viewport: { width, height: 844 } })

      test('the toggle wins the hit-test at its own centre', async ({ page }) => {
        await page.goto(ROUTES[0])

        const toggle = page.getByRole('button', { name: 'Open sidebar' })
        await expect(toggle).toBeVisible()

        // The exact check from the report. `elementFromPoint` answers "what
        // would a tap here actually reach", which is the only question that
        // matters — the button's own computed style was always correct.
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
            // Named so a failure report says WHAT is covering it rather than
            // just "false" — the first question anyone asks next.
            obstructedBy: top
              ? `${top.tagName.toLowerCase()}${top.getAttribute('aria-label') ? `[aria-label="${top.getAttribute('aria-label')}"]` : ''}.${String(top.className).trim().split(/\s+/).slice(0, 4).join('.')}`
              : null,
          }
        })

        expect(hit, `elementFromPoint at the toggle centre must return the toggle at ${width}px`).toMatchObject({
          reachesToggle: true,
        })
      })

      for (const route of ROUTES) {
        test(`a non-forced click opens and closes the sidebar on ${route}`, async ({ page }) => {
          await page.goto(route)

          // No `{ force: true }`. Playwright's actionability check performs the
          // same hit-test before clicking, so an obstructed toggle fails here
          // with "intercepts pointer events" rather than silently passing.
          const open = page.getByRole('button', { name: 'Open sidebar' })
          await expect(open).toBeVisible()
          await open.click()

          // The drawer is genuinely on screen, not merely present in the DOM:
          // it translates in from `-translate-x-full`, so a link that is
          // `toBeVisible` proves the transform settled.
          const nav = page.getByRole('navigation')
          await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible()

          // ...and back. The Close affordance is the SAME button, so if the
          // drawer's own layers were raised past it this would fail.
          const close = page.getByRole('button', { name: 'Close sidebar' })
          await expect(close).toBeVisible()
          await close.click()
          await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible()
        })
      }

      test('the open drawer and its scrim cover the top bar', async ({ page }) => {
        await page.goto(ROUTES[0])
        await page.getByRole('button', { name: 'Open sidebar' }).click()
        await expect(page.getByRole('navigation').getByRole('link', { name: 'Dashboard' })).toBeVisible()

        // The drawer is `inset-y-0`, so its own 56px logo band shares the band
        // with TopBar. If TopBar wins there, the drawer is decapitated and the
        // scrim dims everything EXCEPT the bar it is supposed to dim — the
        // same root cause as the toggle, one layer down.
        const layering = await page.evaluate(() => {
          const aside = document.querySelector('aside')
          const header = document.querySelector('header')
          if (!aside || !header) return { error: 'shell not found' }
          const r = aside.getBoundingClientRect()
          // A point inside the drawer that also falls inside the header band.
          const inDrawerTopBand = document.elementFromPoint(
            Math.round(r.left + r.width / 2),
            Math.round(header.getBoundingClientRect().height / 2),
          )
          return {
            drawerOwnsItsTopBand: aside.contains(inDrawerTopBand),
            topElement: inDrawerTopBand?.tagName.toLowerCase() ?? null,
          }
        })

        expect(layering).toMatchObject({ drawerOwnsItsTopBand: true })
      })
    })
  }

  test.describe('at 1024px the toggle is gone entirely', () => {
    test.use({ viewport: { width: 1024, height: 844 } })

    // The complement of the checks above: `lg:hidden` must still hide it, so a
    // fix that raised the toggle above TopBar cannot have leaked a floating
    // hamburger onto the desktop shell.
    test('no mobile toggle renders at the lg breakpoint', async ({ page }) => {
      await page.goto(ROUTES[0])
      await expect(page.getByRole('navigation').getByRole('link', { name: 'Dashboard' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeHidden()
      await expect(page.getByRole('button', { name: 'Close sidebar' })).toBeHidden()
    })
  })
})
