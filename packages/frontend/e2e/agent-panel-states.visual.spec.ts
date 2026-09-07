/**
 * Resting-state visual regression for AgentPanel and AgentCard.
 *
 * The legacy Safe rail is intentionally absent from this fixture: legacy
 * accounts are readable but do not expose Haven agent authority controls.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  mockHavenApi,
  seedAuthenticatedSession,
  testAgent,
} from './fixtures/haven-api'

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 50,
  threshold: 0.02,
} as const

async function seedAgents(page: Page, agents: unknown[]) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/agents') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agents }),
      })
      return
    }
    await route.fallback()
  })
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('button[aria-label="User menu"]')).toHaveCount(1)
}

function agentState(overrides: Record<string, unknown>) {
  return {
    ...testAgent,
    account_type: 'delegator_hybrid',
    ...overrides,
  }
}

test.describe('agent panel empty states and card banners', () => {
  test.skip(
    process.env.VISUAL_REGRESSION !== '1',
    'Linux-rendered baselines — run via the CI job (or VISUAL_REGRESSION=1 in a Linux container)',
  )

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('agent panel empty state — no agents yet', async ({ page }) => {
    await seedAgents(page, [])
    await page.goto('/agents')
    await settle(page)

    const empty = page.getByRole('heading', { name: 'No agents yet' }).locator('xpath=..')
    await expect(empty).toHaveCount(1)
    await expect(empty).toContainText('Set agent rules, then add your Haven credential')
    await expect(empty.getByRole('button', { name: 'Connect agent' })).toHaveCount(1)
    await expect(empty).toHaveScreenshot('agentpanel-empty-no-agents-desktop.png', SNAPSHOT_OPTIONS)
  })

  /**
   * #2535: the clip above is scoped to the EmptyState's own box, so the "or"
   * divider and the onboarding-prompt card that #2535 renders BELOW it sit
   * entirely outside it — the gate would stay green through any regression to
   * either. Found by `haven-design-reviewer` as a coverage gap the PR itself
   * introduced, and closed here rather than left for a later reader to discover.
   *
   * Scoped to the card, not the page: `/agents` is documented as unfit for
   * whole-page capture in `product-routes.visual.spec.ts` (a real `readContract`
   * against a chain the harness does not have makes it flaky), and that
   * reasoning applies to this route however much of it is captured.
   */
  test('agent panel empty state — the agent-onboarding prompt card', async ({ page }) => {
    await seedAgents(page, [])
    await page.goto('/agents')
    await settle(page)

    const card = page
      .getByRole('heading', { name: 'Set up with your AI agent' })
      .locator('xpath=ancestor::*[contains(@class, "rounded-[10px]")][1]')
    await expect(card).toHaveCount(1)
    // Assert the composition the design review cleared, so a regression that
    // preserves the screenshot's shape still fails on the facts that matter.
    await expect(card).toContainText('Prompt for your agent')
    await expect(card.getByRole('button', { name: 'Copy' })).toHaveCount(1)
    await expect(card.getByRole('link', { name: 'Read the agent guide' })).toHaveCount(1)
    await expect(card).toHaveScreenshot('agentpanel-empty-onboarding-prompt-desktop.png', SNAPSHOT_OPTIONS)
  })

  for (const seeded of [
    { slug: 'paused', title: 'Paused in Haven', agent: agentState({ status: 'paused' }) },
    {
      slug: 'stranded',
      title: 'Recoverable funds in agent wallet',
      agent: agentState({ has_stranded_funds: true }),
    },
  ]) {
    test(`agent card warning banner — ${seeded.slug}`, async ({ page }) => {
      await seedAgents(page, [seeded.agent])
      await page.goto('/agents')
      await settle(page)

      const agentLink = page.getByRole('link', { name: seeded.agent.name, exact: true })
      await expect(agentLink).toHaveCount(1)
      const bannerHeading = page.getByRole('heading', { name: seeded.title })
      await expect(bannerHeading).toHaveCount(1)

      const banner = bannerHeading.locator('xpath=../../..')
      await expect(banner).toHaveScreenshot(
        `agentcard-banner-${seeded.slug}-desktop.png`,
        SNAPSHOT_OPTIONS,
      )
    })
  }

})
