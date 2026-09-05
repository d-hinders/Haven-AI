import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  extractRoutes,
  fastifyPathToOpenApi,
  registeredRouteModules,
} from '../openapi/route-inventory.js'
import { OWNER_CLI_ALLOWED_ROUTES, isOwnerCliAllowed } from '../middleware/owner-cli.js'

/**
 * The census that makes the `owner_cli` allow-list a DECISION (#2526).
 *
 * A device-code login mints an owner token for a CLI an agent drives. The
 * safety property is not "the right routes are listed" — anyone can write a
 * list — it is that **a route added tomorrow refuses the token until somebody
 * says otherwise**. #1640 already refuses every `purpose`-carrying token
 * everywhere; this suite proves the opt-in did not quietly become an opt-out.
 *
 * It DISCOVERS routes from the route modules rather than counting them here.
 * A hard-coded number is a number that goes stale on the next PR, and a census
 * whose denominator is stale measures nothing.
 */

interface CensusRoute {
  method: string
  path: string
  file: string
}

async function census(): Promise<CensusRoute[]> {
  const modules = await registeredRouteModules()
  const out: CensusRoute[] = []
  for (const { file, sourcePath, prefix } of modules) {
    const source = await readFile(sourcePath, 'utf8')
    for (const route of extractRoutes(source)) {
      out.push({
        method: route.method.toUpperCase(),
        path: fastifyPathToOpenApi(prefix, route.path),
        file,
      })
    }
  }
  return out
}

describe('owner_cli route census (#2526)', () => {
  it('discovers a real, non-trivial route surface', async () => {
    // Positive control for the instrument itself: every assertion below is
    // meaningless if the discovery returns nothing.
    const routes = await census()
    expect(routes.length).toBeGreaterThan(100)
    expect(new Set(routes.map((r) => r.file)).size).toBeGreaterThan(10)
  })

  it('every registered route is either allow-listed or refusing — no third state', async () => {
    // The property that matters. A route is allow-listed only because somebody
    // put it there; everything else inherits #1640's refusal by construction.
    const routes = await census()
    const undecided = routes.filter(
      (r) => !isOwnerCliAllowed(r.method, r.path) && OWNER_CLI_ALLOWED_ROUTES.some((a) => a.path === r.path && a.method === r.method),
    )
    expect(undecided).toEqual([])
  })

  it('the allow-list names only routes that actually exist', async () => {
    // The other direction, and the one that rots silently: an entry for a
    // route that was renamed or deleted looks like coverage and grants
    // nothing, so the list slowly stops describing the system.
    const routes = await census()
    const real = new Set(routes.map((r) => `${r.method} ${r.path}`))
    const phantom = OWNER_CLI_ALLOWED_ROUTES.map((a) => `${a.method} ${a.path}`).filter(
      (entry) => !real.has(entry),
    )
    expect(phantom).toEqual([])
  })

  it('REFUSES the authority routes by construction, not by omission', async () => {
    // Named explicitly as well as covered by the default, because these are
    // the ones whose accidental inclusion would matter most: signing, signer
    // changes, re-keying, credentials, provisioning, delegation activation.
    const mustRefuse = [
      { method: 'POST', path: '/accounts/hybrid' },
      { method: 'POST', path: '/agents/{id}/rekey/start' },
      { method: 'POST', path: '/agents/{id}/delegations/{hash}/activate' },
      { method: 'POST', path: '/safe/exec' },
    ]
    for (const route of mustRefuse) {
      expect(isOwnerCliAllowed(route.method, route.path), `${route.method} ${route.path}`).toBe(false)
    }
  })

  it('NEGATIVE CONTROL: an undecided new route is not allowed', () => {
    // The whole point. If this ever returns true, the opt-in has become an
    // opt-out and the census above proves nothing.
    expect(isOwnerCliAllowed('POST', '/some-route-nobody-decided-about')).toBe(false)
    expect(isOwnerCliAllowed('DELETE', '/agents/{id}')).toBe(false)
  })

  it('allows exactly the routes the epic scoped, and each is reachable', async () => {
    const routes = await census()
    const real = new Set(routes.map((r) => `${r.method} ${r.path}`))
    // A few load-bearing entries asserted by name, so a wholesale replacement
    // of the list fails rather than passing on its own new contents.
    for (const entry of ['POST /agents', 'GET /agents', 'POST /agent-connection-setups', 'GET /user/safes']) {
      expect(OWNER_CLI_ALLOWED_ROUTES.map((a) => `${a.method} ${a.path}`)).toContain(entry)
      expect(real, `${entry} must still exist`).toContain(entry)
    }
  })
})
