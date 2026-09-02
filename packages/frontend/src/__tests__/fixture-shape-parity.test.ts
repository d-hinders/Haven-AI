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
