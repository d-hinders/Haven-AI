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
  legacySafe,
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

/**
 * The rail default (#2264, epic #1440).
 *
 * Until #2264 the e2e `testSafe` carried NO `account_type` at all, `railOf`
 * read that as the legacy Safe rail (`lib/custody-rail.ts`), and so
 * `browser_smoke` (28 spec files) and `design_visual` pinned the rendered
 * behaviour of a configuration that answers HTTP 410 in production (#1986).
 * Every green run was a true statement about a rail no user is on.
 *
 * Nothing noticed for one reason: the default is an ABSENCE. There was no line
 * to review, no assertion to break, and the two harnesses diverged silently
 * after `scripts/screenshot.mjs` was corrected the other way (#2205/#2227/
 * #2233). This block is the line that has to be deleted for that to happen
 * again — a re-inversion now fails a named test instead of turning 28 spec
 * files quietly false.
 *
 * It guards the DEFAULT, not the opt-downs: a spec whose subject IS the retired
 * rail spreads `legacySafe` and says why, exactly as each legacy screenshot
 * scenario opts down per-scenario. What must never happen again is the retired
 * rail arriving by default, or by omission.
 */
describe('the shared fixtures default to the LIVE rail (#2264)', () => {
  it('the e2e account and its agent are both delegator_hybrid', () => {
    expect(
      testSafe.account_type,
      'the e2e shared account must be on the LIVE delegation rail — a legacy ' +
        'default makes browser_smoke and design_visual pin a rail that answers 410',
    ).toBe('delegator_hybrid')
    // Not an `agents` column: every agent-row read selects it as
    // `us.account_type` off the joined `user_safes` row, so one account answers
    // one value and these two cannot disagree without describing a state the
    // backend cannot serve (#2202).
    expect(testAgent.account_type).toBe('delegator_hybrid')
  })

  it('the screenshot harness agrees, so the two cannot drift apart again', () => {
    expect(FIXTURE_SAFE.account_type).toBe('delegator_hybrid')
  })

  it('the opt-DOWN is explicit, named, and the only way back to the retired rail', () => {
    expect(legacySafe.account_type).toBe('safe')
    // `'safe'`, never `null` or absent: migration 041 declares the column
    // `VARCHAR(32) NOT NULL DEFAULT 'safe'` with a two-value CHECK, so an
    // absent value is not in the column's domain (#2202).
    expect(legacySafe.safe_address).toBe(testSafe.safe_address)
  })

  it('every account the session fixture serves states its rail', () => {
    // The failure mode was an OMISSION, so absence is what this checks: a safe
    // added to `testUser.safes` without an `account_type` would be read as
    // legacy by `railOf` and nothing else would say so.
    for (const safe of testUser.safes) {
      expect(
        (safe as { account_type?: string }).account_type,
        `every fixture account must name its rail explicitly; ${safe.id} does not`,
      ).toMatch(/^(safe|delegator_hybrid)$/)
    }
  })
})
