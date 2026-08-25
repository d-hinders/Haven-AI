/**
 * `Tooltip` width and keyboard reach, measured in a real browser (#2038).
 *
 * ## Why this file exists
 *
 * Defect 2 — a `whitespace-nowrap` bubble with no width cap — is a text-layout
 * fact, and jsdom has no layout engine. There, a three-word label and a
 * 167-character one produce identical evidence, which is precisely how the
 * defect shipped: every gate the repo has either cannot see a closed tooltip
 * (the pixel gates, the rendered design review) or cannot measure an open one
 * (the unit suite). **This is the only assertion in the repo that fails on
 * long content specifically.**
 *
 * ## Why `/agents` and not a `/design-system` demo
 *
 * `AgentCard` passes `McpServerName` an agent with no recorded server name and
 * `McpServerName` hands `Tooltip` the 167-character sentence below — the
 * longest label any caller passes today, and defect 2's live instance.
 * #1924's rule applies: a showcase would photograph whatever the showcase
 * author wrote, not what the product passes. `testAgent` carries no
 * `mcp_server_name`, so the "not recorded" branch renders with no override.
 *
 * ## Why a desktop project at a phone width
 *
 * This is a GEOMETRY sweep — rectangles, not pixels, and not a hit test — the
 * shape `transaction-row.mobile.spec.ts` and `mobile-nav-layering.mobile.spec.ts`
 * established as legitimate. The bubble is opened by HOVER, which the mobile
 * project's coarse pointer does not have; the touch half is proven in its own
 * project in `tooltip-reachability.mobile.spec.ts`. #1768's warning is about
 * borrowing a desktop proof for a touch claim, which this does not do.
 *
 * ## The numbers, and why these
 *
 * The width bound is the viewport minus the primitive's own 8px gutter per
 * side. Before the fix the same bubble measures **988px on a 320px screen** —
 * three times the viewport, not a metric wobble. `MIN_WRAPPED_HEIGHT_PX` is the other half
 * of the same claim and is what makes it long-content-specific: a bubble can
 * be narrow because it wrapped or because it was clipped, and only the height
 * tells those apart. One line of `text-[12px] leading-tight` plus `py-1.5` is
 * ~27px; the wrapped result is several times that. 40px sits above any single
 * line and far below the real value.
 */
import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

/** The live long label, from `McpServerName`'s null branch. */
const LONG_LABEL =
  'Haven records this when an agent connects with a current version of the connector. Agents connected earlier keep working exactly as they are — only the label is missing.'

/** The narrowest phone width in the support matrix, and 390 beside it. */
const NARROW_WIDTHS = [320, 390] as const

/** `Tooltip`'s own keep-inside-the-viewport gutter, per side. */
const VIEWPORT_MARGIN_PX = 8

/** Above one line of `text-[12px] leading-tight` + `py-1.5` (~27px). */
const MIN_WRAPPED_HEIGHT_PX = 40

/** `/design-system`'s sample address, and its `truncate()` display form. */
const SAMPLE_ADDRESS = '0x8f4F0f6d712C5c5C9Bb02F4a5B5c0D7F462A6f4C'
const SAMPLE_TRUNCATED = '0x8f4F…6f4C'

test.describe('Tooltip width and keyboard reach (#2038)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('the 167-character label wraps inside a phone viewport instead of one unbroken bar', async ({
    page,
  }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.setViewportSize({ width: NARROW_WIDTHS[0], height: 800 })
    await page.goto('/agents')
    const trigger = page.getByText('not recorded').first()
    await expect(trigger).toBeVisible()

    for (const width of NARROW_WIDTHS) {
      await page.setViewportSize({ width, height: 800 })
      // Below `lg` the nav drawer overlays the page and intercepts the hover.
      await dismissMobileSidebar(page)
      await trigger.hover()

      const bubble = page.locator('[role="tooltip"]')
      await expect(bubble).toHaveText(LONG_LABEL)
      const box = await bubble.boundingBox()
      if (!box) throw new Error(`the open tooltip must have a box to measure at ${width}px`)

      // Wrapped, not one line: the width is capped AND the height grew.
      expect(box.width, `bubble width at ${width}px`).toBeLessThanOrEqual(
        width - 2 * VIEWPORT_MARGIN_PX,
      )
      expect(box.height, `bubble height at ${width}px`).toBeGreaterThanOrEqual(
        MIN_WRAPPED_HEIGHT_PX,
      )

      // Capping the width is not enough on its own — a capped bubble centred
      // on a trigger near the screen edge still hangs off it. The gutter, not
      // merely zero, is the primitive's stated contract, and asserting the
      // contract is what makes the clamp provable: a dead clamp leaves this
      // bubble two pixels from the left edge, which `>= 0` would wave through.
      expect(box.x, `bubble left edge at ${width}px`).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX)
      expect(box.x + box.width, `bubble right edge at ${width}px`).toBeLessThanOrEqual(
        width - VIEWPORT_MARGIN_PX,
      )

      // Leave the hover before the next width, so each pass re-opens rather
      // than measuring a bubble positioned for the previous viewport.
      await page.mouse.move(0, 0)
      await expect(bubble).toHaveCount(0)
    }

    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  // Both of `/design-system`'s standalone triggers, not one: `Address` renders
  // its trigger as a bare `<span>` and `WalletIdentityBlock` as a `<p>`. They
  // are the two shapes every other standalone call site reuses, so covering
  // both here is what makes the shared-code-path inference for
  // `AccountDetailClient` and `AgentDetailClient` an inference about markup
  // that has actually been rendered rather than only read.
  for (const [name, index] of [
    ['Address (span trigger)', 0],
    ['WalletIdentityBlock (p trigger)', 1],
  ] as const) {
    test(`${name} is in the tab order, rings on focus, and exposes its content`, async ({
      page,
    }) => {
      await page.goto('/design-system')

      const trigger = page.getByText(SAMPLE_TRUNCATED).nth(index)
      await expect(trigger).toBeVisible()

      // The wrapper the primitive renders. `tabindex="0"` on a visible,
      // enabled element IS the tab-order claim, in the real DOM rather than in
      // jsdom's model of it.
      const wrapper = trigger.locator('xpath=ancestor::*[@tabindex="0"][1]')
      await expect(wrapper).toHaveCount(1)

      // Set keyboard modality before focusing, or `:focus-visible` does not
      // engage and the ring assertion below measures the wrong state.
      await page.keyboard.press('Tab')
      await wrapper.focus()

      await expect(page.locator('[role="tooltip"]')).toHaveText(SAMPLE_ADDRESS)
      // The description is wired to the focused element, which is what an
      // assistive technology follows.
      const describedBy = await wrapper.getAttribute('aria-describedby')
      expect(describedBy).toBe(await page.locator('[role="tooltip"]').getAttribute('id'))

      // This primitive is what made the element focusable, so the focus
      // treatment is part of this change. Read the COMPUTED shadow rather than
      // screenshotting: a ring paints OUTSIDE the border box, so a capture
      // scoped to the trigger clips exactly the thing being shown (#1873).
      const ring = await wrapper.evaluate((el) => getComputedStyle(el).boxShadow)
      expect(ring, 'brand focus ring on the newly focusable trigger').not.toBe('none')
    })
  }
})
