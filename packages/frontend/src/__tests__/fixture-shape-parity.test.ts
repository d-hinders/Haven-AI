import { describe, expect, it } from 'vitest'
// The app has TWO Haven-API mocks: the typed e2e fixture (drives e2e tests +
// the #897 visual-regression baselines) and the screenshot script's populated
// dataset (#896 reviewer evidence). Their VALUES differ on purpose (mainnet
// e2e dataset with assertion-pinned amounts vs a Sepolia showcase dataset),
// but their SHAPES must not drift: when a hook's response type changes and
// only one mock is updated, the other silently renders error boundaries —
// the exact incident that hit /accounts on 2026-07-12. This suite fails on
// structural divergence so both mocks move together.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script
import {
  FIXTURE_USER,
  FIXTURE_SAFE,
  FIXTURE_AGENTS,
  FIXTURE_OVERVIEW,
  FIXTURE_TXS,
} from '../../scripts/screenshot.mjs'
import {
  testUser,
  testSafe,
  testAgent,
  dashboardOverview,
  dashboardTransaction,
} from '../../e2e/fixtures/haven-api'

/** Sorted top-level keys of an object. */
const keysOf = (o: unknown) => Object.keys(o as Record<string, unknown>).sort()

/**
 * Assert `a`'s keys are a superset of `b`'s (or equal with strict=true).
 * Superset is the right default: the populated screenshot dataset may carry
 * OPTIONAL response fields (account_type, mcp_last_seen_at) the e2e dataset
 * omits — what must never happen is a REQUIRED field existing in one mock
 * and missing in the other.
 */
function expectKeySuperset(a: unknown, b: unknown, label: string) {
  const missing = keysOf(b).filter((k) => !keysOf(a).includes(k))
  expect(missing, `${label}: keys in the e2e fixture missing from the screenshot fixture`).toEqual(
    [],
  )
}

describe('fixture shape parity (screenshot dataset ↔ e2e dataset)', () => {
  it('user + safe identities carry the same fields', () => {
    expect(keysOf(FIXTURE_USER)).toEqual(keysOf(testUser))
    expect(keysOf(FIXTURE_SAFE)).toEqual(keysOf(testSafe))
  })

  it('agents carry every field the e2e agent has', () => {
    for (const agent of FIXTURE_AGENTS) expectKeySuperset(agent, testAgent, 'agent')
    // …and allowance entries match exactly where both have them:
    const withAllowance = FIXTURE_AGENTS.find((a: { allowances: unknown[] }) => a.allowances.length > 0)
    expect(keysOf(withAllowance!.allowances[0])).toEqual(keysOf(testAgent.allowances[0]))
  })

  // The approvals parity case went with both fixtures (#1993): #1989 deleted
  // the route and #2055 deregistered the endpoint, so the two mocks had
  // nothing left to agree ABOUT. Parity between two mocks of a dead endpoint
  // is the purest form of a test that cannot fail usefully.

  it('dashboard overview + transactions align structurally', () => {
    expect(keysOf(FIXTURE_OVERVIEW)).toEqual(keysOf(dashboardOverview))
    expect(keysOf(FIXTURE_OVERVIEW.totals)).toEqual(keysOf(dashboardOverview.totals))
    expect(keysOf(FIXTURE_OVERVIEW.metrics)).toEqual(keysOf(dashboardOverview.metrics))
    expect(keysOf(FIXTURE_OVERVIEW.agents[0])).toEqual(keysOf(dashboardOverview.agents[0]))
    for (const t of FIXTURE_TXS) expectKeySuperset(dashboardTransaction, t, 'transaction')
  })
})
