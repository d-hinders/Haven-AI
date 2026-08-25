/**
 * `Tooltip` on a real touch device (#2038, defect 1's touch half).
 *
 * ## Why a browser and not jsdom
 *
 * "Can a touch user reach this" is a hit-test question on a coarse pointer.
 * `chromium-mobile` is Pixel 5 device emulation — real touch points, coarse
 * pointer, not a viewport override on a desktop browser (#1768) — so
 * `page.tap()` dispatches a genuine touch sequence only here. jsdom proves the
 * handler is wired (`src/components/ui/__tests__/Tooltip.test.tsx`); this
 * proves a finger reaches it.
 *
 * And no screenshot could stand in for either: a tooltip that is not open is
 * in no capture, which is exactly why both of #2038's defects survived a
 * blocking pixel gate and a rendered design review.
 *
 * ## Two call sites, because the primitive deliberately behaves differently
 *
 * `Tooltip` takes the tap ONLY where the trigger is nobody else's control.
 *
 * - `/design-system` renders `Address` and `WalletIdentityBlock` triggers as
 *   bare text in ordinary containers — standalone, so a tap must open them.
 *   These are the triggers that were mouse-only before this change.
 * - `/agents` renders `McpServerName` inside `AgentCard`, which is a card-wide
 *   composite `role="link"` with its own `onClick`. A tap there navigates, and
 *   a toggle would fire alongside it and leave a bubble over the next page.
 *   So the primitive must NOT take that tap — asserted here as a real
 *   behaviour, not left as an intention in a comment.
 *
 * The second test is the one that would go red if the ancestry rule were
 * dropped for a simpler "always toggle", which is the tempting version.
 */
import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

/** `/design-system`'s sample address, and its `truncate()` display form. */
const SAMPLE_ADDRESS = '0x8f4F0f6d712C5c5C9Bb02F4a5B5c0D7F462A6f4C'
const SAMPLE_TRUNCATED = '0x8f4F…6f4C'

/** The live long label, from `McpServerName`'s null branch. */
const LONG_LABEL =
  'Haven records this when an agent connects with a current version of the connector. Agents connected earlier keep working exactly as they are — only the label is missing.'

test.describe('Tooltip on touch (#2038)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('a tap opens a standalone trigger, and a second tap dismisses it', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/design-system')
    await dismissMobileSidebar(page)

    const trigger = page.getByText(SAMPLE_TRUNCATED).first()
    await expect(trigger).toBeVisible()
    // Nothing has been hovered or tapped, so a bubble already on screen would
    // make the assertion below pass without the tap doing anything.
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0)

    await trigger.tap()
    await expect(page.locator('[role="tooltip"]')).toHaveText(SAMPLE_ADDRESS)

    await trigger.tap()
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0)

    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  test('a tap inside a composite card link is left to the card, not stolen', async ({ page }) => {
    await page.goto('/agents')
    await dismissMobileSidebar(page)

    const trigger = page.getByText('not recorded').first()
    await expect(trigger).toBeVisible()

    // The rule is observable before the tap, which matters: "no tooltip
    // appeared" alone would also be true of a page that simply navigated away
    // first. The wrapper carrying no `tabindex` is the ancestry rule itself,
    // and it is what goes red if the primitive were simplified to always take
    // the tap.
    const wrapper = trigger.locator('xpath=ancestor::span[1]')
    await expect(wrapper).toHaveCount(1)
    await expect(wrapper).not.toHaveAttribute('tabindex', '0')

    // The card owns this tap: it navigates. The tooltip must not open on the
    // way out, or a user arrives at the detail page with a bubble over it and
    // no way to have asked for it. (The navigation itself is `AgentCard`'s
    // own claim and is covered by `hosted-mcp.spec.ts`; asserting it here
    // would only add a route compile to this test's critical path.)
    await trigger.tap()
    // Scoped to THIS label rather than to `[role="tooltip"]` at large: the tap
    // navigates, and the emulated pointer lands wherever the next page puts
    // it, so a bare role count can be reddened by a tooltip belonging to the
    // destination screen.
    await expect(page.locator('[role="tooltip"]', { hasText: LONG_LABEL })).toHaveCount(0)
  })
})
