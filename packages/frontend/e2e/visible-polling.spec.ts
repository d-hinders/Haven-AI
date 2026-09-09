import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  mockHavenApi,
  seedAuthenticatedSession,
  testSafeAddress,
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
 */

const POLL_CYCLE_MS = 11_000

function paymentRow(merchant: string) {
  return {
    hash: `0x${'cd'.repeat(32)}`,
    type: 'erc20',
    from: testSafeAddress,
    to: merchant,
    value: '2500000',
    valueFormatted: '2.50',
    asset: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1_779_000_000,
    blockNumber: 12_346,
    isError: false,
    tokenAddress: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
    tokenSymbol: 'USDC',
    chainId: 8453,
    safeId: 'safe-main',
    safeAddress: testSafeAddress,
    safeName: 'Operations',
    source: 'x402',
  }
}

/** The UI truncates addresses (`0x9999…9999`); this regex matches truncated AND full forms. */
function merchantPrefix(merchant: string): string {
  return `${merchant.slice(0, 6)}.*${merchant.slice(-4)}`
}

function paymentLink(page: Page, merchant: string) {
  return page.getByRole('link', { name: new RegExp(merchantPrefix(merchant)) }).first()
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
    const MERCHANT = '0x9999999999999999999999999999999999999999'
    // The pre-flip body must be a COMPLETE overview shape (the dashboard
    // dereferences totals/metrics) — just with an empty transaction list.
    const emptyBody = {
      transactions: [],
      totals: { usd: 1250, eur: 1138 },
      change: { available: false, usdAmount: 0, eurAmount: 0, usdPercent: 0, eurPercent: 0 },
      metrics: {
        connectedAgents: 0,
        monthlyAgentSpendUsd: 0,
        monthlyAgentSpendEur: 0,
        successfulTransactions: 0,
        activeAccounts: 1,
      },
      actionableApprovals: 0,
      pendingApprovals: 0,
      onboardingProgress: { hasFirstAgentPayment: true },
      agents: [],
    }
    const paidBody = {
      ...emptyBody,
      transactions: [paymentRow(MERCHANT)],
      metrics: { ...emptyBody.metrics, successfulTransactions: 1 },
    }
    await page.route('**/api/dashboard/overview**', async (route: Route) => {
      overviewReads += 1
      const body = flip ? paidBody : emptyBody
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })

    await page.goto('/dashboard')
    // The empty overview renders the transactions panel's empty state; that
    // is the "page is up and the feed is empty" anchor (no region landmark
    // exists on this state).
    await expect(page.getByText('No transactions yet')).toBeVisible()

    // Let one full silent poll cycle pass on the EMPTY state, then prove the
    // purchase still has not appeared without the flip.
    await page.waitForTimeout(POLL_CYCLE_MS)
    await expect(paymentLink(page, MERCHANT)).toHaveCount(0)

    // The agent "buys" — the mocked overview starts returning the payment —
    // and the page must pick it up WITHOUT any user action. No click, no
    // reload, no scroll: only the polling hook's own cadence.
    const readsAtFlip = overviewReads
    flip = true
    await expect
      .poll(async () => overviewReads, { timeout: 20_000 })
      .toBeGreaterThan(readsAtFlip)
    await expect(paymentLink(page, MERCHANT)).toBeVisible({ timeout: 15_000 })

    // No skeleton flip accompanies the arrival (the silent path).
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  test('a failed silent tick changes no visible state: the loaded rows survive', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    let failAll = false
    const MERCHANT = '0x8888888888888888888888888888888888888888'
    const goodBody = {
      totals: { usd: 1250, eur: 1138 },
      change: { available: false, usdAmount: 0, eurAmount: 0, usdPercent: 0, eurPercent: 0 },
      metrics: {
        connectedAgents: 0,
        monthlyAgentSpendUsd: 2.5,
        monthlyAgentSpendEur: 2.3,
        successfulTransactions: 1,
        activeAccounts: 1,
      },
      actionableApprovals: 0,
      pendingApprovals: 0,
      onboardingProgress: { hasFirstAgentPayment: true },
      agents: [],
      transactions: [paymentRow(MERCHANT)],
    }
    await page.route('**/api/dashboard/overview**', async (route: Route) => {
      if (failAll) {
        // Every read after the flip: hard 500. A failed silent tick must
        // change NO visible state.
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"mid-demo 500"}' })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(goodBody) })
    })

    await page.goto('/dashboard')
    await expect(paymentLink(page, MERCHANT)).toBeVisible()
    const totalBefore = await paymentLink(page, MERCHANT).count()

    // Only NOW does the backend start failing — the initial mount (including
    // StrictMode's double mount) already succeeded.
    failAll = true

    // Wait through at least one failed tick cycle.
    await page.waitForTimeout(POLL_CYCLE_MS)
    await expect(paymentLink(page, MERCHANT)).toBeVisible()
    expect(await paymentLink(page, MERCHANT).count()).toBe(totalBefore)
    // No global error surface replaced the data. (The 500's own resource
    // console error is expected — we mocked it deliberately — so it does not
    // count as an unexpected browser error for this spec.)
    await expect(page.getByText(/failed to load dashboard/i)).toHaveCount(0)
    expect(
      unexpectedBrowserErrors(browserErrors).filter(
        (error) => !/status of 500.*api\/dashboard\/overview/i.test(error),
      ),
    ).toEqual([])
  })

  test('silent ticks do not reset scroll position', async ({ page }) => {
    // A short viewport guarantees the page overflows vertically with the
    // single mocked transaction, so there is a real scroll to preserve.
    await page.setViewportSize({ width: 420, height: 700 })

    const MERCHANT = '0x7777777777777777777777777777777777777777'
    await page.route('**/api/dashboard/overview**', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totals: { usd: 1250, eur: 1138 },
          change: { available: false, usdAmount: 0, eurAmount: 0, usdPercent: 0, eurPercent: 0 },
          metrics: {
            connectedAgents: 0,
            monthlyAgentSpendUsd: 0,
            monthlyAgentSpendEur: 0,
            successfulTransactions: 0,
            activeAccounts: 1,
          },
          actionableApprovals: 0,
          pendingApprovals: 0,
          onboardingProgress: { hasFirstAgentPayment: true },
          agents: [],
          transactions: [paymentRow(MERCHANT)],
        }),
      })
    })

    await page.goto('/dashboard')
    await expect(paymentLink(page, MERCHANT)).toBeVisible()

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
    await expect(paymentLink(page, MERCHANT)).toBeVisible()
  })
})
