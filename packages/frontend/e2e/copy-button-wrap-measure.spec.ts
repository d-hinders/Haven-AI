/**
 * #4561: the labelled `CopyButton`'s copied state must WRAP at phone width.
 *
 * WHAT THIS GUARDS. `Button` gained `whitespace-nowrap` as its default, because
 * a label that breaks mid-phrase is a layout bug — "Set budget" split onto two
 * lines inside a 98px button at 1288px. The one deliberate exception is
 * `CopyButton`'s `copiedText` ("Copied — paste it to <agent>"), whose contract
 * is that wrapping beats truncating: the agent name is dynamic, so the label's
 * width is not knowable at build time.
 *
 * WHY A MEASURE SPEC AND NOT A SNAPSHOT. The property is geometric — the label
 * breaks inside the button, the button stays inside its card, and the page does
 * not scroll sideways. A pixel baseline would capture the copied state for one
 * agent name and one moment (the confirmation lasts 1.5s), and the pixel budget
 * would absorb a 1px overflow. These assertions read the geometry itself, the
 * pattern `offers-table-alignment-measure.spec.ts` set.
 *
 * The unit test (`packages/ui/src/__tests__/CopyButton.test.tsx`) pins the
 * classes; this pins what they do in a real layout engine. jsdom performs no
 * layout, so it cannot answer any of the four questions below.
 *
 * FIXTURE. The shared merchant fixture's agent is on Base and holds an open
 * budget, so it can pay the Base-priced Quote offer and no other — which is
 * exactly the condition that renders `copiedText` (#4005: one capable agent).
 * Quote sits behind the phone list's "1 more on Base" disclosure, so the spec
 * opens it. The agent's NAME is overridden to something long enough that the
 * confirmation cannot fit on one line at 375px; everything else about it is the
 * shared fixture, so the capability answer is unchanged.
 */
import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, serveAddFundsAccount, testAgent } from './fixtures/haven-api'
import { ampersendDemoApi } from './fixtures/marketplace'

const PHONE = { width: 375, height: 812 }
const LONG_AGENT_NAME = 'Reconciliation and treasury operations agent'
const COPIED_PREFIX = 'Copied — paste it to '

type Reading = {
  whiteSpace: string
  label: string
  height: number
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
  buttonRight: number
  containerRight: number
  docScrollWidth: number
  docClientWidth: number
}

test.describe('CopyButton copied state at 375px (#4561)', () => {
  test('a long agent name wraps inside the button, with no clipping and no horizontal overflow', async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    await serveAddFundsAccount(page, 84532)
    // Registered AFTER `mockHavenApi`, so it runs first (Playwright routes are
    // LIFO) and falls back for every other request.
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname.replace(/^\/api/, '')
      if (request.method() === 'GET' && path === '/agents') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ agents: [{ ...testAgent, name: LONG_AGENT_NAME }] }),
        })
        return
      }
      await route.fallback()
    })
    // The confirmation only appears when the clipboard write SUCCEEDS; without
    // the grant the component takes its `onCopyFailed` branch and reveals the
    // instruction instead.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.setViewportSize(PHONE)
    await page.goto(`/marketplace/${ampersendDemoApi.slug}`)
    // Hydration, not just paint: the copy handler is a React `onClick`, and a
    // click that lands before hydration is a no-op that looks like a broken
    // component.
    await page.waitForLoadState('networkidle')

    const list = page.getByTestId('offers-list')
    await list.getByTestId('other-networks').locator('summary').click()

    const card = page.getByTestId('offer-card-offer-ampersend-quote')
    // Case-INSENSITIVE on purpose: the accessible name is "Copy prompt for
    // Quote" before the copy and "Prompt for Quote copied" during the 1.5s
    // confirmation. A locator that matches only the pre-copy name silently
    // waits out the confirmation and reads the reverted label — which is how
    // this spec first "failed" against a component that was working.
    const button = card.getByRole('button', { name: /prompt for quote/i })
    await button.click()
    await expect(button).toContainText(COPIED_PREFIX)

    const reading = await button.evaluate<Reading>((el) => {
      const b = el as HTMLElement
      const container = b.closest('[data-testid^="offer-card-"]') as HTMLElement
      const box = b.getBoundingClientRect()
      return {
        whiteSpace: getComputedStyle(b).whiteSpace,
        label: b.textContent ?? '',
        height: box.height,
        scrollWidth: b.scrollWidth,
        clientWidth: b.clientWidth,
        scrollHeight: b.scrollHeight,
        clientHeight: b.clientHeight,
        buttonRight: box.right,
        containerRight: container.getBoundingClientRect().right,
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
      }
    })

    // The wrap opt-out is in effect, and the label is the long one — otherwise
    // the rest of this test would be measuring a short label that never needed
    // to wrap.
    expect(reading.whiteSpace, 'the copied state must opt out of whitespace-nowrap').toBe('normal')
    expect(reading.label).toContain(`${COPIED_PREFIX}${LONG_AGENT_NAME}`)

    // It actually wrapped: the `sm` button paints 36px on one line, and the
    // wrapping form's `min-h-9` lets it grow instead of clipping.
    expect(reading.height, 'the confirmation should occupy more than one line at 375px').toBeGreaterThan(36)

    // No clipping, in either axis: the content box fits the button's own box.
    expect(reading.scrollWidth, 'the label is clipped horizontally').toBeLessThanOrEqual(reading.clientWidth + 1)
    expect(reading.scrollHeight, 'the label is clipped vertically').toBeLessThanOrEqual(reading.clientHeight + 1)

    // Inside its card, and the page does not scroll sideways.
    expect(reading.buttonRight, 'the button runs past its card').toBeLessThanOrEqual(reading.containerRight + 1)
    expect(reading.docScrollWidth, 'the page scrolls horizontally').toBeLessThanOrEqual(reading.docClientWidth + 1)
  })
})
