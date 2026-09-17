/**
 * Visual regression for `/marketplace` and `/marketplace/<slug>` (#3079,
 * epic #3077).
 *
 * Four scenarios, each a distinct branch the merchant layer added:
 *
 *   - `marketplace-grid`      — the grid with three merchants (live/verified,
 *     test, coming-soon), at desktop and mobile.
 *   - `merchant-page`         — a live merchant (Ampersend Demo API) with
 *     three offers, the "Pay this with Haven" block and the offers table, at
 *     desktop and mobile.
 *   - `merchant-coming-soon`  — a `coming_soon` merchant page (desktop only):
 *     no instruction block, no price, no offers table.
 *   - `merchant-test-merchant`— a live `is_test_merchant` merchant page
 *     (desktop only), so the grid's "Haven test merchant" label has a card to
 *     render it on.
 *
 * Same discipline as `analytics.visual.spec.ts`: the desktop shots of all
 * four ALSO run under `chromium-desktop-dark` (`<name>-dark.png`), no mobile
 * dark project exists, and every capture is preceded by a structural
 * assertion that runs under `VISUAL_STRUCTURE_ONLY=1` even when pixels are
 * not compared.
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
import { ampersendDemoApi, bergetAi, havenDemoStore } from './fixtures/marketplace'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the #1738 un-clip and the #1936 non-blank proof.
import { assertCaptureNotBlank, unclipScrollShell } from '../scripts/full-page-capture.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .ts constant with no default export shape to widen.
import { THEME_STORAGE_KEY } from '../src/lib/theme-bootstrap'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: string; width: number; height: number }>
const DESKTOP_ONLY = VIEWPORTS.filter((vp) => vp.name === 'desktop')

const PIXEL_THRESHOLD = 0.02
const FULL_PAGE_MAX_DIFF_PIXELS = 150
const ANCHOR_TIMEOUT_MS = 60_000

type Scenario = {
  name: 'marketplace-grid' | 'merchant-page' | 'merchant-coming-soon' | 'merchant-test-merchant'
  path: string
  viewports: ReadonlyArray<{ name: string; width: number; height: number }>
  heading: string
  assert: (page: Page) => Promise<void>
}

const SCENARIOS: Scenario[] = [
  {
    name: 'marketplace-grid',
    path: '/marketplace',
    viewports: VIEWPORTS,
    heading: 'Marketplace',
    async assert(page) {
      const grid = page.getByTestId('marketplace-page')
      await expect(grid.getByTestId(`merchant-card-${ampersendDemoApi.slug}`)).toHaveCount(1)
      await expect(grid.getByTestId(`merchant-card-${havenDemoStore.slug}`)).toHaveCount(1)
      await expect(grid.getByText(ampersendDemoApi.name)).toHaveCount(1)
      await expect(grid.getByText('3 offers')).toHaveCount(1)
      await expect(
        grid.getByText('Haven test merchant — real payments, demo goods'),
      ).toHaveCount(1)
      // "Show test merchants" defaults ON: the grid lists both chains
      // (decision 11) and one of them is Sepolia, so the test merchant card
      // is visible without any interaction.
      await expect(page.getByLabel('Show test merchants')).toBeChecked()
    },
  },
  {
    name: 'merchant-page',
    path: `/marketplace/${ampersendDemoApi.slug}`,
    viewports: VIEWPORTS,
    heading: ampersendDemoApi.name,
    async assert(page) {
      const merchantPage = page.getByTestId('merchant-page')
      await expect(merchantPage.getByRole('heading', { name: 'Pay this with Haven' })).toHaveCount(1)
      await expect(merchantPage.getByRole('heading', { name: 'Offers' })).toHaveCount(1)
      // `exact` — a substring match also hits the merchant description ("Fact,
      // joke and quote endpoints") and each offer's own description.
      // Each offer is on screen twice by design: its table row and its
      // labelled instruction block — one of each, located by id.
      for (const id of ['offer-ampersend-fact', 'offer-ampersend-joke', 'offer-ampersend-quote']) {
        await expect(merchantPage.getByTestId(`offer-row-${id}`)).toHaveCount(1)
        await expect(merchantPage.getByTestId(`pay-block-${id}`)).toHaveCount(1)
      }
      await expect(merchantPage.getByText('Fact', { exact: true })).toHaveCount(2)
      // The network column shows the chain's NAME, never the raw CAIP-2 id.
      await expect(merchantPage.getByText('eip155:')).toHaveCount(0)
      // None of the three offers advertises erc7710 (asset_transfer_methods:
      // null in the fixture), so the merchant-level unpinned-budget line is
      // present — ONCE, not once per offer — and no offer is tagged.
      await expect(
        merchantPage.getByText(
          'This merchant settles by EIP-3009 — the paying agent needs an unpinned budget.',
          { exact: true },
        ),
      ).toHaveCount(1)
      await expect(merchantPage.getByText('unpinned budget', { exact: true })).toHaveCount(0)
      await expect(merchantPage.getByLabel(/Copy agent instruction/)).toHaveCount(3)
    },
  },
  {
    name: 'merchant-coming-soon',
    path: `/marketplace/${bergetAi.slug}`,
    viewports: DESKTOP_ONLY,
    heading: bergetAi.name,
    async assert(page) {
      const merchantPage = page.getByTestId('merchant-page')
      await expect(
        merchantPage.getByRole('heading', { name: 'Coming soon — not payable yet' }),
      ).toHaveCount(1)
      await expect(merchantPage.getByRole('heading', { name: 'Pay this with Haven' })).toHaveCount(0)
      await expect(merchantPage.getByRole('heading', { name: 'Offers' })).toHaveCount(0)
      await expect(merchantPage.getByLabel(/Copy agent instruction/)).toHaveCount(0)
    },
  },
  {
    name: 'merchant-test-merchant',
    path: `/marketplace/${havenDemoStore.slug}`,
    viewports: DESKTOP_ONLY,
    heading: havenDemoStore.name,
    async assert(page) {
      const merchantPage = page.getByTestId('merchant-page')
      await expect(merchantPage.getByRole('heading', { name: 'Pay this with Haven' })).toHaveCount(1)
      // The tool name is on screen three times (offer name, Method cell, the
      // agent instruction) — assert the two that carry meaning, exactly.
      await expect(merchantPage.getByRole('cell', { name: 'buy_vpn', exact: true })).toHaveCount(1)
      // Labelled on the page itself, not only on the grid card (decision 6).
      await expect(
        merchantPage.getByText('Haven test merchant — real payments, demo goods'),
      ).toHaveCount(1)
      await expect(merchantPage.getByText(/via buy_vpn for/)).toHaveCount(1)
      // The fixture's one offer DOES advertise erc7710, so the unpinned-budget
      // line must be absent here — the negative half of the merchant-page case.
      await expect(
        merchantPage.getByText(
          'This merchant settles by EIP-3009 — the paying agent needs an unpinned budget.',
        ),
      ).toHaveCount(0)
    },
  },
]

test.describe('marketplace visual regression', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  const schemeOf = (testInfo: { project: { name: string } }): 'light' | 'dark' =>
    testInfo.project.name === 'chromium-desktop-dark' ? 'dark' : 'light'

  test.beforeEach(async ({ page }, testInfo) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    if (schemeOf(testInfo) === 'dark') {
      await page.addInitScript((themeKey: string) => {
        window.localStorage.setItem(themeKey, 'dark')
      }, THEME_STORAGE_KEY)
    }
  })

  for (const scenario of SCENARIOS) {
    for (const vp of scenario.viewports) {
      test(`${scenario.name} renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
        const scheme = schemeOf(testInfo)
        // Ten committed baselines total (six light, four dark): every scenario
        // in light, but only the four DESKTOP shots in dark — no mobile dark
        // baseline exists for this spec (unlike `analytics.visual.spec.ts`,
        // which committed all twelve). Skipped rather than filtered out of
        // `scenario.viewports`, so the desktop-only scenarios' `viewports`
        // array can stay the single honest source of what runs under light.
        test.skip(
          scheme === 'dark' && vp.name !== 'desktop',
          'no mobile dark baseline for marketplace visual specs',
        )
        const schemeSuffix = scheme === 'dark' ? '-dark' : ''
        const label = `${scenario.name} · ${vp.name} · ${scheme}`

        await page.setViewportSize({ width: vp.width, height: vp.height })
        await page.goto(scenario.path)

        await expect(
          page.getByRole('heading', { name: scenario.heading, exact: true }),
        ).toBeVisible({ timeout: ANCHOR_TIMEOUT_MS })
        await dismissMobileSidebar(page)

        await scenario.assert(page)

        await page.evaluate(() => document.fonts.ready)
        await page.waitForLoadState('networkidle')
        await expect(page.locator('.animate-pulse')).toHaveCount(0)

        await unclipScrollShell(page)
        const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
        await assertCaptureNotBlank(await page.screenshot({ fullPage: true }), {
          label,
          viewportDevicePx: vp.height * devicePixelRatio,
        })

        await expect(page).toHaveScreenshot(`${scenario.name}-${vp.name}${schemeSuffix}.png`, {
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixels: FULL_PAGE_MAX_DIFF_PIXELS,
          threshold: PIXEL_THRESHOLD,
        })
      })
    }
  }
})
