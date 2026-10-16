/**
 * #4015: two fits on the merchant page, measured rather than snapshotted.
 *
 * 1. THE HEADER. `MerchantHeader` laid its actions beside the text from `sm`
 *    up, and the actions column does not shrink — with "Set a budget for this
 *    merchant" and its helper showing, the text column measured about 262px
 *    at a 1024px viewport on dev (QA run 2026-10-16). The fix stacks the
 *    actions below the text until `xl` and caps the helper's width. The
 *    assertion: at 1024 and 1280 the text column (the Monogram excluded) is
 *    at least 55% of the header root's width. It runs on the FUNDED Haven
 *    Demo Store setup, where the action renders — the Ampersend fixture
 *    shows no action and would pass vacuously, so the spec asserts the
 *    button first.
 *
 * 2. THE PER-OFFER BUDGET ANSWER. Since #4008 the offers tables share one
 *    `colgroup`; at 1280 a 15% Price column left about 115px for text and a
 *    one-agent answer wrapped under the price. The assertion: the answer
 *    line is ONE line — its height is at most one line-height of its own
 *    `text-xs`. (`offers-table-alignment-measure.spec.ts` keeps the outer
 *    and nested tables aligned under the rebalanced layout.)
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, serveAddFundsAccount, testAgent } from './fixtures/haven-api'
import { ampersendDemoApi, havenDemoStore, havenDemoStoreOffers } from './fixtures/marketplace'

const FROZEN_NOW = new Date('2026-09-17T18:00:00.000Z')
const MIN_TEXT_SHARE = 0.55

/**
 * The funded demo-store shape `marketplace.visual.spec.ts` photographs:
 * a verified erc7710 pay-to on Base Sepolia and an eligible agent there with
 * NO budget — so no open budget covers the offer and the header action
 * renders (#4015 owner decision (a)).
 */
async function routeFundedDemoStore(page: Page) {
  const fundAgent = { ...testAgent, id: 'agent-fund-measure', name: 'Fund Agent', account_chain_id: 84532 }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/agents') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agents: [testAgent, fundAgent] }) })
      return
    }
    if (request.method() === 'GET' && path === `/merchants/${havenDemoStore.slug}`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          merchant: { ...havenDemoStore, networks: ['eip155:84532'] },
          offers: havenDemoStoreOffers,
          funding: [
            { network: 'eip155:84532', chain_id: 84532, pay_to: '0x' + 'f0'.repeat(20), pay_to_status: 'verified', erc7710: true },
          ],
        }),
      })
      return
    }
    if (request.method() === 'GET' && path === `/merchants/${havenDemoStore.slug}/budgets`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ budgets: [] }) })
      return
    }
    await route.fallback()
  })
}

test.describe('merchant-page fit measure (#4015)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    await serveAddFundsAccount(page, 84532)
    await page.clock.setFixedTime(FROZEN_NOW)
  })

  for (const width of [1024, 1280]) {
    test(`the header's text column keeps at least ${Math.round(MIN_TEXT_SHARE * 100)}% of the header at ${width}px with the action showing`, async ({ page }) => {
      await routeFundedDemoStore(page)
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/marketplace/${havenDemoStore.slug}`)
      // Not vacuous: the action this measure is about must be on screen.
      await expect(page.getByRole('button', { name: 'Set a budget for this merchant' })).toHaveCount(1)
      await expect(page.getByText(/Give one of your agents a budget that pays only/)).toBeVisible()

      const text = page.getByTestId('merchant-header-text')
      const share = await text.evaluate((el) => {
        // The header root: the text column's parent row holds the Monogram,
        // and THAT row's parent is the header's flex container.
        const root = el.parentElement!.parentElement!
        return el.getBoundingClientRect().width / root.getBoundingClientRect().width
      })
      expect(share, `text column is ${(share * 100).toFixed(1)}% of the header at ${width}px`).toBeGreaterThanOrEqual(
        MIN_TEXT_SHARE,
      )
    })
  }

  test('a one-agent budget answer sits on ONE line under the price at 1280px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/marketplace/${ampersendDemoApi.slug}`)
    const table = page.getByTestId('offers-table')
    await expect(table).toBeVisible()
    // Research agent (Base) can pay the Base-priced Quote offer, which sits
    // behind the "1 more on Base" disclosure for this Base Sepolia account.
    await table.getByTestId('other-networks').locator('summary').click()
    const answer = table
      .getByTestId('offer-row-offer-ampersend-quote')
      .getByText('Research agent can pay this', { exact: true })
    await expect(answer).toBeVisible()

    const { height, lineHeight } = await answer.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { height: el.getBoundingClientRect().height, lineHeight: parseFloat(cs.lineHeight) }
    })
    expect(Number.isFinite(lineHeight), 'the answer line must carry a numeric line-height').toBe(true)
    expect(
      height,
      `the budget answer is ${height.toFixed(1)}px tall against a ${lineHeight}px line — it wrapped under the price`,
    ).toBeLessThanOrEqual(lineHeight + 1)
  })
})
