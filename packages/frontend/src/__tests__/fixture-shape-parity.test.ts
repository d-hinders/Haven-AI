import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
  fixtureFor,
  FIXTURE_USER,
  FIXTURE_ACCOUNT,
  FIXTURE_AGENTS,
  FIXTURE_OVERVIEW,
  FIXTURE_TXS,
  FIXTURE_ACCOUNTING_PROVIDERS,
  FIXTURE_ACCOUNTING_CONNECTION,
  FIXTURE_ACCOUNTING_FEED_STATUS,
  FIXTURE_ACCOUNTING_FEED_COMING_SOON,
  FIXTURE_ACCOUNTING_FEED_SELF_HOSTED,
  FIXTURE_ACCOUNTING_FEED_ATTENTION,
  FIXTURE_ANALYTICS_OVERVIEW,
  FIXTURE_ANALYTICS_OVERVIEW_EMPTY,
  httpError,
} from '../../scripts/screenshot.mjs'
// The visual gate's copies of the two overview fixtures (#3038). Pinned below,
// because the spec that reads them cannot reach the harness itself — see the
// `analytics-overview.ts` docblock for the measured reason.
import {
  analyticsOverview,
  analyticsOverviewEmpty,
  analyticsOverviewFailure,
} from '../../e2e/fixtures/analytics-overview'
import {
  testUser,
  testUserSek,
  testSafe,
  testAgent,
  dashboardOverview,
  dashboardTransaction,
  accountingProviders,
  accountingConnection,
  accountingFeedStatus,
  accountingFeedComingSoon,
  accountingFeedSelfHosted,
  accountingFeedAttention,
} from '../../e2e/fixtures/haven-api'
import { API_MOCK_DEFAULTS } from '../../e2e/fixtures/api-mock'

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
    expect(keysOf(FIXTURE_ACCOUNT)).toEqual(keysOf(testSafe))
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
    // #3127 (finding 8): the SEK figures the SERVED DEFAULT renders exist in
    // BOTH harnesses, with values. A harness that drops a `sek` key back out
    // photographs `0,00 kr` under the default — the same "green tick that is
    // a statement about an unchanged render" defect the key pins above stop
    // for shapes, now also stopped for the SEK values.
    expect(FIXTURE_OVERVIEW.totals.sek).toBeGreaterThan(0)
    expect(FIXTURE_OVERVIEW.change.sekAmount).toBeGreaterThan(0)
    expect(FIXTURE_OVERVIEW.metrics.monthlyAgentSpendSek).toBeGreaterThan(0)
    expect(dashboardOverview.totals.sek).toBeGreaterThan(0)
    expect(dashboardOverview.change.sekAmount).toBeGreaterThan(0)
    expect(dashboardOverview.metrics.monthlyAgentSpendSek).toBeGreaterThan(0)
  })

  /**
   * #3127 (finding 8): the SEK default is a FIXTURE STATE, not just a type.
   * `testUser` keeps `currency_preference: 'USD'` — every existing spec and
   * baseline is pinned to that render — while `testUserSek` (the served
   * default, migration 091) is the session the currency visual spec
   * photographs via `serveSekUser`. The screenshot harness's own session IS
   * the SEK user, so every reviewer capture renders the default. If either
   * half reverts, the SEK render goes dark again while every gate stays
   * green — exactly the silent re-inversion this file exists to catch.
   */
  describe('the served SEK default has a fixture and a session (#3127 finding 8)', () => {
    it('the e2e fixture carries the SEK user beside the historical USD one', () => {
      // The historical session keeps its currency — the existing baselines
      // are statements about THIS user's render.
      expect(testUser.currency_preference).toBe('USD')
      expect(testUserSek.currency_preference).toBe('SEK')
      // Same identity and account; ONLY the preference differs.
      expect(testUserSek.id).toBe(testUser.id)
      expect(testUserSek.accounts).toEqual(testUser.accounts)
    })

    it('the screenshot harness session is the SEK user', () => {
      expect(FIXTURE_USER.currency_preference).toBe('SEK')
    })
  })

  /**
   * #2868: the Settings → Accounting card reads `GET /accounting/providers`
   * and `GET /accounting/connections` in BOTH harnesses — the screenshot
   * scenario spreads its five states off the connection row, and the visual
   * spec spreads the e2e row the same way — so a key that exists in one and
   * not the other renders `undefined` in exactly one gate.
   */
  it('accounting providers + connection align structurally', () => {
    expect(FIXTURE_ACCOUNTING_PROVIDERS.map((p: { id: string }) => p.id)).toEqual(accountingProviders.map((p) => p.id))
    for (const [i, p] of FIXTURE_ACCOUNTING_PROVIDERS.entries()) {
      expect(keysOf(p)).toEqual(keysOf(accountingProviders[i]))
      expect(keysOf(p.capabilities)).toEqual(keysOf(accountingProviders[i].capabilities))
    }
    expect(keysOf(FIXTURE_ACCOUNTING_CONNECTION)).toEqual(keysOf(accountingConnection))
    expect(keysOf(FIXTURE_ACCOUNTING_CONNECTION.settings)).toEqual(keysOf(accountingConnection.settings))
    // And both serve the row the card renders by default: connected, the
    // destination, with a company — the "Connected to <Company AB>" state.
    for (const row of [FIXTURE_ACCOUNTING_CONNECTION, accountingConnection]) {
      expect(row).toMatchObject({ status: 'connected', isActiveDestination: true, baseCurrency: 'SEK' })
      expect(typeof row.externalCompanyName).toBe('string')
    }
  })

  /**
   * #2903 review: `/accounting` renders null unless the feed status says
   * `hosted && flagEnabled`, so both harnesses must answer it — and with the
   * same keys, including every sync row's.
   */
  it('accounting feed status aligns structurally, and both render the feed page', () => {
    expect(keysOf(FIXTURE_ACCOUNTING_FEED_STATUS)).toEqual(keysOf(accountingFeedStatus))
    expect(keysOf(FIXTURE_ACCOUNTING_FEED_STATUS.counts)).toEqual(keysOf(accountingFeedStatus.counts))
    expect(FIXTURE_ACCOUNTING_FEED_STATUS.syncs.length).toBe(accountingFeedStatus.syncs.length)
    for (const [i, row] of FIXTURE_ACCOUNTING_FEED_STATUS.syncs.entries()) {
      expect(keysOf(row)).toEqual(keysOf(accountingFeedStatus.syncs[i]))
    }
    for (const status of [FIXTURE_ACCOUNTING_FEED_STATUS, accountingFeedStatus]) {
      expect(status).toMatchObject({ hosted: true, enabled: true, flagEnabled: true, available: true, connected: true })
      expect(status.syncs.map((s) => s.status).sort()).toEqual(['failed', 'pushed'])
      // #2869: the summary line reads the destination row.
      expect(keysOf(status.destination as Record<string, unknown>)).toEqual(
        ['provider', 'displayName', 'status', 'companyName', 'lastPushAt'].sort(),
      )
    }
    // The connection row and the feed status agree on the company.
    expect(FIXTURE_ACCOUNTING_FEED_STATUS.companyName).toBe(FIXTURE_ACCOUNTING_CONNECTION.externalCompanyName)
    expect(accountingFeedStatus.companyName).toBe(accountingConnection.externalCompanyName)
  })

  /**
   * #2869: both harnesses carry the two OFF states, and they must agree —
   * `hosted && !enabled` is Coming soon, `!hosted` is not-available. A key
   * that exists in one and not the other renders `undefined` in exactly one
   * gate, which is the drift this file exists to catch.
   */
  it('the two accounting OFF states align structurally, and say the same thing', () => {
    for (const [fixture, e2e] of [
      [FIXTURE_ACCOUNTING_FEED_COMING_SOON, accountingFeedComingSoon],
      [FIXTURE_ACCOUNTING_FEED_SELF_HOSTED, accountingFeedSelfHosted],
    ] as const) {
      expect(keysOf(fixture)).toEqual(keysOf(e2e))
      // Both OFF answers keep the READY answer's keys — the page and the
      // sidebar read the same shape whichever state they are in.
      expect(keysOf(fixture)).toEqual(keysOf(FIXTURE_ACCOUNTING_FEED_STATUS))
      for (const status of [fixture, e2e]) {
        expect(status).toMatchObject({ enabled: false, flagEnabled: false, available: false, connected: false })
        expect(status.destination).toBeNull()
        expect(status.syncs).toEqual([])
      }
    }
    // The one field that tells the two states apart.
    expect(FIXTURE_ACCOUNTING_FEED_COMING_SOON.hosted).toBe(true)
    expect(accountingFeedComingSoon.hosted).toBe(true)
    expect(FIXTURE_ACCOUNTING_FEED_SELF_HOSTED.hosted).toBe(false)
    expect(accountingFeedSelfHosted.hosted).toBe(false)
  })

  /**
   * #2869 design review: the attention state — a destination needing a
   * reconnect plus exhausted rows — is what the attention summary, the inline
   * "Stopped retrying" explanation and the sidebar dot photograph. Both
   * harnesses carry it, same keys, same raising fields.
   */
  it('the accounting ATTENTION state aligns structurally, and raises the same signals', () => {
    expect(keysOf(FIXTURE_ACCOUNTING_FEED_ATTENTION)).toEqual(keysOf(accountingFeedAttention))
    expect(keysOf(FIXTURE_ACCOUNTING_FEED_ATTENTION)).toEqual(keysOf(FIXTURE_ACCOUNTING_FEED_STATUS))
    for (const status of [FIXTURE_ACCOUNTING_FEED_ATTENTION, accountingFeedAttention]) {
      expect(status).toMatchObject({ hosted: true, enabled: true, available: true, connected: false })
      expect(keysOf(status.destination as Record<string, unknown>)).toEqual(
        ['provider', 'displayName', 'status', 'companyName', 'lastPushAt'].sort(),
      )
      expect((status.destination as { status: string }).status).toBe('needs_reauthorisation')
      expect(status.counts.exhausted).toBe(3)
    }
  })
})

/**
 * The rail default (#2264, epic #1440).
 *
 * Until #2264 the e2e `testSafe` carried NO `account_type` at all, `railOf`
 * read that as the legacy Safe rail (the retired custody page's rail helper,
 * deleted with the page itself in #3024), and so
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
 * It guards the DEFAULT, not the opt-downs — and since #2459 there are no
 * opt-downs left to guard: `legacySafe` and the opt-down page helper are
 * deleted, the retired rail cannot arrive by default, by omission, or at
 * all. What must never happen again is the retired rail arriving in the
 * shared fixtures in any form.
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
    expect(FIXTURE_ACCOUNT.account_type).toBe('delegator_hybrid')
  })

  it('the shared e2e fixture carries no legacy-rail account literal (#2459, #2912)', () => {
    // DELETION, decided deliberately: `legacySafe` was removed, not kept.
    // #2413 filtered every account list query to `delegator_hybrid`
    // (`infra/repositories/{user-safes,agents,dashboard}.ts`), so an
    // `account_type: 'legacy_safe'` session/agent payload stopped being
    // servable on these routes, and a fixture stubbing one asserts against a
    // state that cannot occur in production. This block keeps the deletion
    // honest in the direction that matters: a legacy-rail account literal
    // returning to the shared e2e fixture fails HERE, by name — the same
    // re-inversion tripwire the #2264 default pin above provides for the
    // delegated shape. #2912 renamed the retired VALUE from `'safe'` to
    // `'legacy_safe'`; the guard checks the current name so it keeps catching
    // the same class of regression rather than one it can no longer produce.
    //
    // Scope boundary: scenario-level legacy stubs inside
    // `scripts/screenshot.mjs` are NOT covered here — they pre-date #2413's
    // funnel, are outside #2459's file ownership, and are tracked as the
    // follow-up cascade slice.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const source = readFileSync(path.join(root, 'e2e/fixtures/haven-api.ts'), 'utf8')
    expect(
      /account_type: '(legacy_)?safe'/.test(source),
      'e2e/fixtures/haven-api.ts constructs a legacy-rail account the API can no longer serve (#2413, #2459, #2912)',
    ).toBe(false)
  })

  it('every account the session fixture serves states its rail', () => {
    // The failure mode was an OMISSION, so absence is what this checks: a safe
    // added to `testUser.accounts` without an `account_type` would be read as
    // legacy by `railOf` and nothing else would say so.
    for (const safe of testUser.accounts) {
      expect(
        (safe as { account_type?: string }).account_type,
        `every fixture account must name its rail explicitly; ${safe.id} does not`,
      ).toMatch(/^(safe|delegator_hybrid)$/)
    }
  })
})

/**
 * `allowance_amount` on `/agents` is the HUMAN-DECIMAL projection — in BOTH
 * harnesses (#2298).
 *
 * One field name carries two wire shapes (#2295). `GET /agents` sends the
 * projection `rails/delegation-budget-view.ts` builds with
 * `formatTokenValue(row.budget_atomic, decimals)`: `'0'` for a zero budget,
 * otherwise `<integer>.<2–6 fraction digits>` — `'250.00'` for 250 USDC, never
 * the atomic `'250000000'`. The connect-setup budget (`agent_budget[]` on
 * `/agent-connection-setups/*`) is the OTHER shape: an atomic integer string,
 * `allowanceAtomicAmount` in `openapi/spec.ts`.
 *
 * #2298 was filed because the e2e fixture shipped the atomic shape on the
 * field `/agents` sends human — so a budget-amount baseline captured on the
 * harness would have been green through the #2283 defect, rendering a value
 * the live route never sends. #2264 corrected `testAgent.allowances`; the
 * screenshot dataset was corrected under #2106. Neither correction had a pin,
 * and the key-parity suite above compares KEYS, not values — an atomic string
 * and a decimal one have identical keys. This block is the pin. It fails by
 * name (harness, agent, row) if either dataset drifts back to the shape
 * `/agents` cannot send.
 *
 * The pattern is the emitter's PRODUCED SET, stated once here rather than
 * ported: `formatTokenValue` trims trailing zeroes to a two-digit minimum and
 * caps at six, so `'250.000000'` is in the set (six digits) even though for a
 * whole-token USDC budget the emitter itself writes `'250.00'` — the backend's
 * `openapi/spec.test.ts` records that same digits-versus-shape caveat and pins
 * the produced values `['250.00', '0.000001', '5.00', '0']`, which the first
 * case below re-states so the pattern is proven able to say yes AND no.
 */
describe('allowance_amount on /agents is the human-decimal projection in BOTH harnesses (#2298)', () => {
  /** What `formatTokenValue` can emit: `'0'`, or an integer, a point, 2–6 digits. */
  const HUMAN_DECIMAL = /^(0|[0-9]+\.[0-9]{2,6})$/
  /** What `allowanceAtomicAmount` admits: an integer string, nothing else. */
  const ATOMIC = /^[0-9]+$/

  type AllowanceRow = { id?: string; allowance_amount: string }
  type OverviewAllowance = { allowanceAmount: string }

  it('the human pattern admits what formatTokenValue produces and rejects every atomic budget', () => {
    // Positive control first: the produced set `openapi/spec.test.ts` pins.
    for (const produced of ['250.00', '0.000001', '5.00', '0']) {
      expect([produced, HUMAN_DECIMAL.test(produced)]).toEqual([produced, true])
    }
    // The pattern must be able to say no, or every case below is vacuous:
    // the three atomic literals the two harnesses carry today, plus the
    // pre-#2264 value #2298 was filed against.
    for (const atomic of ['250000000', '25000000', '10000000000000000000', '1']) {
      expect([atomic, HUMAN_DECIMAL.test(atomic)]).toEqual([atomic, false])
    }
    // And a bare integer other than `'0'` is NOT a human amount (#2408): the
    // emitter always writes a fraction, so `'250'` cannot come from it.
    expect(HUMAN_DECIMAL.test('250')).toBe(false)
    expect(ATOMIC.test('250.00')).toBe(false)
  })

  it('e2e: every allowance the shared fixture serves on GET /agents and /dashboard/overview is human-decimal', () => {
    const rows = testAgent.allowances as AllowanceRow[]
    expect(rows.length, 'testAgent must carry a budget row, or this pins nothing').toBeGreaterThan(0)
    for (const row of rows) {
      expect(
        [`e2e/fixtures/haven-api.ts testAgent.allowances[${row.id}]`, row.allowance_amount],
        'the e2e fixture ships a shape GET /agents does not send (#2298)',
      ).toEqual([`e2e/fixtures/haven-api.ts testAgent.allowances[${row.id}]`, expect.stringMatching(HUMAN_DECIMAL)])
    }
    // Same projection, camelCase, on the dashboard route (`routes/dashboard.ts`).
    const overview = dashboardOverview.agents.flatMap((a) => a.allowances as OverviewAllowance[])
    expect(overview.length).toBeGreaterThan(0)
    for (const { allowanceAmount } of overview) {
      expect(['e2e dashboardOverview.agents[].allowances[]', allowanceAmount]).toEqual([
        'e2e dashboardOverview.agents[].allowances[]',
        expect.stringMatching(HUMAN_DECIMAL),
      ])
    }
  })

  it('screenshot: every allowance FIXTURE_AGENTS and FIXTURE_OVERVIEW carry is human-decimal', () => {
    const agents = FIXTURE_AGENTS as { id: string; allowances: AllowanceRow[] }[]
    const rows = agents.flatMap((a) => a.allowances.map((row) => [a.id, row] as const))
    expect(rows.length, 'FIXTURE_AGENTS must carry a budget row, or this pins nothing').toBeGreaterThan(0)
    for (const [agentId, row] of rows) {
      expect(
        [`scripts/screenshot.mjs FIXTURE_AGENTS[${agentId}].allowances[${row.id}]`, row.allowance_amount],
        'the screenshot fixture ships a shape GET /agents does not send (#2298)',
      ).toEqual([
        `scripts/screenshot.mjs FIXTURE_AGENTS[${agentId}].allowances[${row.id}]`,
        expect.stringMatching(HUMAN_DECIMAL),
      ])
    }
    const overview = (FIXTURE_OVERVIEW.agents as { allowances: OverviewAllowance[] }[]).flatMap(
      (a) => a.allowances,
    )
    expect(overview.length).toBeGreaterThan(0)
    for (const { allowanceAmount } of overview) {
      expect(['screenshot FIXTURE_OVERVIEW.agents[].allowances[]', allowanceAmount]).toEqual([
        'screenshot FIXTURE_OVERVIEW.agents[].allowances[]',
        expect.stringMatching(HUMAN_DECIMAL),
      ])
    }
  })

  it('screenshot: every projected allowance re-parses to the budget_atomic of the delegation it projects', () => {
    // The projection IS `formatTokenValue(row.budget_atomic, 6)` for USDC, so
    // the human string must scale back to the atomic budget the same harness
    // serves on `/agents/:id/delegations` — the same re-parse the delegate-
    // balance guard in `screenshot-fixture.test.ts` uses, applied to the row
    // `/agents` renders. A right-shaped, wrong-valued amount fails here.
    const agents = FIXTURE_AGENTS as { id: string; allowances: AllowanceRow[] }[]
    let checked = 0
    for (const agent of agents) {
      const res = fixtureFor(`/agents/${agent.id}/delegations`) as {
        delegations: { budget_atomic: string }[]
      } | null
      // Coverage boundary, made loud rather than silent (haven-reviewer's nit
      // on this PR): an agent carrying `allowances` rows with no keyed
      // `/delegations` body is the #2106 impossible state — the projection is
      // what fills the array — so it fails here instead of skipping the
      // value check. An agent with NO allowances and no delegation is fine.
      // An unkeyed id falls through to `null`; read it as an empty body so the
      // length assertion below is what names the mismatch, not a null access.
      const delegations = res?.delegations ?? []
      if (agent.allowances.length === 0 && delegations.length === 0) continue
      expect(
        [agent.id, delegations.length],
        `${agent.id} carries allowances but no keyed /agents/:id/delegations body to re-parse against`,
      ).toEqual([agent.id, agent.allowances.length])
      agent.allowances.forEach((row, i) => {
        const [int = '', frac = ''] = row.allowance_amount.split('.')
        const reconstructed = (BigInt(int) * 10n ** 6n + BigInt(frac.padEnd(6, '0'))).toString()
        expect([agent.id, reconstructed]).toEqual([agent.id, delegations[i]!.budget_atomic])
        checked += 1
      })
    }
    expect(checked, 'no delegation-backed allowance was checked — the fixture lost its budgets').toBeGreaterThan(0)
  })

  it('every allowance_amount literal in either harness file carries the shape of the key it sits under', () => {
    // The exported objects above cannot see a scenario-local override —
    // `catalog-budget-states` in `screenshot.mjs` answers `/agents` with its
    // own `allowances` row, and a spec can seed one the same way. So the two
    // files are read as text: each `allowance_amount: '…'` literal is
    // classified by the NEAREST preceding `allowances: [` (the `/agents`
    // projection — human) or `agent_budget: [` (the connect-setup request —
    // atomic), and must carry that key's shape. A literal under neither key
    // fails loudly rather than being skipped.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const files = ['e2e/fixtures/haven-api.ts', 'scripts/screenshot.mjs'] as const
    const shapeFor = { allowances: HUMAN_DECIMAL, agent_budget: ATOMIC } as const
    for (const label of files) {
      const source = readFileSync(path.join(root, label), 'utf8')
      const keys = [...source.matchAll(/\b(allowances|agent_budget):\s*\[/g)].map((m) => ({
        at: m.index ?? 0,
        key: m[1] as keyof typeof shapeFor,
      }))
      const literals = [...source.matchAll(/allowance_amount:\s*'([^']*)'/g)]
      const seen = { allowances: 0, agent_budget: 0 }
      for (const m of literals) {
        const at = m.index ?? 0
        const line = source.slice(0, at).split('\n').length
        const owner = keys.filter((k) => k.at < at).at(-1)
        expect(owner, `${label}:${line} allowance_amount literal under neither allowances nor agent_budget`).toBeDefined()
        seen[owner!.key] += 1
        expect(
          [`${label}:${line} (${owner!.key})`, m[1]],
          `${label}:${line}: an \`${owner!.key}\` row must carry the ${owner!.key === 'allowances' ? 'HUMAN-DECIMAL' : 'ATOMIC'} shape (#2298)`,
        ).toEqual([`${label}:${line} (${owner!.key})`, expect.stringMatching(shapeFor[owner!.key])])
      }
      // Non-vacuity: both files carry at least one literal of EACH kind today;
      // a file that stops carrying one has changed what this scan covers.
      expect([label, seen.allowances > 0, seen.agent_budget > 0]).toEqual([label, true, true])
    }
  })
})

/**
 * The THIRD family (#3027): `apiMock()`'s typed builder
 * (`e2e/fixtures/api-mock.ts`) re-serves the SAME e2e constants above behind
 * a route table checked against the generated OpenAPI types, but it is a
 * SEPARATE object graph (`satisfies`-derived) — so a hand-edit to the builder
 * that changes a default's shape drifts silently from both the e2e fixture
 * and the screenshot harness unless something pins it. This pins the
 * builder's defaults key-equal to the e2e constants they are built from, for
 * every route the table covers. #2914 removed the schema's deprecated Safe
 * twins entirely, so the builder no longer needs to complete any of them —
 * the defaults below are now EXACTLY key-equal, not "plus completions".
 */
describe('fixture shape parity (apiMock builder ↔ e2e dataset, #3027)', () => {
  it('/agents: the builder default carries the same top-level keys as testAgent', () => {
    const agent = API_MOCK_DEFAULTS['/agents'].agents[0]!
    expect(keysOf(agent)).toEqual(keysOf(testAgent))
    expect(keysOf(agent.allowances[0])).toEqual(keysOf(testAgent.allowances[0]))
  })

  it('/dashboard/overview: the builder default aligns with dashboardOverview', () => {
    const overview = API_MOCK_DEFAULTS['/dashboard/overview']
    expect(keysOf(overview)).toEqual(keysOf(dashboardOverview))
    expect(keysOf(overview.totals)).toEqual(keysOf(dashboardOverview.totals))
    expect(keysOf(overview.metrics)).toEqual(keysOf(dashboardOverview.metrics))
    expect(keysOf(overview.agents[0])).toEqual(keysOf(dashboardOverview.agents[0]))
    expect(keysOf(overview.transactions[0])).toEqual(keysOf(dashboardTransaction))
  })

  it('/accounting/providers, /accounting/connections, /accounting/feed/status align with the e2e constants', () => {
    const providers = API_MOCK_DEFAULTS['/accounting/providers'].providers
    expect(providers.map((p) => p.id)).toEqual(accountingProviders.map((p) => p.id))
    for (const [i, p] of providers.entries()) {
      expect(keysOf(p)).toEqual(keysOf(accountingProviders[i]))
    }

    const connection = API_MOCK_DEFAULTS['/accounting/connections'].connections[0]!
    expect(keysOf(connection)).toEqual(keysOf(accountingConnection))

    const feedStatus = API_MOCK_DEFAULTS['/accounting/feed/status']
    expect(keysOf(feedStatus)).toEqual(keysOf(accountingFeedStatus))
    expect(feedStatus.syncs.length).toBe(accountingFeedStatus.syncs.length)
    for (const [i, row] of feedStatus.syncs.entries()) {
      expect(keysOf(row)).toEqual(keysOf(accountingFeedStatus.syncs[i]))
    }
  })
})

/**
 * The e2e visual-gate copies of the `/analytics` overview fixtures are the
 * harness's OWN values, not a paraphrase of them (#3038).
 *
 * `analytics.visual.spec.ts` cannot import `scripts/screenshot.mjs` directly:
 * the harness is a CLI that reads `import.meta.url` at module scope, and
 * Playwright's own transform mis-compiles such a `.mjs` as CommonJS, so the
 * spec dies at collect time on `ReferenceError: exports is not defined in ES
 * module scope` (measured — a minimal `.mjs` with one `import.meta.url` read
 * reproduces it and the same file without it does not). The visual gate
 * therefore reads the two overviews from `e2e/fixtures/analytics-overview.ts`,
 * which is a SECOND encoding of a Haven-API response — the exact thing this
 * whole suite exists to police. The pin below is what makes that copy safe:
 * deep equality against the harness's exported keys, so a change to the single
 * declared shape reddens here instead of leaving the visual gate photographing
 * a response no backend can serve. A copy without its pin is the #2968 drift
 * class waiting to happen; this is the pin.
 *
 * Vitest transpiles `.mjs` itself, so this file can reach the harness keys the
 * Playwright spec cannot — the pin lives on the side of the wall that can.
 */
describe('the /analytics overview fixtures are the harness’s, verbatim (#3038)', () => {
  it('the populated overview is deep-equal to FIXTURE_ANALYTICS_OVERVIEW', () => {
    expect(analyticsOverview).toEqual(FIXTURE_ANALYTICS_OVERVIEW)
  })

  it('the empty overview is deep-equal to FIXTURE_ANALYTICS_OVERVIEW_EMPTY', () => {
    expect(analyticsOverviewEmpty).toEqual(FIXTURE_ANALYTICS_OVERVIEW_EMPTY)
  })

  it('the served failure is the harness’s httpError(503, …), status and body', () => {
    // `httpError()` returns a ScenarioHttpError instance, so deep equality
    // against a plain object would compare prototypes; compare the two fields
    // the Playwright route actually fulfils, which is what must agree.
    const harnessFailure = httpError(503, { error: 'Service Unavailable' })
    expect(analyticsOverviewFailure.status).toBe(harnessFailure.status)
    expect(analyticsOverviewFailure.body).toEqual(harnessFailure.body)
  })

  it('the error scenario is the 503 the analytics-error capture scenario sends', () => {
    // The capture harness reaches the same page through its own scenario key;
    // if this ever stops being true, the visual gate is photographing an
    // outage the evidence run does not have.
    const harnessFailure = httpError(503, { error: 'Service Unavailable' })
    expect(analyticsOverviewFailure.status).toBe(503)
    expect(harnessFailure.status).toBe(503)
  })
})
