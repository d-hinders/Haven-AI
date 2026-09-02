/**
 * Resting-state visual regression for AgentPanel and AgentCard.
 *
 * The legacy Safe rail is intentionally absent from this fixture: legacy
 * accounts are readable but do not expose Haven agent authority controls.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  mockHavenApi,
  optDownToLegacyRail,
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

  test('legacy agent panel keeps the account readable and shows the retirement boundary', async ({ page }) => {
    await optDownToLegacyRail(page)
    await seedAgents(page, [agentState({ account_type: 'safe' })])
    await page.goto('/agents')
    await settle(page)

    await expect(page.getByText(/older Safe account/i)).toBeVisible()
    await expect(page.getByText(testAgent.name)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect agent' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: `Revoke ${testAgent.name}` })).toHaveCount(0)
  })
})
