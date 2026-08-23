/**
 * `ui/Modal`'s scroll continuation cue, in a browser that actually lays out (#1893).
 *
 * ## Why this exists alongside the unit tests
 *
 * `src/components/ui/__tests__/Modal.test.tsx` covers the same behaviour, but
 * JSDOM has no layout: every element there reports
 * `scrollHeight === clientHeight === 0`, so those tests have to STATE the
 * geometry by hand. They prove the condition is wired correctly; they cannot
 * prove a real dialog overflows, that the cue is painted where the content
 * actually runs out, or that resizing the viewport re-measures. Only a real
 * engine can say that, and this spec is the part of #1893's guard that is not
 * describing its own fixture back to itself.
 *
 * ## Why `/design-system` and not one of the product dialogs
 *
 * The cue lives on the shared primitive, so the honest subject is the
 * primitive's own showcase rather than any one caller. `/design-system`'s Modal
 * demo was extended in this same change to carry a body long enough to
 * overflow — which is also what its "Long content" card had been claiming
 * without demonstrating.
 *
 * ## The element under test is NOT `getByRole('dialog')`
 *
 * `role="dialog"` sits on `Modal`'s `fixed inset-0` wrapper, which never
 * scrolls, so reading scroll geometry off it yields
 * `scrollHeight === clientHeight` forever — a check that cannot fail. The
 * scroll box is `[data-modal-body]`. The last test below pins that distinction
 * as a measurement rather than trusting the markup to stay put.
 */
import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'

const CUE = '[data-modal-scroll-cue]'
const BODY = '[data-modal-body]'

test.describe('ui/Modal scroll continuation cue', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  async function openDemoDialog(page: import('@playwright/test').Page) {
    await page.goto('/design-system')
    await page.evaluate(() => document.fonts.ready)
    await page.getByRole('button', { name: 'Open modal' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    return page.locator(BODY)
  }

  test('appears while the body overflows and retires at the end of the scroll', async ({
    page,
  }) => {
    // Short enough that the demo dialog's body cannot fit its content.
    await page.setViewportSize({ width: 1280, height: 600 })
    const body = await openDemoDialog(page)

    // Measured, not assumed: if the demo ever stops overflowing at this
    // viewport, this spec must say so rather than quietly asserting the cue is
    // absent for a reason unrelated to the cue.
    const overflow = await body.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    )
    expect(overflow, 'the demo dialog must actually overflow at 1280x600').toBeGreaterThan(0)

    await expect(page.locator(CUE)).toBeVisible()

    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })

    await expect(page.locator(CUE)).toHaveCount(0)
  })

  test('shows nothing for a body that fits, and re-measures when the viewport changes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    await openDemoDialog(page)
    await expect(page.locator(CUE)).toBeVisible()

    // Tall enough for the whole body. Nothing tells the dialog the viewport
    // moved — it has to notice, which is the ResizeObserver half of the wiring
    // and is invisible to the JSDOM tests.
    await page.setViewportSize({ width: 1280, height: 1800 })
    await expect(page.locator(BODY)).toHaveJSProperty('scrollTop', 0)
    await expect(page.locator(CUE)).toHaveCount(0)

    await page.setViewportSize({ width: 1280, height: 600 })
    await expect(page.locator(CUE)).toBeVisible()
  })

  test('the scroll box is the body, not the role="dialog" wrapper', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    const body = await openDemoDialog(page)

    const geometry = await page.evaluate(() => {
      const wrapper = document.querySelector('[role="dialog"]') as HTMLElement
      const scrollBox = document.querySelector('[data-modal-body]') as HTMLElement
      return {
        wrapperOverflow: wrapper.scrollHeight - wrapper.clientHeight,
        wrapperScrollTopAfterPush: (() => {
          wrapper.scrollTop = 9999
          return wrapper.scrollTop
        })(),
        wrapperOverflowY: getComputedStyle(wrapper).overflowY,
        bodyOverflow: scrollBox.scrollHeight - scrollBox.clientHeight,
        wrapperContainsBody: wrapper.contains(scrollBox),
        sameNode: wrapper === scrollBox,
      }
    })

    expect(geometry.sameNode).toBe(false)
    expect(geometry.wrapperContainsBody).toBe(true)

    // The point, and it is sharper than "the wrapper reports zero".
    //
    // Measured on this branch: the wrapper reports a 4px overflow — its `p-4`
    // padding against the panel it centres — while the body reports the real
    // one. But the wrapper is `overflow: visible` and `position: fixed`, so
    // that 4px can never be scrolled away: `scrollTop` stays pinned at 0 no
    // matter what you assign. A cue driven off this node would therefore not
    // merely be inaccurate, it would latch on at mount and never retire.
    expect(geometry.wrapperOverflowY).toBe('visible')
    expect(geometry.wrapperScrollTopAfterPush).toBe(0)
    expect(geometry.bodyOverflow).toBeGreaterThan(geometry.wrapperOverflow * 10)

    // And the cue is painted inside the scroll box's own positioned wrapper,
    // flush with where the content runs out — not down with the footer, which
    // is a flex SIBLING of the scroll box and describes nothing about it.
    const cueBox = await page.locator(CUE).boundingBox()
    const bodyBox = await body.boundingBox()
    expect(cueBox).not.toBeNull()
    expect(bodyBox).not.toBeNull()
    expect(Math.abs(cueBox!.y + cueBox!.height - (bodyBox!.y + bodyBox!.height))).toBeLessThanOrEqual(1)
  })
})
