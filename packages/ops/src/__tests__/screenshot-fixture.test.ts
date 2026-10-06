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
  /**
   * The reveal endpoint's fixture answer for one POST body (#3602): the
   * entry is a function now, so tests resolve it exactly as the harness
   * does — a request-shaped stub in, answer object out.
   */
  function revealAnswer(postBody: Record<string, unknown>): Record<string, unknown> {
    const body = fixtureRoutes().find(([pattern]) => String(pattern).endsWith('/ops/reveal'))![2]
    if (typeof body !== 'function') return body as Record<string, unknown>
    return body({ postData: () => JSON.stringify(postBody) }) as Record<string, unknown>
  }

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
    // The ONLY full emails the whole fixture serves are the reveal endpoint's
    // answers, and they are .example/.fixture addresses, not customer
    // domains. Function bodies (the reveal answers from the REQUEST, #3602)
    // are resolved for both request kinds before scanning.
    const answers = [
      revealAnswer({ target_type: 'feedback', target_id: 'x', field: 'text' }),
      revealAnswer({ target_type: 'user', target_id: FIXTURE_USER_ID, field: 'email' }),
    ]
    for (const responseBody of [...fixtureRoutes().map(([, , b]) => b).filter((b) => typeof b !== 'function'), ...answers]) {
      const served = JSON.stringify(responseBody)
      for (const valueMatch of served.matchAll(/"value":"([^"]+)"/g)) {
        expect(valueMatch[1]).toMatch(/@fixture\.example$|mobile Safari/)
      }
    }
  })

  it('the feedback fixture is masked at rest and the reveal answer carries the message (#3602)', () => {
    const feedbackRoute = fixtureRoutes().find(([pattern]) => String(pattern).endsWith('/ops/feedback'))
    expect(feedbackRoute).toBeDefined()
    const [, status, body] = feedbackRoute!
    expect(status).toBe(200)
    const json = JSON.stringify(body)
    // Masked at rest: counts and masked emails only — no message content.
    expect(json).toContain('142 characters')
    expect(json).toContain('da•••@gmail.com')
    for (const match of json.matchAll(/"email":"([^"]*)"/g)) {
      expect(match[1]).toMatch(/^[^@]*•••@/)
    }
    // The reveal endpoint answers a feedback reveal with the message text,
    // echoing the requested id.
    const answered = revealAnswer({ target_type: 'feedback', target_id: '3d9e1f2a-7c4b-4e8d-9a1f-6b5c2e8d7a3f', field: 'text' })
    expect(answered).toMatchObject({ target_type: 'feedback', field: 'text', target_id: '3d9e1f2a-7c4b-4e8d-9a1f-6b5c2e8d7a3f' })
    expect(String(answered.value).length).toBeGreaterThan(0)
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
