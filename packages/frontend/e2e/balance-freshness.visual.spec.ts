/**
 * Visual regression for the degraded-balance render (#3295): a failed
 * on-chain balance read showing the LAST-KNOWN balance with its stale
 * marker, never a zero.
 *
 * Before this file the degraded state had no pixel baseline at all — the
 * shared e2e fixture answers every balance/portfolio read clean, so the
 * visual gate only ever photographed the healthy render. The incident this
 * issue came from (#2769) was a screen full of `0,00 kr` that read as fact.
 *
 * The session here is the shared fixture user with ONE overlay: every
 * balance-bearing read answers a degraded shape (registered AFTER
 * `mockHavenApi`, later routes win). Each test asserts the state's own
 * distinguishing copy BEFORE the capture — the stale indicator's literal
 * `as of …` line, frozen with the page clock — so a locator that drifts is
 * a red test rather than a baseline of the wrong thing. The as-of literal
 * is frozen exactly like the SEK suite's `3mo ago`: an unfrozen `timeAgo`
 * here would drift on a calendar boundary like the ones #2318 rejected.
 *
 * The scenario is PURE STALE (both tokens have a last-known value; the ETH
 * read failed, the USDC read is fresh). The `unavailable` render (no value
 * ever read) is pinned by the rendered-screen unit tests
 * (`DashboardClient.degraded.test.tsx` and siblings) — this file adds the
 * pixel evidence the issue's AC 5 asks for, at one state per surface.
 *
 * Baselines are Linux-rendered by the "Update visual baselines" dispatch;
 * none are hand-made here. Desktop only, deliberately — every committed
 * baseline is re-blessed forever (#1944).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  dashboardOverview,
  mockHavenApi,
  seedAuthenticatedSession,
} from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: 'desktop' | 'mobile'; width: number; height: number }>
const DESKTOP = VIEWPORTS.find((vp) => vp.name === 'desktop')

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 50,
  threshold: 0.02,
} as const

/** The same frozen clock `currency-preference.visual.spec.ts` uses. */
const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')

/**
 * When the failed token's last good read happened. 45 minutes before the
 * frozen clock, so `timeAgo` renders the stable literal `45m ago` — deep in
 * the minutes bucket, nowhere near a bucket boundary.
 */
const STALE_AS_OF = '2026-09-01T11:15:00.000Z'

/**
 * The capture would bake a mid-load frame into the baseline and then match it
 * forever. Same guard `currency-preference.visual.spec.ts` runs.
 */
async function expectNoSkeletons(region: Locator, label: string) {
  await expect(
    region.locator('.animate-pulse'),
    `${label}: still rendering skeleton placeholders — the capture would bake in ` +
      `a mid-load frame and then match it forever`,
  ).toHaveCount(0)
}

async function settleFonts(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForLoadState('networkidle')
}

/**
 * The degraded shape, as one overlay off the shared fixture (#3295).
 *
 * The story the numbers tell: USDC's read is FRESH at 1,250 (no marker);
 * ETH's read failed and the backend served its last-known 25 with the stale
 * marker. Totals therefore include the stale leg (1,275 USD), and the
 * dashboard's combined `change.balancesFreshness` is stale with that as-of —
 * what `combineBalanceFreshness` on the backend would answer. The change
 * stays AVAILABLE (every token has a known value), so the hero shows a real
 * change line computed from the substituted totals, not the unavailable
 * caption.
 */
async function serveDegradedBalances(page: Page) {
  const staleMarker = { status: 'stale', asOf: STALE_AS_OF } as const
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() !== 'GET') return route.fallback()

    if (path === '/dashboard/overview') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...dashboardOverview,
          totals: { usd: 1275, eur: 1162, sek: 13718 },
          change: {
            available: true,
            usdAmount: 12.34,
            eurAmount: 11.34,
            usdPercent: 0.98,
            eurPercent: 0.98,
            sekAmount: 132,
            sekPercent: 0.97,
            balancesFreshness: staleMarker,
          },
        }),
      })
      return
    }

    if (path.startsWith('/portfolio/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalUsd: 1275,
          totalEur: 1162,
          totalSek: 13718,
          breakdown: [
            {
              symbol: 'USDC',
              balance: '1250000000',
              formatted: '1250',
              usdValue: 1250,
              eurValue: 1138,
              sekValue: 13450,
            },
            {
              symbol: 'ETH',
              balance: '25000000000000000000',
              formatted: '25',
              usdValue: 25,
              eurValue: 24,
              sekValue: 268,
              balanceFreshness: staleMarker,
            },
          ],
        }),
      })
      return
    }

    if (path.startsWith('/balances/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          balances: [
            {
              symbol: 'USDC',
              address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
              balance: '1250000000',
              formatted: '1250',
              decimals: 6,
            },
            {
              symbol: 'ETH',
              address: '0x0000000000000000000000000000000000000000',
              balance: '25000000000000000000',
              formatted: '25',
              decimals: 18,
              balanceFreshness: staleMarker,
            },
          ],
        }),
      })
      return
    }

    await route.fallback()
  })
}

test.describe('degraded balance renders the last-known value with its stale marker (#3295)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  test.beforeEach(async ({ page }) => {
    if (!DESKTOP) {
      throw new Error('visual gate: evidence-viewports.mjs carries no "desktop" viewport')
    }
    await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height })
    // BEFORE `goto`: the page reads `Date.now()` during its first render.
    await page.clock.setFixedTime(FROZEN_NOW)
    await mockHavenApi(page)
    await serveDegradedBalances(page)
    await seedAuthenticatedSession(page)
  })

  test('/dashboard — the hero total with the stale indicator beside it', async ({ page }) => {
    await page.goto('/dashboard')
    const main = page.locator('#main-content')
    await expect(main).toHaveCount(1)
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible({ timeout: 60_000 })

    // The hero total is fresh-USDC + last-known-ETH — NOT the 1,250 a
    // zero-on-failure backend would have served, and never 0.
    await expect(main.getByText('$1,275.00')).toHaveCount(1)
    // The stale indicator: the frozen-clock literal, exactly once (the hero).
    await expect(main.getByText('as of 45m ago')).toHaveCount(1)
    // Every token has a known value, so the change stays a real line computed
    // from the substituted totals — not the unavailable caption.
    await expect(main.getByText('+$12.34 (+0.98%) today')).toHaveCount(1)

    await expectNoSkeletons(main, '/dashboard (degraded)')
    await settleFonts(page)
    await expect(page).toHaveScreenshot('balance-freshness-dashboard-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('/accounts — the overview card carries the stale indicator, not a silent total', async ({ page }) => {
    await page.goto('/accounts')
    const main = page.locator('#main-content')
    await expect(main).toHaveCount(1)
    await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible({ timeout: 60_000 })

    // The card total includes the stale leg and names its age.
    await expect(main.getByText('$1,275.00')).toHaveCount(1)
    await expect(main.getByText('as of 45m ago')).toHaveCount(1)

    await expectNoSkeletons(main, '/accounts (degraded)')
    await settleFonts(page)
    await expect(page).toHaveScreenshot('balance-freshness-accounts-overview-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('/accounts/safe-main — the headline and the failed token row each carry it', async ({ page }) => {
    await page.goto('/accounts/safe-main')
    const main = page.locator('#main-content')
    await expect(main).toHaveCount(1)
    await expect(page.getByRole('heading', { name: 'Operations', exact: true })).toBeVisible({ timeout: 60_000 })

    // Headline includes the stale leg…
    await expect(main.getByText('$1,275.00')).toHaveCount(1)
    // …and the stale literal appears TWICE: once beside the headline, once
    // on the ETH row whose read failed. The fresh USDC row carries none.
    await expect(main.getByText('as of 45m ago')).toHaveCount(2)

    await expectNoSkeletons(main, '/accounts/[id] (degraded)')
    await settleFonts(page)
    await expect(page).toHaveScreenshot('balance-freshness-account-detail-desktop.png', SNAPSHOT_OPTIONS)
  })
})
