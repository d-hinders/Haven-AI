/**
 * Hosted MCP — end-to-end acceptance tests (#191)
 *
 * Covers the two key paths described in the Epic #181 acceptance criteria:
 *
 *   In-budget path  — agent makes a payment within its Safe Allowance Module
 *                     headroom; the UI shows the agent as active and the
 *                     transaction lands in the activity feed.
 *
 *   Over-budget path — agent exceeds its allotted spend; Haven queues the
 *                     payment for user approval and the Approvals page shows
 *                     the pending item, keyed to the originating x402 resource.
 *
 * What is tested here vs. in unit tests
 * ─────────────────────────────────────
 * Unit tests (Vitest) cover:
 *   · Backend GET /agents/:id — mcp_last_seen_at correlated subquery.
 *
 * This list used to name HostedConnectCard and the useAgentLastSeen polling
 * hook. Both were deleted in #1813: the card lost its only call site when #345
 * retired CreateAgentModal, and the hook existed solely to drive that card's
 * live "Connected" banner. The last-seen VALUE is still rendered, by
 * components/agent-panel/AgentCard.tsx straight off the agent payload — what
 * went away is a second, polling implementation nothing reached.
 *
 * E2E tests (Playwright) verify the integrated page-level behaviour that
 * only manifests when the full Next.js app, routing, and mocked Haven API
 * are wired together.
 */

import { expect, test } from '@playwright/test'
import {
  collectBrowserErrors,
  dismissMobileSidebar,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

// ── In-budget path ────────────────────────────────────────────────────────────

test.describe('Hosted MCP — in-budget path', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('agents page renders agent list, allowances, and "Connect agent" CTA', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/agents')
    await dismissMobileSidebar(page)

    // Page structure
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()

    // At least one agent is shown (the mocked "Research agent")
    await expect(page.getByText('Research agent')).toBeVisible()

    // The agent's allowance is shown. The allowance row renders the symbol
    // twice (token chip + formatted amount), so pin to the first match —
    // same pattern as the connected-state test below.
    await expect(page.getByText(/USDC/).first()).toBeVisible()

    // Primary CTA is present — clicking it opens the ConnectAgentModal
    await expect(page.getByRole('button', { name: 'Connect agent', exact: true })).toBeVisible()

    expect(await expectNoHorizontalOverflow(page)).toMatchObject({
      hasOverflow: false,
      contentRegionFound: true,
    })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  test('Create Agent modal opens and shows the agent details step', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/agents')
    await dismissMobileSidebar(page)

    // Open the modal
    await page.getByRole('button', { name: 'Connect agent', exact: true }).click()

    // Step 1 — agent details
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()

    // The name field is the first thing the user fills in.
    // The label element is not associated via htmlFor, so use the placeholder.
    await expect(modal.getByPlaceholder(/Research Agent/i)).toBeVisible()

    // The details-step subtitle confirms we are on step 1
    await expect(modal.getByText(/Name the agent/i)).toBeVisible()

    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  test('dashboard shows active agent with its monthly spend', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/dashboard')
    await dismissMobileSidebar(page)

    // The dashboard overview card shows the agent as connected.
    // Multiple "Research agent" links can appear (agent card + activity row),
    // so pin to the first occurrence.
    await expect(page.getByRole('link', { name: /Research agent/i }).first()).toBeVisible()

    // Spend metrics are shown (mocked at $12.50).
    // Multiple elements may show "12.50" (stat + activity row) — pin to first.
    await expect(page.getByText(/12\.50/).first()).toBeVisible()

    expect(await expectNoHorizontalOverflow(page)).toMatchObject({
      hasOverflow: false,
      contentRegionFound: true,
    })
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})

// ── Over-budget path ──────────────────────────────────────────────────────────

// REMOVED (#1989): the entire `Hosted MCP — over-budget path` describe — both
// 'over-budget x402 payment appears in the approvals queue' and 'dashboard
// alert links to the approvals queue when an over-budget approval is pending'.
//
// Both drove `/approvals`, which no longer routes, and asserted on a queue UI
// deleted with the Safe rail. `POST /approvals/:id/approve` has answered HTTP
// 410 since #1986, so even the backend half of what they described is gone.
//
// ⚠️ This IS a coverage loss, and naming it honestly matters more than the
// tests did. Over-budget is still a real product behaviour — it just has a
// different shape on the delegation rail, where the budget is enforced
// on-chain during gas estimation and an over-budget payment REVERTS rather
// than queueing. Nothing in this file exercises that path today. Repointing
// these two at it would have meant inventing assertions about a flow they
// were never written for, so the gap is recorded for the epic's residue
// sweep (#1993) instead of being papered over with a green test.
test.describe('Hosted MCP — connected state', () => {
  /**
   * The component-level connected-state rendering this once pointed at
   * (HostedConnectCard) no longer exists — see #1813 and the note in this
   * file's header. These tests never exercised it: they assert the
   * page-level API contract, which is unaffected.
   *
   * Here we verify that the page-level API contract is correct:
   *   · GET /agents returns mcp_last_seen_at (null until the agent calls)
   *   · The dashboard reflects at least one connected agent
   */

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  test('dashboard overview reflects connected agent count', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/dashboard')
    await dismissMobileSidebar(page)

    // The mock dashboard overview has connectedAgents: 1.
    // At minimum the agent card is present, proving the connected count
    // flows through the overview endpoint.
    // Multiple links match "Research agent" (agent card + activity row) — pin to first.
    await expect(page.getByRole('link', { name: /Research agent/i }).first()).toBeVisible()

    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })

  test('agents page shows agent detail link for a connected agent', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page)

    await page.goto('/agents')
    await dismissMobileSidebar(page)

    // The agent appears in the list — clicking it navigates to the detail page
    const agentLink = page.getByRole('link', { name: /Research agent/i }).first()
    if (await agentLink.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await agentLink.click()
      await expect(page).toHaveURL(/\/agents\/agent-e2e/)
    } else {
      // Some layouts don't render agents as links — just verify the text is present
      await expect(page.getByText('Research agent')).toBeVisible()
    }

    expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
  })
})
