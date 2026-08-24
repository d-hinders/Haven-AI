/**
 * The QA seed may only call routes this API still serves (#2007, epic #1440).
 *
 * `packages/qa-agent/src/seed.ts` bootstraps the dev QA identity that `qa-dev`
 * runs against, and `qa-dev` feeds the `qa-freshness` gate on `dev → main`.
 * When #1984 closed the Safe inflow, the seed kept calling `POST /user/safes` —
 * which had started answering 410 — and nothing noticed for a week, because the
 * dead call sat behind a reuse branch that only a **fresh** QA account reaches.
 * The failure mode was therefore: everything looks fine until someone needs a
 * clean QA run at exactly the moment they are trying to promote.
 *
 * This guard closes that specific hole. It lives in `packages/backend` rather
 * than in `packages/qa-agent` on purpose: the backend is where routes get
 * retired, so the next retirement slice runs this test as a matter of course
 * instead of having to remember another package exists.
 *
 * **What it can and cannot see.** It reads the seed's call sites statically and
 * checks them against the app's own registration table, so it catches the two
 * ways a route has actually been retired here: a `retired*()` symbol named
 * immediately after the path in the registration, and outright deletion of the
 * registration.
 *
 * The first rule is deliberately shaped around the POSITION rather than the
 * role, because the role has already moved once. #1984 passed
 * `retiredSafeInflow(kind)` as a route OPTION with the original handler still
 * behind it; #1988 deleted those handlers and passed
 * `retiredSafeInflowHandler(kind)` as the handler ITSELF. Both spellings put
 * the symbol in the same argument slot, so both match — but that was
 * re-checked by mutation after the #1988 merge, not assumed.
 *
 * It does NOT see a handler that returns 410 from its own body with no such
 * marker, and it says nothing about whether a live route still behaves the way
 * the seed needs. It is a liveness check on the seed's route surface, not a
 * contract test.
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BACKEND_SRC,
  extractRoutes,
  fastifyPathToOpenApi,
  registeredRouteModules,
  stripCommentsOutsideStrings,
} from './route-inventory.js'

const SEED_PATH = join(BACKEND_SRC, '..', '..', 'qa-agent', 'src', 'seed.ts')

/**
 * Collapse every path parameter to one spelling so the seed's template
 * literals (`/agents/${agentId}/delegations`) and the app's Fastify params
 * (`/agents/:id/delegations`) compare as equal.
 */
function normalize(path: string): string {
  return path.replace(/\$\{[^}]*\}/g, '{param}').replace(/\{[^}]*\}/g, '{param}')
}

/**
 * Every `api(cfg, 'METHOD', '<path>')` call in the seed. The leading
 * `[^('"\`]*` consumes an optional generic type argument without needing a
 * brace balancer, the same trick `extractRoutes` uses on the app side.
 */
function extractSeedCalls(source: string): string[] {
  const re = /\bapi[^('"`]*\(\s*cfg\s*,\s*(['"`])([A-Z]+)\1\s*,\s*(['"`])([^'"`]+)\3/g
  const calls = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = re.exec(stripCommentsOutsideStrings(source))) !== null) {
    calls.add(`${match[2]} ${normalize(match[4])}`)
  }
  return [...calls].sort()
}

/** Routes whose registration names a `retired*()` symbol after the path — permanently gone. */
function extractRetiredRoutes(source: string): { method: string; path: string }[] {
  const re =
    /\.(get|post|put|patch|delete)[^'"`(]*\(\s*(['"`])([^'"`]+)\2\s*,\s*retired[A-Za-z]*\(/g
  const routes: { method: string; path: string }[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(stripCommentsOutsideStrings(source))) !== null) {
    routes.push({ method: match[1].toUpperCase(), path: match[3] })
  }
  return routes
}

async function readModules(): Promise<
  { live: Set<string>; retired: Set<string> }
> {
  const live = new Set<string>()
  const retired = new Set<string>()
  for (const mod of await registeredRouteModules()) {
    const source = await readFile(mod.sourcePath, 'utf8')
    for (const r of extractRoutes(source)) {
      live.add(`${r.method} ${normalize(fastifyPathToOpenApi(mod.prefix, r.path))}`)
    }
    for (const r of extractRetiredRoutes(source)) {
      retired.add(`${r.method} ${normalize(fastifyPathToOpenApi(mod.prefix, r.path))}`)
    }
  }
  return { live, retired }
}

describe('the QA seed only calls routes the API still serves', () => {
  it('finds the seed API call sites — positive control that the extractor can say yes', async () => {
    const calls = extractSeedCalls(await readFile(SEED_PATH, 'utf8'))
    // A "no dead routes" verdict over an EMPTY set is the vacuous pass this
    // guard exists to avoid, so name two calls the seed provably makes.
    expect(calls).toContain('POST /accounts/hybrid')
    expect(calls).toContain('GET /auth/me')
    expect(calls.length).toBeGreaterThanOrEqual(7)
  })

  it('finds the retired routes — positive control that the retirement detector can say yes', async () => {
    const { retired } = await readModules()
    // #1984 closed these; if the detector stops seeing them it has gone blind,
    // and the "seed calls nothing retired" test below would pass vacuously.
    expect(retired).toContain('POST /user/safes')
    expect(retired).toContain('POST /safe/deploy')
  })

  it('calls no route the backend has retired', async () => {
    const calls = extractSeedCalls(await readFile(SEED_PATH, 'utf8'))
    const { retired } = await readModules()
    const dead = calls.filter((c) => retired.has(c))
    expect(
      dead,
      `packages/qa-agent/src/seed.ts calls retired route(s): ${dead.join(', ')}. ` +
        `A retired route answers HTTP 410, so the seed cannot bootstrap a FRESH QA ` +
        `account — which is what qa-dev needs before it can gate a dev → main promotion.`,
    ).toEqual([])
  })

  it('calls only routes the backend still registers', async () => {
    const calls = extractSeedCalls(await readFile(SEED_PATH, 'utf8'))
    const { live } = await readModules()
    const missing = calls.filter((c) => !live.has(c))
    expect(
      missing,
      `packages/qa-agent/src/seed.ts calls route(s) the app does not register: ` +
        `${missing.join(', ')}. Either the route was deleted or the seed's path is wrong.`,
    ).toEqual([])
  })
})
