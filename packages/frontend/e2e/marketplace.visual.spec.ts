/**
 * Visual regression for `/marketplace` and `/marketplace/<slug>` (#3079,
 * epic #3077).
 *
 * Five FULL-PAGE scenarios (the `SCENARIOS` loop below), each a distinct
 * branch the merchant layer added, PLUS two element-scoped clips of the
 * "Fund this merchant" modal (#3331 round 1/2 — the plain review step and
 * the replace-warning review step) that run outside that loop, the same
 * scoping `settings-accounting.visual.spec.ts` uses for its own dialog
 * (design review round 2, finding 8 — this docstring used to name only the
 * five full-page ones, undercounting the file's own coverage):
 *
 *   - `marketplace-grid`      — the grid with three merchants (live/verified,
 *     test, coming-soon), at desktop and mobile.
 *   - `merchant-page`         — a live merchant (Ampersend Demo API) with
 *     three offers, the "Pay this with Haven" block and the offers table, at
 *     desktop and mobile.
 *   - `merchant-coming-soon`  — a `coming_soon` merchant page (desktop only):
 *     no instruction block, no price, no offers table.
 *   - `merchant-test-merchant`— a live `is_test_merchant` merchant page at
 *     desktop AND mobile: the safety note that stops a real-money paste
 *     against demo goods once clipped at 390, so the phone frame is a gate.
 *   - `merchant-not-found`    — an unknown slug (desktop only): the client
 *     `notFound()` must land on the segment's own `not-found.tsx` inside
 *     the shell, a join the unit tests cannot see.
 *   - `merchant-page-fund-merchant-modal` (desktop AND mobile, element-scoped) —
 *     the "Fund this merchant" modal's plain SELECT step (agent, amount,
 *     token, period) — not the review step; that is the scenario just below.
 *     The mobile clip is #3398's: below 640 px the shared `BudgetAmountRow`
 *     keeps the token symbol inside the amount input, so no line holds only
 *     the token label (the stacked "USDC" orphan the #3331 design review
 *     captured). No dark baseline exists for the mobile clip — the dark run
 *     skips it, the same rule the SCENARIOS loop applies to its mobile shots.
 *   - `merchant-page-fund-merchant-modal-review-warning` (desktop only,
 *     element-scoped) — the same modal's review step with the
 *     replace-warning seeded (an active budget already in the slot the new
 *     grant would occupy).
 *
 * Same discipline as `analytics.visual.spec.ts`: the desktop shots of all
 * seven ALSO run under `chromium-desktop-dark` (`<name>-dark.png`), no mobile
 * dark project exists, and every capture is preceded by a structural
 * assertion that runs under `VISUAL_STRUCTURE_ONLY=1` even when pixels are
 * not compared.
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession, testAgent } from './fixtures/haven-api'
import { ampersendDemoApi, bergetAi, havenDemoStore, havenDemoStoreOffers } from './fixtures/marketplace'
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

/**
 * The frozen clock is load-bearing (the `product-routes` / `analytics`
 * lesson): `OfferRow`'s Freshness column renders `freshness(verified_at)`
 * against `Date.now()`, and the fixtures carry FIXED `verified_at` values
 * (2026-09-15T12:00Z), so an unfrozen capture reads "verified 2d ago" today
 * and "verified 3d ago" tomorrow — a required gate red on a calendar
 * boundary. Pinned before `goto` (the page reads `Date.now()` on first
 * render) and ASSERTED by the literal string on every offers scenario, so a
 * clock that stops working fails by name rather than as a pixel diff.
 */
// 54 h after the fixtures' `verified_at` — inside the "2d" bucket with a
// six-hour margin on either side, not on its edge.
const FROZEN_NOW = new Date('2026-09-17T18:00:00.000Z')
const FROZEN_FRESHNESS = 'verified 2d ago'

const PIXEL_THRESHOLD = 0.02
const FULL_PAGE_MAX_DIFF_PIXELS = 150
const ANCHOR_TIMEOUT_MS = 60_000

type Scenario = {
  name: 'marketplace-grid' | 'merchant-page' | 'merchant-coming-soon' | 'merchant-test-merchant' | 'merchant-not-found'
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
      await expect(merchantPage.getByRole('link', { name: 'Back to Marketplace' })).toBeVisible()
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
      // The frozen clock is in effect (see FROZEN_NOW). The string renders in
      // both the table and the phone-width list; only one is visible at a time.
      await expect(merchantPage.getByText(FROZEN_FRESHNESS).locator('visible=true').first()).toBeVisible()
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
    // Both viewports: the safety label is the one line whose job is to stop a
    // real-money paste against demo goods, and a badge once clipped it at 390.
    viewports: VIEWPORTS,
    heading: havenDemoStore.name,
    async assert(page) {
      const merchantPage = page.getByTestId('merchant-page')
      await expect(merchantPage.getByRole('heading', { name: 'Pay this with Haven' })).toHaveCount(1)
      // The one offer, by id in both its shapes (table row from md up, stacked
      // card below — a role query skips whichever is hidden), and its
      // instruction, which names the tool.
      await expect(merchantPage.getByTestId('offer-row-offer-nordshield-vpn')).toHaveCount(1)
      await expect(merchantPage.getByTestId('offer-card-offer-nordshield-vpn')).toHaveCount(1)
      // Labelled on the page itself, not only on the grid card (decision 6).
      await expect(merchantPage.getByTestId('test-merchant-note')).toBeInViewport()
      await expect(merchantPage.getByText(FROZEN_FRESHNESS).locator('visible=true').first()).toBeVisible()
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
  {
    name: 'merchant-not-found',
    path: '/marketplace/does-not-exist',
    viewports: DESKTOP_ONLY,
    heading: 'Merchant not found',
    // `notFound()` thrown from the client page must land on the segment's
    // own `not-found.tsx` inside the app shell — the join the unit tests
    // cannot see (they mock `next/navigation`). The fixture 404s any unknown
    // slug.
    async assert(page) {
      await expect(page.getByTestId('marketplace-not-found')).toHaveCount(1)
      await expect(page.getByRole('link', { name: 'Back to Marketplace' })).toBeVisible()
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
        // Committed baselines: every scenario in light (desktop, plus mobile
        // where listed), and only the DESKTOP shots in dark — no mobile dark
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
        await page.clock.setFixedTime(FROZEN_NOW)
        await page.goto(scenario.path)

        await expect(
          page.getByRole('heading', { name: scenario.heading, exact: true }),
        ).toBeVisible({ timeout: ANCHOR_TIMEOUT_MS })
        await dismissMobileSidebar(page)

        await scenario.assert(page)
        // #3331 baseline review: a merchant page must never be blessed in the
        // budgets-read error state (a fixture gap once baked it into six
        // baselines).
        await expect(page.getByText("Haven could not load this merchant's budgets.")).toHaveCount(0)

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

  /**
   * "Fund this merchant" (#3331) — element-scoped, like the Settings →
   * Accounting backfill dialog (`settings-accounting.visual.spec.ts`), not a
   * full-page SCENARIOS entry: the dialog is the same size regardless of the
   * page behind it. `havenDemoStore`'s one offer already advertises ERC-7710
   * (`fixtures/marketplace.ts`), so only its `funding` and an eligible agent
   * on its chain (84532) need overriding here — `testAgent` is chain 8453,
   * i.e. ineligible, which is deliberate: this override adds a SECOND agent
   * rather than reassigning the shared one every other spec pins its chain
   * against. `/agents/:id/account-signers` already answers any agent id
   * generically (`fixtures/haven-api.ts`); `/agents/:id/delegations` is
   * overridden below (empty for the plain clip, one active budget in the
   * SAME slot for the replace-warning clip), so nothing else needs
   * overriding for the new agent to be `ready`.
   *
   * #3331 review finding design-1 (BLOCKING): this test runs under BOTH
   * `chromium-desktop` and `chromium-desktop-dark` (the project's `testMatch`
   * covers the whole file, `playwright.config.ts`), but its ORIGINAL
   * `toHaveScreenshot` name carried no project segment — the dark run would
   * have compared against (or silently written over) the light baseline. This
   * follows the file's own `schemeOf`/`schemeSuffix` pattern from the
   * `SCENARIOS` loop above. Declare BOTH names at baseline dispatch:
   * `merchant-page-fund-merchant-modal-desktop.png` and
   * `merchant-page-fund-merchant-modal-desktop-dark.png` (plus the two the
   * review-step clip below adds).
   */
  const FUND_ELIGIBLE_AGENT_ID = 'agent-fund-e2e'
  const FUND_PAY_TO = '0x' + 'f0'.repeat(20)
  // Base Sepolia USDC — the same literal `FundMerchantModal.test.tsx` and
  // `useDelegationBudget.test.tsx` pin for chain 84532, resolved through the
  // shared chain registry rather than guessed.
  const FUND_USDC_84532 = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

  async function routeFundMerchantScenario(
    page: Page,
    {
      existingDelegation = false,
      merchantBudgets = [],
    }: { existingDelegation?: boolean; merchantBudgets?: unknown[] } = {},
  ) {
    const fundEligibleAgent = {
      ...testAgent,
      id: FUND_ELIGIBLE_AGENT_ID,
      name: 'Fund Agent',
      account_chain_id: 84532,
    }
    const fundedHavenDemoStore = {
      ...havenDemoStore,
      networks: ['eip155:84532'],
    }

    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname.replace(/^\/api/, '')
      if (request.method() === 'GET' && path === '/agents') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ agents: [testAgent, fundEligibleAgent] }),
        })
        return
      }
      if (request.method() === 'GET' && path === `/merchants/${havenDemoStore.slug}`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            merchant: fundedHavenDemoStore,
            offers: havenDemoStoreOffers,
            funding: [
              {
                network: 'eip155:84532',
                chain_id: 84532,
                pay_to: FUND_PAY_TO,
                pay_to_status: 'verified',
                erc7710: true,
              },
            ],
          }),
        })
        return
      }
      if (request.method() === 'GET' && path === `/merchants/${havenDemoStore.slug}/budgets`) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ budgets: merchantBudgets }) })
        return
      }
      // #3331 review finding design-10: seed the SAME (agent, token,
      // recipient) slot the new grant would occupy, so the review step's
      // replace-warning renders — the fixture default for any OTHER agent id
      // is already an empty list (`fixtures/haven-api.ts`), so only the
      // eligible agent's own delegations need overriding here.
      const isFundEligibleAgentDelegations =
        request.method() === 'GET' && path === `/agents/${FUND_ELIGIBLE_AGENT_ID}/delegations`
      if (existingDelegation && isFundEligibleAgentDelegations) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            delegations: [
              {
                id: 'delegation-fund-e2e-existing',
                chain_id: 84532,
                token_address: FUND_USDC_84532,
                recipient_address: FUND_PAY_TO,
                delegation_hash: `0x${'5e'.repeat(32)}`,
                version: 1,
                status: 'active',
                budget_atomic: '20000000',
                period_seconds: 2_592_000,
                start_date: '2026-05-02T10:00:00.000Z',
                expires_at: Math.floor(Date.UTC(2027, 4, 2) / 1000),
                created_at: '2026-05-02T10:00:00.000Z',
                merchant_id: null,
                merchant_slug: null,
                merchant_name: null,
              },
            ],
          }),
        })
        return
      }
      await route.fallback()
    })
  }

  /**
   * #3331 baseline review finding 2: the page-level entry point — the "Fund
   * this merchant" action and a populated merchant budgets list — pixel-checked
   * as a full page, not only the element-scoped modal clips.
   */
  test('merchant-page funded (action + budgets list) renders pixel-stable (desktop)', async ({ page }, testInfo) => {
    const schemeSuffix = schemeOf(testInfo) === 'dark' ? '-dark' : ''
    await routeFundMerchantScenario(page, {
      merchantBudgets: [
        {
          agent_id: FUND_ELIGIBLE_AGENT_ID,
          agent_name: 'Fund Agent',
          chain_id: 84532,
          token_address: FUND_USDC_84532.toLowerCase(),
          recipient_address: FUND_PAY_TO,
          delegation_hash: `0x${'6f'.repeat(32)}`,
          budget_atomic: '20000000',
          period_seconds: 2_592_000,
          expires_at: String(Math.floor(Date.UTC(2027, 4, 2) / 1000)),
          remaining_atomic: '12500000',
          remaining_is_from_chain: true,
          pin_status: 'current',
        },
      ],
    })

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.goto(`/marketplace/${havenDemoStore.slug}`)
    await expect(page.getByRole('heading', { name: havenDemoStore.name, exact: true })).toBeVisible({
      timeout: ANCHOR_TIMEOUT_MS,
    })
    await dismissMobileSidebar(page)
    await expect(page.getByRole('button', { name: 'Fund this merchant' })).toHaveCount(1)
    await expect(page.getByText('Fund Agent', { exact: true }).first()).toBeVisible()
    await expect(page.getByText("Haven could not load this merchant's budgets.")).toHaveCount(0)

    await page.evaluate(() => document.fonts.ready)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.animate-pulse')).toHaveCount(0)
    await unclipScrollShell(page)
    await expect(page).toHaveScreenshot(`merchant-page-funded-desktop${schemeSuffix}.png`, {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: FULL_PAGE_MAX_DIFF_PIXELS,
      threshold: PIXEL_THRESHOLD,
    })
  })

  test('merchant-page fund-merchant modal renders pixel-stable (desktop)', async ({ page }, testInfo) => {
    const schemeSuffix = schemeOf(testInfo) === 'dark' ? '-dark' : ''
    await routeFundMerchantScenario(page)

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.goto(`/marketplace/${havenDemoStore.slug}`)
    await expect(page.getByRole('heading', { name: havenDemoStore.name, exact: true })).toBeVisible({
      timeout: ANCHOR_TIMEOUT_MS,
    })
    await dismissMobileSidebar(page)

    await page.getByRole('button', { name: 'Fund this merchant' }).click()
    const dialog = page.getByTestId('fund-merchant-modal')
    await expect(dialog).toHaveCount(1)
    await expect(dialog.getByRole('heading', { name: `Fund ${havenDemoStore.name}` })).toHaveCount(1)
    await expect(dialog.getByLabel('Agent')).toHaveCount(1)
    // Anchored and case-sensitive: `getByText` with a string is a
    // case-insensitive substring match, and the modal's intro ("…a budget that
    // pays only <merchant>…") contains the same words.
    await expect(dialog.getByText(new RegExp(`^Pays only ${havenDemoStore.name} \\(`))).toHaveCount(1)

    await page.evaluate(() => document.fonts.ready)
    await expect(dialog).toHaveScreenshot(`merchant-page-fund-merchant-modal-desktop${schemeSuffix}.png`, {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 50,
      threshold: PIXEL_THRESHOLD,
    })
  })

  /**
   * #3398: the same select step at the 390 px evidence viewport
   * (`scripts/evidence-viewports.mjs`). Below `sm` the amount row stacks:
   * the token symbol must stay INSIDE the amount input (the shared
   * `BudgetAmountRow` suffix), so no line holds only the token label —
   * the orphan the #3331 design review captured at this exact width.
   * Runs under BOTH projects like the desktop test above, but the dark
   * project skips (no mobile dark baseline, the SCENARIOS loop's own
   * rule), so only `-mobile.png` is declared at baseline dispatch.
   */
  test('merchant-page fund-merchant modal renders pixel-stable (mobile)', async ({ page }, testInfo) => {
    const schemeSuffix = schemeOf(testInfo) === 'dark' ? '-dark' : ''
    test.skip(schemeSuffix === '-dark', 'no mobile dark baseline for marketplace visual specs')
    const vp = VIEWPORTS.find((v) => v.name === 'mobile')
    if (!vp) throw new Error('evidence-viewports.mjs carries no "mobile" viewport')
    await routeFundMerchantScenario(page)

    await page.setViewportSize({ width: vp.width, height: vp.height })
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.goto(`/marketplace/${havenDemoStore.slug}`)
    await expect(page.getByRole('heading', { name: havenDemoStore.name, exact: true })).toBeVisible({
      timeout: ANCHOR_TIMEOUT_MS,
    })
    await dismissMobileSidebar(page)

    await page.getByRole('button', { name: 'Fund this merchant' }).click()
    const dialog = page.getByTestId('fund-merchant-modal')
    await expect(dialog).toHaveCount(1)
    await expect(dialog.getByRole('heading', { name: `Fund ${havenDemoStore.name}` })).toHaveCount(1)
    await expect(dialog.getByLabel('Agent')).toHaveCount(1)
    // The suffix is aria-hidden — the token is readable through the input's
    // own accessible name pattern ("Budget amount"), not as a stray node.
    await expect(dialog.getByText('USDC')).toHaveCount(1)
    // Anchored: the header subtitle ("Give an agent a budget that pays only
    // …") also contains this phrase as a substring — a bare getByText resolved
    // 2 elements on the #3331 head (found running #3398's structural pass).
    await expect(dialog.getByText(new RegExp(`^Pays only ${havenDemoStore.name}`))).toHaveCount(1)

    await page.evaluate(() => document.fonts.ready)
    await expect(dialog).toHaveScreenshot(`merchant-page-fund-merchant-modal-mobile.png`, {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 50,
      threshold: PIXEL_THRESHOLD,
    })
  })

  /**
   * Design review item 10: the review step with the replace-warning seeded —
   * an /agents/:id/delegations override puts an active budget in the exact
   * slot (agent, token, recipient) the new grant would occupy.
   */
  test('merchant-page fund-merchant modal review step (replace warning) renders pixel-stable (desktop)', async ({
    page,
  }, testInfo) => {
    const schemeSuffix = schemeOf(testInfo) === 'dark' ? '-dark' : ''
    await routeFundMerchantScenario(page, { existingDelegation: true })

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.goto(`/marketplace/${havenDemoStore.slug}`)
    await expect(page.getByRole('heading', { name: havenDemoStore.name, exact: true })).toBeVisible({
      timeout: ANCHOR_TIMEOUT_MS,
    })
    await dismissMobileSidebar(page)

    await page.getByRole('button', { name: 'Fund this merchant' }).click()
    const dialog = page.getByTestId('fund-merchant-modal')
    await expect(dialog).toHaveCount(1)
    await dialog.getByLabel('Budget amount').fill('5')
    await dialog.getByRole('button', { name: 'Review' }).click()
    await expect(dialog.getByText(/replaces this agent's current budget to the same address/)).toHaveCount(1)

    await page.evaluate(() => document.fonts.ready)
    await expect(dialog).toHaveScreenshot(
      `merchant-page-fund-merchant-modal-review-warning-desktop${schemeSuffix}.png`,
      {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: 50,
        threshold: PIXEL_THRESHOLD,
      },
    )
  })
})
