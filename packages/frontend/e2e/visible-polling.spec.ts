import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'
import type { Page, Route } from '@playwright/test'

/**
 * #2732 — visible-only polling on the demo screens.
 *
 * The demo payoff: a payment executed elsewhere appears on /dashboard with NO
 * user action, within one poll interval. These specs drive the REAL page with
 * a mutable API mock: the /dashboard/overview handler starts with one body and
 * is flipped to another ONLY after the initial mount has fully settled (dev
 * runs React StrictMode, whose double-mount makes "first read vs later reads"
 * gating flaky — flip-on-demand after a quiet poll cycle instead).
 *
 * The poll cadence is the production 10s (`VISIBLE_POLL_INTERVAL_MS`), so the
 * waits here budget a full cycle plus margin rather than racing the tick.
 *
 * #3810: the dashboard stopped reading `overview.transactions` (removed from
 * the wire by #3858) — the rows are
 * #3824's grouped activity (`overview.activity`), and a row's identity is its
 * MERCHANT title: the x402 resource's hostname, via `counterpartyLabel`'s
 * no-address mode (the dashboard never renders a truncated address). The
 * specs locate the arriving payment by that hostname, which also keeps the
 * no-address guarantee honest: a raw or truncated address leaking into the
 * row could never satisfy these locators.
 */

const POLL_CYCLE_MS = 11_000

/**
 * The `to` address behind the mocked group. Never rendered — the dashboard's
 * no-address mode means the row is titled by the x402 hostname — but kept
 * real-looking so the wire body stays honest.
 */
const MERCHANT_TO = '0x9999999999999999999999999999999999999999'

/**
 * One #3824 activity group whose newest member is a confirmed x402 payment
 * toward `merchantUrl`. `latestAt` is a minute ago so the group buckets under
 * "Today" and `timeAgo` renders a real relative label.
 */
function activityGroup(merchantUrl: string) {
  return {
    count: 1,
    sumAtomic: '2500000',
    tokenSymbol: 'USDC',
    decimals: 6,
    latestAt: new Date(Date.now() - 60_000).toISOString(),
    agentId: null,
    agentName: 'Scout',
    source: 'x402',
    x402ResourceUrl: merchantUrl,
    to: MERCHANT_TO,
    merchantName: null,
    activityType: null,
    direction: 'out' as const,
    status: 'confirmed' as const,
    approxAmount: '25.0000',
    approxCurrency: 'SEK' as const,
  }
}

/**
 * The arriving payment row: a link whose accessible name carries the merchant
 * hostname (the grouped row's TITLE — the x402 resource's host).
 */
function arrivingPayment(page: Page, merchantUrl: string) {
  const hostname = new URL(merchantUrl).hostname
  return page.getByRole('link', { name: new RegExp(hostname.split('.').join('\\.')) })
}

/**
 * A complete overview shape per the CURRENT wire — everything the dashboard
 * dereferences, with the grouped-activity list set explicitly. The dashboard
 * reads `overview.activity` (not the retired `transactions` preview), so an
 * empty feed is `activity: []`, not a `transactions: []` body.
 */
function overviewBody(
  activity: ReturnType<typeof activityGroup>[],
  metrics: {
    connectedAgents: number
    monthlyAgentSpendUsd: number
    monthlyAgentSpendEur: number
    successfulTransactions: number
    activeAccounts: number
  } = {
    connectedAgents: 0,
    monthlyAgentSpendUsd: 0,
    monthlyAgentSpendEur: 0,
    successfulTransactions: 0,
    activeAccounts: 1,
  },
) {
  return {
    totals: { usd: 1250, eur: 1138 },
    change: { available: false, usdAmount: 0, eurAmount: 0, usdPercent: 0, eurPercent: 0 },
    metrics,
    actionableApprovals: 0,
    pendingApprovals: 0,
    onboardingProgress: { hasFirstAgentPayment: true },
    agents: [],
    activity,
  }
}

test.describe('visible-only polling on /dashboard (#2732)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('a payment executed elsewhere appears with no user action within one interval', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    let overviewReads = 0
    let flip = false
    const MERCHANT_URL = 'https://merchant.example/data'
    await page.route('**/api/dashboard/overview**', async (route: Route) => {
      overviewReads += 1
      const body = flip
        ? {
            ...overviewBody([activityGroup(MERCHANT_URL)]),
            metrics: { ...overviewBody([]).metrics, successfulTransactions: 1 },
          }
        : overviewBody([])
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })

    await page.goto('/dashboard')
    // The empty overview renders the activity section's empty state; that is
    // the "page is up and the feed is empty" anchor (no region landmark
    // exists on this state).
    await expect(page.getByText('No activity yet')).toBeVisible()

    // Let one full silent poll cycle pass on the EMPTY state, then prove the
    // purchase still has not appeared without the flip.
    await page.waitForTimeout(POLL_CYCLE_MS)
    await expect(arrivingPayment(page, MERCHANT_URL)).toHaveCount(0)

    // The agent "buys" — the mocked overview starts returning the payment —
    // and the page must pick it up WITHOUT any user action. No click, no
    // reload, no scroll: only the polling hook's own cadence.
    const readsAtFlip = overviewReads
    flip = true
    await expect
      .poll(async () => overviewReads, { timeout: 20_000 })
      .toBeGreaterThan(readsAtFlip)
    await expect(arrivingPayment(page, MERCHANT_URL)).toBeVisible({ timeout: 15_000 })

    // No skeleton flip accompanies the arrival (the silent path).
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  test('a failed silent tick changes no visible state: the loaded rows survive', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    let failAll = false
    const MERCHANT_URL = 'https://supplier.example/api'
    await page.route('**/api/dashboard/overview**', async (route: Route) => {
      if (failAll) {
        // Every read after the flip: hard 500. A failed silent tick must
        // change NO visible state.
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"mid-demo 500"}' })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          overviewBody([activityGroup(MERCHANT_URL)], {
            connectedAgents: 0,
            monthlyAgentSpendUsd: 2.5,
            monthlyAgentSpendEur: 2.3,
            successfulTransactions: 1,
            activeAccounts: 1,
          }),
        ),
      })
    })

    await page.goto('/dashboard')
    await expect(arrivingPayment(page, MERCHANT_URL)).toBeVisible()
    const rowsBefore = await arrivingPayment(page, MERCHANT_URL).count()

    // Only NOW does the backend start failing — the initial mount (including
    // StrictMode's double mount) already succeeded.
    failAll = true

    // Wait through at least one failed tick cycle.
    await page.waitForTimeout(POLL_CYCLE_MS)
    await expect(arrivingPayment(page, MERCHANT_URL)).toBeVisible()
    expect(await arrivingPayment(page, MERCHANT_URL).count()).toBe(rowsBefore)
    // No global error surface replaced the data — the "Needs attention"
    // panel's overview-error row ("Dashboard data could not load") is the
    // visible state a failed tick must NOT introduce.
    await expect(page.getByText('Dashboard data could not load')).toHaveCount(0)
    expect(
      unexpectedBrowserErrors(browserErrors).filter(
        (error) => !/status of 500.*api\/dashboard\/overview/i.test(error),
      ),
    ).toEqual([])
  })

  test('silent ticks do not reset scroll position', async ({ page }) => {
    // A short viewport guarantees the page overflows vertically — the hero,
    // metrics grid and the two activity columns stack well past 700px — so
    // there is a real scroll to preserve. The mocked activity row is the
    // identity that must still be visible after the silent ticks.
    await page.setViewportSize({ width: 420, height: 700 })

    const MERCHANT_URL = 'https://shop.example/checkout'
    await page.route('**/api/dashboard/overview**', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overviewBody([activityGroup(MERCHANT_URL)])),
      })
    })

    await page.goto('/dashboard')
    await expect(arrivingPayment(page, MERCHANT_URL)).toBeVisible()

    // The dashboard may scroll an inner container rather than the window
    // (window.scrollY stayed 0 here in earlier runs). Find the element that
    // actually overflows, mark it, and scroll it.
    const scrolled = await page.evaluate(() => {
      const scrollable = (el: Element): boolean => {
        const oy = getComputedStyle(el).overflowY
        return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 10
      }
      const pool: (Element | null)[] = [document.scrollingElement, ...Array.from(document.querySelectorAll('*'))]
      const target = pool.find((el): el is Element => el !== null && scrollable(el))
      if (!target) return null
      target.setAttribute('data-e2e-scroller', '1')
      target.scrollTop = 400
      return target.scrollTop
    })
    expect(scrolled).not.toBeNull()
    expect(scrolled as number).toBeGreaterThan(0)
    const scrollBefore = await page.evaluate(
      () => document.querySelector('[data-e2e-scroller="1"]')?.scrollTop ?? -1,
    )

    await page.waitForTimeout(POLL_CYCLE_MS)
    expect(await page.evaluate(() => document.querySelector('[data-e2e-scroller="1"]')?.scrollTop ?? -1)).toBe(
      scrollBefore,
    )
    // The silent refetch did not swap the page for a skeleton either.
    await expect(arrivingPayment(page, MERCHANT_URL)).toBeVisible()
  })
})
