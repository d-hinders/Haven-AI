/**
 * The Analytics header's controls wrap instead of pushing the page sideways
 * (#4401, epic #4330).
 *
 * WHAT WAS BROKEN. `AnalyticsClient` handed `PageHeader` its Agent facet and
 * Period picker inside its own non-wrapping `flex` wrapper, so the pair was ONE
 * unbreakable child of the header's wrapping actions row. Filtered to an agent
 * at 390 the page rendered 420 CSS px wide and scrolled sideways; unfiltered,
 * the picker still ran past the card column. From `sm` up the actions row is
 * `flex-shrink-0` at max-content, so a long selected name could push the
 * header wide there too.
 *
 * WHY GEOMETRY. The overflow is a layout property; `expectNoHorizontalOverflow`
 * (#1771) measures `#main-content` as well as the document, because inside the
 * authenticated shell a document-only check cannot fail. The header's own box
 * is measured beside it, so a header that overflows into a clipped region is
 * still red.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
} from './fixtures/haven-api'
import { analyticsOverview } from './fixtures/analytics-overview'

const LONG_NAME = 'Quarterly procurement research agent for the Nordic region'
const OVERVIEW_PATH = '/analytics/overview'

/**
 * Two agents (one option alone hides the facet), the first with a long name,
 * and the populated overview for any range or agent filter. Registered after
 * `mockHavenApi`, so it wins these two paths alone.
 */
async function serveAnalytics(page: Page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/agents') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            { id: 'agent-research', name: LONG_NAME, status: 'active' },
            { id: 'agent-retired', name: 'Data-feed agent', status: 'paused' },
          ],
        }),
      })
      return
    }
    if (request.method() === 'GET' && path === OVERVIEW_PATH) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(analyticsOverview) })
      return
    }
    await route.fallback()
  })
}

/** The header, its actions row and the two controls, in viewport px. */
async function measureHeader(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('[data-testid="analytics-page"] header') as HTMLElement | null
    const facet = Array.from(document.querySelectorAll('header button')).find((b) =>
      (b.textContent ?? '').startsWith('Agent:'),
    ) as HTMLElement | undefined
    const period = Array.from(document.querySelectorAll('header button')).find((b) =>
      (b.textContent ?? '').startsWith('Period:'),
    ) as HTMLElement | undefined
    if (!header || !facet || !period) return null
    const box = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width) }
    }
    const summary = facet.querySelector('span.truncate') as HTMLElement | null
    return {
      header: box(header),
      headerOverflowBy: header.scrollWidth - header.clientWidth,
      facet: box(facet),
      period: box(period),
      summaryTruncated: summary ? summary.scrollWidth > summary.clientWidth + 1 : null,
    }
  })
}

async function open(page: Page, width: number, query: string) {
  await mockHavenApi(page)
  await serveAnalytics(page)
  await seedAuthenticatedSession(page)
  await page.setViewportSize({ width, height: 844 })
  await page.goto(`/analytics${query}`)
  await expect(page.getByRole('heading', { name: 'Analytics', exact: true })).toBeVisible({ timeout: 60_000 })
  await dismissMobileSidebar(page)
  // Non-vacuity: both controls rendered, and the filter landed when asked.
  const facetName = query === '' ? 'Agent: All agents' : `Agent: ${LONG_NAME}`
  await expect(page.getByRole('button', { name: facetName })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Period:/ })).toBeVisible()
}

test.describe('Analytics header controls (#4401)', () => {
  for (const query of ['', '?agentId=agent-research']) {
    test(`at 390 the header wraps its controls without overflow (${query || 'unfiltered'})`, async ({ page }) => {
      await open(page, 390, query)
      const m = await measureHeader(page)
      expect(m, 'header and both controls rendered').not.toBeNull()
      // Inside the header's own box, and the header itself does not scroll.
      expect(m!.facet.right).toBeLessThanOrEqual(m!.header.right)
      expect(m!.period.right).toBeLessThanOrEqual(m!.header.right)
      expect(m!.headerOverflowBy).toBeLessThanOrEqual(1)
      if (query !== '') {
        // The long name fills the row and truncates, so Period wraps under it.
        expect(m!.period.top).toBeGreaterThan(m!.facet.top)
        expect(m!.summaryTruncated).toBe(true)
      }
      expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
    })
  }

  test('at sm (640) a very long agent name truncates and does not push the header', async ({ page }) => {
    await open(page, 640, '?agentId=agent-research')
    const m = await measureHeader(page)
    expect(m, 'header and both controls rendered').not.toBeNull()
    // FacetMenu's `sm:max-w-[20rem]` bound.
    expect(m!.facet.width).toBeLessThanOrEqual(320)
    expect(m!.summaryTruncated).toBe(true)
    expect(m!.period.right).toBeLessThanOrEqual(m!.header.right)
    expect(m!.headerOverflowBy).toBeLessThanOrEqual(1)
    expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
  })
})
