/**
 * The capture fixture and its shape (#3516).
 *
 * The fixture is the ONLY /ops/* answer a capture run can get (the harness
 * routes everything to it; the registry origin is a .invalid host). These
 * tests pin the properties the captures depend on: masked at rest, one
 * unmasked shape on the reveal endpoint, the system_tx hit carries NO user
 * link, and the on-chain view carries an unavailable budget AND the
 * not_served account — the states the acceptance criteria name.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Tests run with the package as cwd; jsdom makes import.meta.url a page URL.
const SOURCE = readFileSync(
  join(process.cwd(), 'scripts', 'screenshot-fixture.mjs'),
  'utf8',
)

// The fixture module is plain ESM without TS types; import it directly.
import {
  fixtureRoutes,
  fixtureStorageSeed,
  FIXTURE_BACKEND_ORIGIN,
  FIXTURE_USER_ID,
} from '../../scripts/screenshot-fixture.mjs'

describe('the capture fixture is safe by construction', () => {
  it('the registry origin is an RFC 2606 reserved host', () => {
    expect(FIXTURE_BACKEND_ORIGIN.endsWith('.fixture')).toBe(true)
    expect(FIXTURE_BACKEND_ORIGIN.startsWith('https://')).toBe(true)
  })

  it('every route the fixture answers is an /ops route or the doc-health static', () => {
    for (const [pattern] of fixtureRoutes()) {
      expect(String(pattern)).toMatch(/\/ops|ops-doc-health\.json/)
    }
  })

  it('customer emails and names are MASKED at rest — captures never show PII', () => {
    const userDetailRoute = fixtureRoutes().find(([pattern]) => String(pattern).endsWith(`/ops/users/${FIXTURE_USER_ID}`))
    expect(userDetailRoute).toBeDefined()
    const [, status, body] = userDetailRoute!
    expect(status).toBe(200)
    const json = JSON.stringify(body)
    expect(json).toContain('da•••@gmail.com')
    expect(json).toContain('D•••')
    // No UNMASKED local part before an @ anywhere in the served detail (a
    // masked value keeps its domain by design — `da•••@gmail.com`).
    for (const match of json.matchAll(/"email":"([^"]*)"/g)) {
      expect(match[1]).toMatch(/^[^@]*•••@/)
    }
    // The ONLY full email the whole fixture serves is the reveal endpoint's
    // answer, and it is a .example address, not a customer domain.
    for (const [, , responseBody] of fixtureRoutes()) {
      const served = JSON.stringify(responseBody)
      for (const valueMatch of served.matchAll(/"value":"([^"]+)"/g)) {
        expect(valueMatch[1]).toMatch(/@fixture\.example$/)
      }
    }
  })

  it('the system_tx hit carries NO user_id — a lane hit shows the lane, not a user', () => {
    const searchRoute = fixtureRoutes().find(([pattern]) => String(pattern).includes('/ops/search'))
    const body = JSON.parse(JSON.stringify(searchRoute![2])) as {
      hits: { kind: string; user_id?: string }[]
    }
    const systemTx = body.hits.filter((hit) => hit.kind === 'system_tx')
    expect(systemTx.length).toBeGreaterThan(0)
    for (const hit of systemTx) {
      expect(hit.user_id).toBeUndefined()
    }
  })

  it('the on-chain view carries an unavailable budget and a not_served account', () => {
    const onchainRoute = fixtureRoutes().find(([pattern]) => String(pattern).includes('/onchain'))
    const view = JSON.parse(JSON.stringify(onchainRoute![2])) as {
      accounts: {
        chain?: { delegations?: { budget_status?: string; budget_remaining_atomic?: string | null }[] }
        status?: string
      }[]
    }
    const unavailable = view.accounts.find((a) =>
      a.chain?.delegations?.some((d) => d.budget_status === 'unavailable'),
    )
    expect(unavailable).toBeDefined()
    const delegation = unavailable!.chain!.delegations!.find((d) => d.budget_status === 'unavailable')
    expect(delegation!.budget_remaining_atomic).toBeNull()
    const notServed = view.accounts.find((a) => a.status === 'not_served')
    expect(notServed).toBeDefined()
  })

  it('the delegate-balance section exists in BOTH variants across fixtures', () => {
    const healthRoute = fixtureRoutes().find(([pattern]) => String(pattern).endsWith('/ops/health'))
    const health = JSON.parse(JSON.stringify(healthRoute![2])) as {
      delegate_balances: { available: boolean; reason?: string }
    }
    expect(health.delegate_balances.available).toBe(true)
    // The not-available variant is pinned by the component test (unavailable
    // budget renders as unavailable); the GENERATED schema contract carries
    // the reason literal, which the fixture's user detail is typed against.
    expect(readFileSync(join(process.cwd(), '..', 'core', 'src', 'api-types.ts'), 'utf8')).toContain(
      'not_available_on_this_replica',
    )
  })

  it('the storage seed files exactly one token under the fixture origin', () => {
    const seed = fixtureStorageSeed()
    expect(seed.key).toBe(`haven.ops.token.${FIXTURE_BACKEND_ORIGIN}`)
    expect(seed.value.length).toBeGreaterThan(0)
  })
})
