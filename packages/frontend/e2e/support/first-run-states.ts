/**
 * #3818: the four first-run states as overlays on the shared dashboard
 * fixture, used by `first-run-guide.spec.ts` (behaviour) and
 * `first-run-guide.visual.spec.ts` (pixels). One definition, so the two specs
 * walk the same states.
 *
 * Built from `dashboardOverview` itself: its `agents[0]` is the active agent
 * with a live budget, `agents[2]` the `pending_approval` one. The fixture's
 * default is the FINISHED state (funded, set up, first payment made), which
 * is why these overlays exist — `hasFirstAgentPayment: true` is never
 * pre-seeded for the earlier states.
 */
import type { Page, Route } from '@playwright/test'
import { dashboardOverview } from '../fixtures/haven-api'

export type FirstRunState = 'no-funds' | 'funded' | 'agent-needs-setup' | 'set-up'

const [activeAgent, , pendingAgent] = dashboardOverview.agents

function accountsWith(funded: boolean) {
  return dashboardOverview.accounts.map((account) => ({
    ...account,
    usdcBalanceAtomic: funded ? account.usdcBalanceAtomic : '0',
    funded,
  }))
}

export function firstRunOverview(state: FirstRunState) {
  const funded = state !== 'no-funds'
  const agents =
    state === 'set-up' ? [activeAgent] : state === 'agent-needs-setup' ? [pendingAgent] : []
  return {
    ...dashboardOverview,
    accounts: accountsWith(funded),
    agents,
    agentCount: {
      active: state === 'set-up' ? 1 : 0,
      paused: 0,
      pending_approval: state === 'agent-needs-setup' ? 1 : 0,
    },
    onboardingProgress: { hasFirstAgentPayment: state === 'set-up' },
    activity: state === 'set-up' ? dashboardOverview.activity : [],
    // A new account has made no payments, so none has failed either; the
    // shared fixture's failed intent would put a "Payment failed" row under
    // the steps of an account that never paid.
    spend:
      state === 'set-up' ? dashboardOverview.spend : { ...dashboardOverview.spend, failedIntents7d: 0 },
  }
}

/** Serves `/dashboard/overview` for whatever `current()` returns at request time. */
export async function serveFirstRunOverview(page: Page, current: () => FirstRunState) {
  await page.route('**/api/dashboard/overview**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(firstRunOverview(current())),
    })
  })
}
