/**
 * #3818: the first-run guide, walked from an unfunded account to an approved
 * budget against the real dashboard (mocked API, the shared fixtures). The
 * guide IS the Needs you card while setup is in progress — titled
 * "Get started" — and becomes one "You're set up" line when it is done.
 *
 * Each stage swaps the overview (`support/first-run-states.ts`) and reloads,
 * the way a real account moves: USDC arrives, an agent connects, its budget
 * is approved and it pays. The fixtures start from `hasFirstAgentPayment:
 * false`, never the shared default's finished state.
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
import { serveFirstRunOverview, type FirstRunState } from './support/first-run-states'

function card(page: Page) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name: /^(Get started|Needs you)$/ }) })
}

test.describe('first-run guide (#3818)', () => {
  let state: FirstRunState = 'no-funds'

  test.beforeEach(async ({ page }) => {
    state = 'no-funds'
    await mockHavenApi(page)
    await serveFirstRunOverview(page, () => state)
    await seedAuthenticatedSession(page)
  })

  test('walks from an unfunded account to an approved budget', async ({ page }) => {
    // ── 1. No USDC: step 1 is the action, and it opens Add funds ──────────
    await page.goto('/dashboard')
    const guide = card(page)
    await expect(guide.getByRole('heading', { name: 'Get started' })).toBeVisible()
    await expect(guide.getByText('Add USDC to your account')).toBeVisible()
    // The guide never shows an address (#3818) — the dialog does.
    await expect(guide).not.toContainText(/0x[0-9a-fA-F]{6}/)
    // Connecting first stays possible, at secondary weight.
    await expect(guide.getByRole('button', { name: 'Connect agent' })).toBeVisible()
    await guide.getByRole('button', { name: 'Add funds' }).click()
    const addFunds = page.getByRole('dialog')
    await expect(addFunds).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(addFunds).toBeHidden()

    // ── 2. USDC arrives: step 1 done, step 2 is next ──────────────────────
    state = 'funded'
    await page.reload()
    await expect(guide.getByText('Funded — your agents can spend.')).toBeVisible()
    await expect(guide.getByRole('button', { name: 'Add funds' })).toHaveCount(0)
    await expect(guide.getByRole('button', { name: 'Connect agent' })).toBeVisible()

    // ── 3. An agent connects but waits for its budget: not done yet ───────
    state = 'agent-needs-setup'
    await page.reload()
    await expect(guide.getByText(/Finish setting up Connecting agent/)).toBeVisible()
    await expect(guide.getByRole('link', { name: 'Finish setup' })).toHaveAttribute(
      'href',
      '/agents/agent-e2e-pending',
    )
    // Named by step 2, so not listed again as its own row.
    await expect(guide.getByText('Connecting agent is waiting to be set up')).toHaveCount(0)

    // ── 4. Budget approved and the first payment made: one line ───────────
    state = 'set-up'
    await page.reload()
    await expect(card(page).getByRole('heading', { name: 'Needs you' })).toBeVisible()
    await expect(card(page).getByText(/You’re set up/)).toBeVisible()
    await expect(page.getByRole('list', { name: 'Onboarding checklist' })).toHaveCount(0)
  })

  test('"Hide for now" survives a reload and comes back when a step completes', async ({ page }) => {
    await page.goto('/dashboard')
    const guide = card(page)
    await guide.getByRole('button', { name: 'Hide for now' }).click()
    await expect(page.getByRole('list', { name: 'Onboarding checklist' })).toHaveCount(0)
    await page.reload()
    await expect(card(page).getByRole('heading', { name: 'Needs you' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Onboarding checklist' })).toHaveCount(0)

    state = 'funded'
    await page.reload()
    await expect(page.getByRole('list', { name: 'Onboarding checklist' })).toBeVisible()
  })
})
