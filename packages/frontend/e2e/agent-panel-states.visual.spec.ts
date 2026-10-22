/**
 * Resting-state visual regression for AgentPanel and AgentCard.
 *
 * #4209: the card reads its budget, badge and last payment from the
 * dashboard's two reads, joined by agent id. `seedAgents` serves those too
 * when a test passes them; otherwise the shared mock's overview (which knows
 * only the fixture agent) answers, and a seeded agent it does not know reads
 * as unknown usage — an em dash.
 *
 * The legacy Safe rail is intentionally absent from this fixture: since #2413
 * the agent list is delegation-only, so no legacy account reaches this panel.
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  dashboardOverview,
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

async function seedAgents(
  page: Page,
  agents: unknown[],
  dashboard?: { overviewAgents: unknown[]; budgetReads: unknown[] },
) {
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
    if (dashboard && request.method() === 'GET' && path === '/dashboard/overview') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...dashboardOverview, agents: dashboard.overviewAgents }),
      })
      return
    }
    if (dashboard && request.method() === 'GET' && path === '/dashboard/budget-remaining') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ budgets: dashboard.budgetReads }),
      })
      return
    }
    await route.fallback()
  })
}

// The card's footer and the budget caption both read the clock; pin it so a
// baseline cannot drift on a calendar boundary (see product-routes' header).
const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')
const TOKEN = '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83'
const ZERO_WINDOW = {
  gross: { usd: 0, eur: 0, sek: 0 },
  net: { usd: 0, eur: 0, sek: 0 },
  approx: false,
  payments: 0,
  refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
}

function budget(n: number, budgetAtomic: string) {
  return {
    id: `9d1f4c0a-0000-4000-8000-00000000010${n}`,
    delegationHash: `0x${String(n).repeat(64)}`,
    chainId: 8453,
    tokenAddress: TOKEN,
    tokenSymbol: 'USDC',
    decimals: 6,
    budgetAtomic,
    periodSeconds: 86_400,
    startDate: '2026-08-20T10:00:00.000Z',
    expiresAt: '2027-08-20T10:00:00.000Z',
    periodEnd: '2026-09-02T10:00:00.000Z',
  }
}

function read(agentId: string, n: number, budgetAtomic: string, usedAtomic: string) {
  return {
    agent_id: agentId,
    chain_id: 8453,
    delegation_hash: `0x${String(n).repeat(64)}`,
    token_address: TOKEN,
    token_symbol: 'USDC',
    token_decimals: 6,
    budget_atomic: budgetAtomic,
    read_at: '2026-09-01T11:00:00.000Z',
    period_end: '2026-09-02T10:00:00.000Z',
    remaining_atomic: String(BigInt(budgetAtomic) - BigInt(usedAtomic)),
    remaining_from_chain: true,
    used_atomic: usedAtomic,
    sub_budget_spend: [],
  }
}

function overviewEntry(
  agent: { id: string; name: string; status: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    accountId: testAgent.account_id,
    accountName: testAgent.account_name,
    accountChainId: 8453,
    allowances: [],
    budgets: [],
    receivedSubBudgets: [],
    stats: { d7: ZERO_WINDOW, d30: ZERO_WINDOW, lastPaymentAt: null, lastCounterparty: null },
    ...overrides,
  }
}

function lastPaid(at: string, counterparty: Record<string, unknown>) {
  return {
    stats: { d7: ZERO_WINDOW, d30: ZERO_WINDOW, lastPaymentAt: at, lastCounterparty: counterparty },
  }
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
    !VISUAL_SPECS_ENABLED,
    VISUAL_SKIP_REASON,
  )

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  /**
   * #4065: a user with no agents gets the connect flow INLINE, replacing the
   * "No agents yet" empty state and the #2535 onboarding-prompt card (and the
   * two baselines that pinned them).
   *
   * Scoped to the inline card, not the page: `/agents` is documented as unfit
   * for whole-page capture in `product-routes.visual.spec.ts` (a real
   * `readContract` against a chain the harness does not have makes it flaky),
   * and that reasoning applies to this route however much of it is captured.
   */
  test('agent panel empty state — the inline first-agent flow', async ({ page }) => {
    await seedAgents(page, [])
    await page.goto('/agents')
    await settle(page)

    const flow = page.getByRole('region', { name: 'Connect your first agent' })
    await expect(flow).toHaveCount(1)
    // Assert the composition the owner approved (2026-10-19), so a regression
    // that preserves the screenshot's shape still fails on the facts that
    // matter: the card title, the shared stepper on Name, step 1 with no
    // Cancel, and none of the surface the flow replaces.
    await expect(flow.getByRole('heading', { name: 'Connect your first agent' })).toHaveCount(1)
    await expect(flow.locator('[aria-current="step"]')).toContainText('Name')
    await expect(flow.getByRole('button', { name: 'Set agent budget' })).toHaveCount(1)
    await expect(flow.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'No agents yet' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Connect agent' })).toHaveCount(0)
    await expect(flow).toHaveScreenshot('agentpanel-inline-first-agent-desktop.png', SNAPSHOT_OPTIONS)
  })

  for (const seeded of [
    { slug: 'paused', title: 'Paused in Haven', agent: agentState({ status: 'paused' }) },
    {
      slug: 'stranded',
      title: 'Recoverable funds in agent wallet',
      agent: agentState({ has_stranded_funds: true }),
    },
  ]) {
    test(`agent card warning banner — ${seeded.slug}`, async ({ page }) => {      await seedAgents(page, [seeded.agent])
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

  /**
   * #3542: half-revoked agents — credential ended (revoked) or filed under
   * Removed (archived) while a budget delegation is still redeemable on-chain
   * (`live_delegation_count` > 0). Baselines are generated by the Linux CI
   * workflow, never locally. Desktop only here: the card rows wrap below `lg`
   * and the mobile rendering is covered by `npm run screenshot --
   * --scenario=half-revoked-agents` (desktop + mobile) for the design pass.
   */
  test('agent card — revoked with a live budget shows the warning and Finish revoking', async ({ page }) => {
    const agent = agentState({ status: 'revoked', live_delegation_count: 1 })
    await seedAgents(page, [agent])
    // The card's footer reads `timeAgo(lastPaymentAt)` off the shared mock's
    // fixed 2026-10-09T09:41Z payment. Against the real clock the "Xd ago"
    // text drifts across a day boundary (13d ago from 2026-10-22T09:41Z on)
    // and the baseline goes stale — the dev-red of #3963. Pin the clock like
    // the mockup-state test below; the fixture's payment then sits AFTER
    // FROZEN_NOW, so the footer photographs timeAgo's "just now" floor,
    // forever.
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.goto('/agents')
    await settle(page)

    const card = page.getByTestId('agent-card')
    await expect(card.getByRole('heading', { name: /still active on.chain/ })).toHaveCount(1)
    await expect(card.getByRole('button', { name: `Finish revoking ${agent.name}` })).toHaveCount(1)
    await expect(card).toHaveScreenshot('agentcard-half-revoked-desktop.png', SNAPSHOT_OPTIONS)
  })

  test('hidden archived agents — the callout warns, Show archived reveals the card with Finish revoking', async ({ page }) => {
    // #4113 replaced the "Removed (n)" disclosure with an "Archived: Hidden"
    // toolbar facet; #3542's warning moved from the toggle to this callout.
    const agent = agentState({
      status: 'revoked',
      archived_at: '2026-06-01T00:00:00Z',
      live_delegation_count: 1,
    })
    await seedAgents(page, [agentState({ id: 'agent-live', name: 'Atlas' }), agent])
    // Same footer clock-drift as the revoked-card test above (#3963): the
    // revealed card's footer reads the shared mock's fixed payment against
    // the real clock. Pin it before navigation so the "Xd ago" text cannot
    // cross a day boundary under the baseline.
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.goto('/agents')
    await settle(page)

    const callout = page.getByTestId('hidden-active-budget-callout')
    await expect(callout).toHaveCount(1)
    await expect(callout).toContainText('1 archived agent still has an active budget')
    await expect(callout).toHaveScreenshot('agentpanel-hidden-active-budget-callout-desktop.png', SNAPSHOT_OPTIONS)
    await expect(page.getByRole('link', { name: agent.name })).toHaveCount(0)

    await callout.getByRole('button', { name: 'Show archived', exact: true }).click()
    await expect(callout).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Archived: Shown', exact: true })).toHaveCount(1)
    const card = page.getByTestId('agent-card').filter({ has: page.getByRole('button', { name: `Finish revoking ${agent.name}` }) })
    await expect(card).toHaveCount(1)
    await expect(card).toHaveScreenshot('agentcard-half-removed-desktop.png', SNAPSHOT_OPTIONS)
  })

  /**
   * #4209: every card state the approved mockup (version 4) draws, on one
   * desktop frame — the badge only when an agent needs attention, the
   * dashboard's budget meter and caption, one footer line (never an address),
   * one CTA, and the ⋯ menu. Also the alignment rule: cards stretch to their
   * row and the footer sits on `mt-auto`, so footers line up.
   */
  test('agent cards — every mockup state, footers aligned across each row', async ({ page }) => {
    await page.clock.setFixedTime(FROZEN_NOW)
    await page.setViewportSize({ width: 1280, height: 2200 })
    const a = {
      atlas: agentState({ id: 'agent-atlas', name: 'claude-eval', labels: [{ id: 'l1', name: 'research', color: 'blue' }] }),
      spent: agentState({ id: 'agent-spent', name: 'Lovable Dev' }),
      setup: agentState({ id: 'agent-setup', name: 'Demo agent', status: 'pending_approval', mcp_last_seen_at: '2026-09-01T10:00:00.000Z' }),
      paused: agentState({ id: 'agent-paused', name: 'Siri', status: 'paused' }),
      travel: agentState({
        id: 'agent-travel',
        name: 'Travel agent',
        labels: ['travel', 'ops', 'q4', 'eu'].map((name, i) => ({ id: `t${i}`, name, color: 'green' })),
      }),
      stranded: agentState({ id: 'agent-stranded', name: 'Atlas', has_stranded_funds: true }),
      helper: agentState({ id: 'agent-helper', name: 'Helper' }),
      revoked: agentState({ id: 'agent-revoked', name: 'Codex test agent 1', status: 'revoked' }),
      halfRemoved: agentState({ id: 'agent-half', name: 'sub-3328', status: 'revoked', archived_at: '2026-06-01T00:00:00Z', live_delegation_count: 1 }),
      archived: agentState({ id: 'agent-archived', name: 'gate-3028', status: 'revoked', archived_at: '2026-06-01T00:00:00Z' }),
    }
    await seedAgents(page, Object.values(a), {
      overviewAgents: [
        overviewEntry(a.atlas, { budgets: [budget(1, '3000000')], ...lastPaid('2026-08-31T16:00:00.000Z', { source: 'x402', merchantName: null, x402ResourceUrl: 'https://api.bitrefill.com/v1/buy', to: testAgent.delegate_address }) }),
        overviewEntry(a.spent, { budgets: [budget(2, '5000000')], ...lastPaid('2026-08-30T12:00:00.000Z', { source: 'x402', merchantName: 'Ampersend', x402ResourceUrl: null, to: null }) }),
        overviewEntry(a.setup),
        overviewEntry(a.paused, { budgets: [budget(3, '12000000')], ...lastPaid('2026-08-26T12:00:00.000Z', { source: 'direct', merchantName: null, x402ResourceUrl: null, to: testAgent.delegate_address }) }),
        overviewEntry(a.travel, { budgets: [budget(4, '200000000'), budget(5, '50000000')] }),
        overviewEntry(a.stranded, { budgets: [budget(6, '1000000')] }),
        overviewEntry(a.helper, { receivedSubBudgets: [{ parentAgentId: 'agent-atlas', parentAgentName: 'claude-eval', open: true }] }),
        overviewEntry({ ...a.halfRemoved, status: 'active' }),
        overviewEntry({ ...a.archived, status: 'active' }),
      ],
      budgetReads: [
        read('agent-atlas', 1, '3000000', '1200000'),
        read('agent-spent', 2, '5000000', '5000000'),
        read('agent-paused', 3, '12000000', '0'),
        read('agent-travel', 4, '200000000', '58000000'),
        read('agent-travel', 5, '50000000', '0'),
        read('agent-stranded', 6, '1000000', '1000000'),
      ],
    })
    await page.goto('/agents?archived=shown')
    await settle(page)

    const grid = page.getByTestId('agent-card-grid')
    await expect(grid.getByTestId('agent-card')).toHaveCount(10)
    // Settled: no skeleton left on any card.
    await expect(grid.getByTestId('agent-card-budget-loading')).toHaveCount(0)
    // The footer never prints an address (to-only reads "Last paid …" alone).
    await expect(grid.getByTestId('agent-card-footer').filter({ hasText: /0x[0-9a-f]{4}/i })).toHaveCount(0)
    await expect(grid.getByText('Last paid 20h ago · api.bitrefill.com')).toHaveCount(1)
    // One CTA per card that needs a next step, and only those.
    const ctas = await grid.getByTestId('agent-card-cta').allInnerTexts()
    expect(ctas.map((label) => label.trim()).sort()).toEqual(['Finish revoking', 'Finish setup', 'Recover funds'])

    // Footers line up across every two-card row, and so do the cards.
    const cards = await grid.getByTestId('agent-card').all()
    for (let i = 0; i + 1 < cards.length; i += 2) {
      const [left, right] = [cards[i]!, cards[i + 1]!]
      const [lb, rb] = [await left.boundingBox(), await right.boundingBox()]
      const [lf, rf] = [
        await left.getByTestId('agent-card-footer').boundingBox(),
        await right.getByTestId('agent-card-footer').boundingBox(),
      ]
      expect(lb!.y).toBeCloseTo(rb!.y, 0)
      expect(lb!.height).toBeCloseTo(rb!.height, 0)
      expect(lf!.y).toBeCloseTo(rf!.y, 0)
    }

    await expect(grid).toHaveScreenshot('agentpanel-card-states-desktop.png', SNAPSHOT_OPTIONS)

    // The ⋯ menu, open, and painted above the card below it.
    await page.getByRole('button', { name: 'Actions for claude-eval' }).click()
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem')).toHaveText(['Pause payments', 'Remove'])
    const menuBox = await menu.boundingBox()
    const topmost = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="menu"]') !== null,
      { x: menuBox!.x + menuBox!.width / 2, y: menuBox!.y + menuBox!.height - 4 },
    )
    expect(topmost).toBe(true)
    await expect(menu).toHaveScreenshot('agentcard-menu-open-desktop.png', SNAPSHOT_OPTIONS)
  })

  /**
   * #4113: the Agents page's list controls — `ListToolbar` as the page wires
   * it, which no baseline covered before (`AgentListToolbar` had none). The
   * facets come from the page's registry, so this pins the page's own
   * declaration (Status, Budget, Archived, Sort: Name) on the shared pattern.
   */
  for (const viewport of [
    { slug: 'desktop', width: 1280, height: 900 },
    { slug: 'mobile', width: 375, height: 812 },
  ]) {
    test(`agents list toolbar — ${viewport.slug}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await seedAgents(page, [
        agentState({ id: 'agent-a', name: 'Atlas' }),
        agentState({ id: 'agent-b', name: 'Research assistant', status: 'paused' }),
        agentState({ id: 'agent-c', name: 'Old agent', status: 'revoked', archived_at: '2026-06-01T00:00:00Z' }),
      ])
      await page.goto('/agents?status=active')
      // Not `settle`: the User menu it waits on is desktop chrome, absent at 375px.
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const toolbar = page.getByTestId('list-toolbar')
      await expect(toolbar).toHaveCount(1)
      // #4196: the count sits on the list summary line, outside the card; the
      // capture takes the card and the line together.
      await expect(page.getByTestId('list-summary').getByTestId('list-toolbar-count')).toHaveText('1 of 2 agents')
      await expect(toolbar.getByRole('button', { name: 'Remove Status: Active', exact: true })).toHaveCount(1)
      await expect(page.getByTestId('list-controls')).toHaveScreenshot(`agentpanel-list-toolbar-${viewport.slug}.png`, SNAPSHOT_OPTIONS)
    })
  }

})
