/**
 * #3818: the first-run guide, walked from an unfunded account to an approved
 * budget against the real dashboard (mocked API, the shared fixtures). The
 * guide IS the Needs attention card while setup is in progress — titled
 * "Get started".
 *
 * #4707: the finished state is no longer a line inside that card. The first
 * agent payment gets its OWN card, found by its own heading — the Needs
 * attention card is not widened to reach it.
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
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name: /^(Get started|Needs attention)$/ }) })
}

/** #4707: the milestone card, found by its own heading — never by widening `card`. */
function milestoneCard(page: Page) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name: /made its first payment$/ }) })
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
    await expect(guide.getByText('Your account holds USDC.')).toBeVisible()
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

    // ── 4. Budget approved, no payment yet: step 3 is the action ──────────
    state = 'agent-set-up'
    await page.reload()
    await expect(guide.getByText('An agent is connected with a budget.')).toBeVisible()
    await expect(guide.getByRole('button', { name: 'Show me how' })).toBeVisible()

    // ── 5. The first payment made: its own card, and the steps are gone ───
    state = 'set-up'
    await page.reload()
    // The milestone is its own surface (#4707) — found by its own heading.
    const milestone = milestoneCard(page)
    await expect(milestone.getByRole('heading', { name: 'Research agent made its first payment' })).toBeVisible()
    // The fixture's payment is dated 2026-09-01 and this spec runs on a real
    // clock, so the card says the DATE — "just now" is for a recent row, and
    // the rule is pinned in `lib/__tests__/first-agent-payment.test.ts`.
    await expect(milestone.getByText(/0\.05 to research\.example, 1 September 2026\. You’re set up\./)).toBeVisible()
    await expect(milestone.getByRole('link', { name: 'View transaction' })).toHaveAttribute('href', '/transactions')
    // Needs attention is back to meaning what it says: no steps, no line.
    await expect(card(page).getByRole('heading', { name: 'Needs attention' })).toBeVisible()
    await expect(card(page).getByText(/You’re set up/)).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'Your first 3 steps' })).toHaveCount(0)

    // Dismissing the card persists, on the line's own key.
    await milestone.getByRole('button', { name: 'Dismiss' }).click()
    await expect(milestoneCard(page)).toHaveCount(0)
    await page.reload()
    await expect(milestoneCard(page)).toHaveCount(0)
  })

  test('"Hide for now" survives a reload and comes back when a step completes', async ({ page }) => {
    await page.goto('/dashboard')
    const guide = card(page)
    await guide.getByRole('button', { name: 'Hide for now' }).click()
    await expect(page.getByRole('list', { name: 'Your first 3 steps' })).toHaveCount(0)
    await page.reload()
    await expect(card(page).getByRole('heading', { name: 'Needs attention' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Your first 3 steps' })).toHaveCount(0)

    state = 'funded'
    await page.reload()
    await expect(page.getByRole('list', { name: 'Your first 3 steps' })).toBeVisible()
  })
})
