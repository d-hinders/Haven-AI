import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  extractRoutes,
  fastifyPathToOpenApi,
  registeredRouteModules,
  stripCommentsOutsideStrings,
} from '../openapi/route-inventory.js'
import {
  OWNER_CLI_ALLOWED_ROUTES,
  isOwnerCliAllowed,
  routeAllowsOwnerCli,
} from '../middleware/owner-cli.js'
import type { FastifyRequest } from 'fastify'

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
 *
 * ## What this file learned the hard way
 *
 * Its headline assertion used to read, in effect, `!isOwnerCliAllowed(r) &&
 * OWNER_CLI_ALLOWED_ROUTES.some(matches r)`. Since `isOwnerCliAllowed` IS
 * `OWNER_CLI_ALLOWED_ROUTES.some(...)`, that is `!X && X` — always empty, for
 * any list and any census, including an empty one. It was the load-bearing
 * claim in three documents and it could not fail. Two independent reviewers
 * caught it; nothing in the suite did.
 *
 * The lesson is sharper than "that predicate was wrong": **a test written in
 * terms of the thing it is checking cannot check it.** Everything below is
 * therefore phrased against something the allow-list does not define —
 * the enforcement function that reads it, the auth wiring of the real modules,
 * or an independent opinion about which path SHAPES are authority. Each of the
 * four has a mutation recorded in the PR that makes it go red.
 */

interface CensusRoute {
  method: string
  /** OpenAPI shape, e.g. `/agents/{id}` — what the allow-list is written in. */
  path: string
  /** Fastify shape, e.g. `/agents/:id` — what `request.routeOptions.url` is. */
  fastifyUrl: string
  file: string
  /** How firmly `authMiddleware` gates this route. */
  gate: Gate
}

/**
 * Which registrations `authMiddleware` actually gates.
 *
 * Two shapes in this codebase: a module-wide `addHook`, or `authMiddleware` in
 * one route's own options. Anything else — `agent-connection-setups.ts`'s
 * `authenticateConnectorStatusRequest`, which demands a literal `sk_agent_...`
 * key — is a DIFFERENT door, and a route behind a different door cannot be
 * granted or refused by the `owner_cli` opt-in at all.
 */
type Gate = 'none' | 'conditional' | 'full'

/**
 * Which registrations `authMiddleware` actually gates, and how firmly.
 *
 * Three shapes in this codebase: a module-wide `addHook`, `authMiddleware` in
 * one route's own options, or a DIFFERENT door entirely —
 * `agent-connection-setups.ts`'s `authenticateConnectorStatusRequest`, which
 * demands a literal `sk_agent_...` key. A route behind a different door cannot
 * be granted or refused by the `owner_cli` opt-in at all.
 *
 * `conditional` is the third answer, and it exists because the second review
 * round caught this function getting it wrong. A module hook is not always
 * `authMiddleware` by name: `catalog.ts` hangs `eitherAuth` on the hook, which
 * lets an anonymous public read through and DELEGATES to `authMiddleware` for
 * everything else. Following the name and asking "does `authMiddleware` appear
 * in there" answers YES for that wrapper — and would answer yes just as
 * happily for a wrapper whose carve-out excluded far more. Substring presence
 * is not control flow. So a wrapper that can return before it reaches
 * `authMiddleware` is reported `conditional`, and the test below refuses to
 * accept that as gating unless somebody has written down why.
 */
function authGateMap(source: string): Gate[] {
  const text = stripCommentsOutsideStrings(source)

  let moduleGate: Gate = 'none'
  for (const [, hook] of text.matchAll(
    /addHook\(\s*['"](?:onRequest|preHandler)['"]\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)/g,
  )) {
    if (hook === 'authMiddleware') {
      moduleGate = 'full'
      break
    }
    const defined = new RegExp(`(?:function\\s+${hook}\\b|(?:const|let)\\s+${hook}\\s*[:=])`).exec(text)
    if (!defined) continue
    const body = text.slice(defined.index, defined.index + 1500)
    const authAt = body.indexOf('authMiddleware')
    if (authAt < 0) continue
    // A `return` reachable before `authMiddleware` is a carve-out: some
    // requests never meet the middleware at all.
    const bypasses = /(?:^|[^A-Za-z0-9_$])return(?![A-Za-z0-9_$])/.test(body.slice(0, authAt))
    moduleGate = bypasses ? 'conditional' : 'full'
    if (moduleGate === 'full') break
  }

  const re = new RegExp(
    `\\b[A-Za-z_$][A-Za-z0-9_$]*\\.(get|post|put|patch|delete)[^'"\`(]*\\(\\s*(['"\`])([^'"\`]+)\\2`,
    'g',
  )
  const starts: number[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) starts.push(match.index)

  return starts.map((start, i) => {
    if (moduleGate !== 'none') return moduleGate
    // The options object follows the path immediately. Bound the window at the
    // next registration so one route's `preHandler` cannot be credited to its
    // neighbour, and at 500 characters so the last route in a file does not
    // absorb the rest of the module.
    const end = Math.min(starts[i + 1] ?? text.length, start + 500)
    return text.slice(start, end).includes('authMiddleware') ? 'full' : 'none'
  })
}

async function census(): Promise<CensusRoute[]> {
  const modules = await registeredRouteModules()
  const out: CensusRoute[] = []
  for (const { file, sourcePath, prefix } of modules) {
    const source = await readFile(sourcePath, 'utf8')
    const gates = authGateMap(source)
    extractRoutes(source).forEach((route, i) => {
      out.push({
        method: route.method.toUpperCase(),
        path: fastifyPathToOpenApi(prefix, route.path),
        fastifyUrl: (prefix + (route.path === '/' ? '' : route.path)).replace(/\/+/g, '/') || '/',
        file,
        gate: gates[i] ?? 'none',
      })
    })
  }
  return out
}

/** What `authMiddleware` will actually ask about this route, at the door. */
function asRequest(route: CensusRoute): FastifyRequest {
  return {
    method: route.method,
    routeOptions: { url: route.fastifyUrl, config: {} },
  } as unknown as FastifyRequest
}

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`

describe('owner_cli route census (#2526)', () => {
  it('discovers a real, non-trivial route surface', async () => {
    // Positive control for the instrument itself: every assertion below is
    // meaningless if the discovery returns nothing.
    const routes = await census()
    expect(routes.length).toBeGreaterThan(100)
    expect(new Set(routes.map((r) => r.file)).size).toBeGreaterThan(10)
    // And the gate detector must be able to say BOTH words. If it answered
    // `true` for everything, the auth-gating test below would pass vacuously.
    expect(routes.some((r) => r.gate === 'full')).toBe(true)
    expect(routes.some((r) => r.gate === 'none')).toBe(true)
  })

  it('the ENFORCEMENT allows exactly the listed routes — measured through the door', async () => {
    // Phrased against `routeAllowsOwnerCli`, the function `authMiddleware`
    // actually calls, and fed the Fastify-shaped url a live request carries.
    // That makes it a real check rather than a restatement of the list: the
    // list is written in the OpenAPI shape (`{id}`) and the enforcement has to
    // normalise `:id` to reach it. A route registered as `/agents/:agentId`
    // would normalise to `/agents/{agentId}` and match no entry, so a list
    // entry naming `/agents/{id}` would grant nothing — the exact "reads like
    // coverage, grants nothing" failure the list must not have.
    const routes = await census()
    const allowedByEnforcement = routes.filter((r) => routeAllowsOwnerCli(asRequest(r))).map(key)

    expect(new Set(allowedByEnforcement)).toEqual(new Set(OWNER_CLI_ALLOWED_ROUTES.map(key)))
    // Every entry reachable, and reachable once: a duplicate entry or two
    // registrations of one path would make the counts disagree.
    expect(allowedByEnforcement.length).toBe(OWNER_CLI_ALLOWED_ROUTES.length)
  })

  it('every allow-listed route is actually behind authMiddleware', async () => {
    // The check that found the dead entry. `GET /agent-connection-setups/
    // {setupId}/connector-status` was listed but is gated by an agent-API-key
    // check that never consults `purpose`, so the entry could neither grant
    // nor refuse anything — it was decoration that read as a decision.
    //
    // It also closes a hole in the census's METHOD: source-text discovery
    // cannot otherwise tell "gated by authMiddleware" from "a path that
    // happens to match", so an entry naming a route behind a looser door
    // would sail through every other test in this file.
    const routes = await census()
    const byKey = new Map(routes.map((r) => [key(r), r]))
    // A route whose module gates CONDITIONALLY has to be acknowledged by name.
    // `catalog.ts`'s hook lets an anonymous public read past without meeting
    // `authMiddleware` at all, so "it is behind auth" is true of some requests
    // and false of others — a distinction a substring search cannot make and
    // this list must not paper over.
    const CONDITIONAL_OK = new Map([
      [
        'GET /catalog',
        'catalog.ts gates with `eitherAuth`, which lets an anonymous PUBLIC read ' +
          'past. Granting owner_cli here grants nothing an unauthenticated caller ' +
          'does not already have, so the carve-out cannot widen this entry.',
      ],
    ])
    const notBehindAuth = OWNER_CLI_ALLOWED_ROUTES.map(key).filter((entry) => {
      const gate = byKey.get(entry)?.gate
      if (gate === 'full') return false
      if (gate === 'conditional') return !CONDITIONAL_OK.has(entry)
      return true
    })
    expect(notBehindAuth).toEqual([])
    // And the acknowledgements must stay live: one naming a route that is no
    // longer conditional is a stale exemption, which is how a carve-out list
    // turns back into decoration.
    const staleAck = [...CONDITIONAL_OK.keys()].filter(
      (entry) => byKey.get(entry)?.gate !== 'conditional',
    )
    expect(staleAck).toEqual([])
  })

  it('the allow-list names only routes that actually exist', async () => {
    // The other direction, and the one that rots silently: an entry for a
    // route that was renamed or deleted looks like coverage and grants
    // nothing, so the list slowly stops describing the system.
    const routes = await census()
    const real = new Set(routes.map(key))
    const phantom = OWNER_CLI_ALLOWED_ROUTES.map(key).filter((entry) => !real.has(entry))
    expect(phantom).toEqual([])
  })

  it('no AUTHORITY-shaped path is on the list — an independent second opinion', () => {
    // The list is a human decision, so no test can object to a considered
    // entry. What it CAN do is refuse the shapes that are never a reading or
    // an arrangement, whoever adds them and however the list is rewritten.
    //
    // This is deliberately not derived from the list — it is a property of the
    // path itself — which is what lets it fail. Adding `PUT /user`,
    // `POST /passkeys/register` or `POST /agents/{id}/rekey/start` to the list
    // goes red here without anyone remembering to extend a fixture.
    const forbidden: [RegExp, string][] = [
      [/rekey/i, 're-keying an agent'],
      [/passkey/i, 'passkey management'],
      [/signers?(\/|$)/i, 'signer-set changes'],
      [/\/activate$/i, 'delegation activation'],
      // Build and revoke, not only activate. `owner-cli.ts` and the security
      // model both name "delegation build/activate/revoke" as the forbidden
      // class, and the first cut of this list only caught activate — so five
      // real routes in `agent-delegations.ts` (`/delegations/build`,
      // `/delegations/{hash}/revoke`, `.../revoke/submit`, `/revoke-all`,
      // `/revoke-all/submit`) could have been added without this firing.
      [/\/delegations\/(build|revoke)/i, 'building or revoking a delegation'],
      [/\/revoke-all/i, 'revoking delegations wholesale'],
      [/\/safe\/exec/i, 'arbitrary Safe execution'],
      [/password|credentials/i, 'credential changes'],
      [/^\/accounts/i, 'account provisioning'],
      [/sweep|payments|x402|machine-payments/i, 'moving funds'],
    ]
    const violations: string[] = []
    for (const entry of OWNER_CLI_ALLOWED_ROUTES) {
      for (const [pattern, why] of forbidden) {
        if (pattern.test(entry.path)) violations.push(`${key(entry)} — ${why}`)
      }
      // `/user/...` reads are fine; writes to the user record are not.
      if (/^\/user(\/|$)/.test(entry.path) && entry.method !== 'GET') {
        violations.push(`${key(entry)} — writing to the user record`)
      }
      // `/auth/...` is the door itself. `GET /auth/me` is the one read a CLI
      // needs; everything else there mints, approves or changes a session —
      // including `POST /auth/device/approve`, which would let one CLI session
      // approve the next one and turn a single approval into an open tap.
      if (/^\/auth(\/|$)/.test(entry.path) && key(entry) !== 'GET /auth/me') {
        violations.push(`${key(entry)} — the authentication surface`)
      }
    }
    expect(violations).toEqual([])
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
      { method: 'POST', path: '/auth/device/approve' },
    ]
    for (const route of mustRefuse) {
      expect(isOwnerCliAllowed(route.method, route.path), key(route)).toBe(false)
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
    const real = new Set(routes.map(key))
    // A few load-bearing entries asserted by name, so a wholesale replacement
    // of the list fails rather than passing on its own new contents.
    for (const entry of [
      'POST /agents',
      'GET /agents',
      'POST /agent-connection-setups',
      'GET /user/safes',
    ]) {
      expect(OWNER_CLI_ALLOWED_ROUTES.map(key)).toContain(entry)
      expect(real, `${entry} must still exist`).toContain(entry)
    }
  })
})
