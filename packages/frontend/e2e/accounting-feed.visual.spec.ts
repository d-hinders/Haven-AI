/**
 * Visual regression for `/accounting` in its four states (#2869, epic #2858):
 * the feed with its connection summary line, the **attention** state (a
 * dead grant plus exhausted rows — the summary, the inline explanation and
 * the sidebar dot; desktop AND mobile, since the stacked header is what the
 * design review measured), the production **Coming soon** state, and the
 * **self-hosted** not-available copy.
 *
 * The states are spreads off the shared e2e `accountingFeedStatus`
 * (`fixtures/haven-api.ts`), served per test by `serveAccountingFeedStatus`;
 * the screenshot harness carries the same three answers, and
 * `fixture-shape-parity` holds them together.
 *
 * Every test asserts its own distinguishing copy — and each OFF state
 * asserts, BY ROLE, that no connect or sync control is reachable — before
 * the capture, so a locator that drifts is a red test rather than a baseline
 * of the wrong thing. The self-hosted test also asserts the coming-soon
 * string is absent from the page: the two off states must never read alike.
 *
 * Baselines are Linux-rendered by the "Update visual baselines" dispatch;
 * none are hand-made here.
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  accountingFeedAttention,
  accountingFeedComingSoon,
  accountingFeedStatus,
  accountingFeedSelfHosted,
  dismissMobileSidebar,
  mockHavenApi,
  seedAuthenticatedSession,
  serveAccountingFeedStatus,
} from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: 'desktop' | 'mobile'; width: number; height: number }>

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 50,
  threshold: 0.02,
} as const

async function openAccounting(page: Page) {
  await page.goto('/accounting')
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('button[aria-label="User menu"]')).toHaveCount(1)
  await dismissMobileSidebar(page)
  const main = page.locator('main').first()
  await expect(main).toHaveCount(1)
  return main
}

/** No connect and no sync control is reachable — a disabled one would be too. */
async function expectNoFeedControls(main: ReturnType<Page['locator']>) {
  for (const name of ['Connect', 'Reconnect', 'Disconnect', 'Sync now', 'Check in Fortnox']) {
    await expect(main.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
}

test.describe('accounting feed page states', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('flag on — the connection summary line above the feed', async ({ page }) => {
    // `lastPushAt` renders as a relative time; served two minutes before now
    // so the baseline reads "2 minutes ago" on every run instead of ageing.
    await serveAccountingFeedStatus(page, {
      ...accountingFeedStatus,
      destination: { ...accountingFeedStatus.destination, lastPushAt: new Date(Date.now() - 2 * 60_000).toISOString() },
    })
    const main = await openAccounting(page)
    const summary = main.getByTestId('feed-summary')
    await expect(summary).toHaveCount(1)
    await expect(summary).toHaveAttribute('data-status', 'connected')
    await expect(summary.getByText(/Feeding Fortnox/)).toHaveCount(1)
    await expect(main.getByRole('heading', { name: 'Synced transactions' })).toHaveCount(1)
    await expect(main.getByTestId('feed-counts')).toHaveCount(1)
    await expect(main.getByRole('button', { name: 'Check in Fortnox', exact: true })).toHaveCount(1)
    // The connection itself is managed in Settings (#2868).
    await expect(main.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
    // The feed that is on earns the product subtitle (#2869 design review).
    await expect(main.getByText(/your accountant codes and confirms them/)).toHaveCount(1)
    await expect(main).toHaveScreenshot('accounting-feed-on-desktop.png', SNAPSHOT_OPTIONS)
  })

  for (const vp of VIEWPORTS) {
    test(`attention — sign-in expired and exhausted rows: the summary, the inline explanation, the dot (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await serveAccountingFeedStatus(page, accountingFeedAttention)
      const main = await openAccounting(page)
      const summary = main.getByTestId('feed-summary')
      await expect(summary).toHaveAttribute('data-status', 'needs_reauthorisation')
      await expect(summary.getByText('Sign-in expired', { exact: true })).toHaveCount(1)
      await expect(summary.getByText(/Your Fortnox sign-in has expired/)).toHaveCount(1)
      // The one action that resolves the state is the PRIMARY one.
      const fix = summary.getByRole('link', { name: 'Fix in Settings', exact: true })
      await expect(fix).toHaveCount(1)
      await expect(fix).toHaveClass(/bg-\[var\(--v2-brand\)\]/)
      // The exhausted count, with its explanation rendered — not in a `title`.
      await expect(main.getByTestId('feed-count-exhausted')).toHaveText('3')
      await expect(main.getByTestId('feed-counts-exhausted-help')).toHaveCount(1)
      await expect(main.getByTestId('feed-counts').locator('[title]')).toHaveCount(0)
      await expect(main.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
      if (vp.name === 'desktop') {
        // The sidebar reads the same answer: the entry carries its dot.
        await expect(page.getByTestId('nav-attention-accounting')).toHaveCount(1)
      }
      await expect(main).toHaveScreenshot(`accounting-feed-attention-${vp.name}.png`, SNAPSHOT_OPTIONS)
    })
  }

  test('hosted, flag off — the Coming soon state, no connect or sync control', async ({ page }) => {
    await serveAccountingFeedStatus(page, accountingFeedComingSoon)
    const main = await openAccounting(page)
    await expect(main.getByTestId('accounting-coming-soon')).toHaveCount(1)
    await expect(main.getByRole('heading', { name: 'Accounting feed', exact: true })).toHaveCount(1)
    await expect(main.getByText('Coming soon', { exact: true })).toHaveCount(1)
    await expect(main.getByText('Nothing can be connected yet.', { exact: true })).toHaveCount(1)
    // The neutral header line — nothing above "Nothing can be connected yet." asserts that something happens.
    await expect(main.getByText('Accounting tool connections for agent spend.', { exact: true })).toHaveCount(1)
    await expect(main.getByText(/your accountant codes and confirms them/)).toHaveCount(0)
    await expectNoFeedControls(main)
    await expect(main).toHaveScreenshot('accounting-feed-coming-soon-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('self-hosted — not available here, and never coming soon', async ({ page }) => {
    await serveAccountingFeedStatus(page, accountingFeedSelfHosted)
    const main = await openAccounting(page)
    await expect(main.getByTestId('accounting-self-hosted')).toHaveCount(1)
    await expect(main.getByText('Not available on self-hosted', { exact: true })).toHaveCount(1)
    // The load-bearing negative: the two off states must not read alike.
    await expect(main.getByText('Coming soon', { exact: false })).toHaveCount(0)
    await expect(main.getByTestId('accounting-coming-soon')).toHaveCount(0)
    await expect(main.getByText(/your accountant codes and confirms them/)).toHaveCount(0)
    await expectNoFeedControls(main)
    await expect(main).toHaveScreenshot('accounting-feed-self-hosted-desktop.png', SNAPSHOT_OPTIONS)
  })
})
