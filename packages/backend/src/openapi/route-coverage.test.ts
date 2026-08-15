/**
 * Route-coverage gate (#1443, epic #1442).
 *
 * `spec.test.ts` already proves that routes in SEVEN hand-listed files are
 * documented. This proves the harder property: **every route module the server
 * registers is accounted for** — documented, individually justified, or
 * explicitly deferred — with the deferral shrink-only.
 *
 * The difference matters because the old scope was itself a hand-maintained
 * list. A new route module (`hybrid-accounts.ts`, `agent-delegations.ts`,
 * `fortnox.ts` …) was invisible to the drift check purely by not being on it,
 * and 65% of the API ended up undocumented without a single gate going red.
 * This file derives its scope from `index.ts`'s registration table instead, so
 * a module is covered from its first commit.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openapiSpec } from './spec.js'
import {
  extractRoutes,
  fastifyPathToOpenApi,
  registeredRouteModules,
} from './route-inventory.js'
import {
  KNOWN_UNDOCUMENTED_ROUTES,
  MAX_UNDOCUMENTED_MODULES,
  MAX_UNDOCUMENTED_ROUTES,
  UNDOCUMENTED_MODULES,
} from './route-coverage.js'

type SpecPaths = Record<string, Record<string, unknown>>

function isDocumented(method: string, openapiPath: string): boolean {
  const entry = (openapiSpec.paths as SpecPaths)[openapiPath]
  return Boolean(entry) && method.toLowerCase() in entry
}

function isIndividuallyJustified(method: string, openapiPath: string): boolean {
  return KNOWN_UNDOCUMENTED_ROUTES.some((e) => e.method === method && e.path === openapiPath)
}

interface Surveyed {
  file: string
  prefix: string
  declared: number
  undocumented: Array<{ method: string; path: string }>
}

/** Read every registered module once; each test below reads this survey. */
async function surveyRegisteredRoutes(): Promise<Surveyed[]> {
  const modules = await registeredRouteModules()
  return Promise.all(
    modules.map(async ({ file, sourcePath, prefix }) => {
      const source = await readFile(sourcePath, 'utf8')
      const declared = extractRoutes(source)
      const undocumented = declared
        .map((r) => ({ method: r.method, path: fastifyPathToOpenApi(prefix, r.path) }))
        .filter((r) => !isDocumented(r.method, r.path) && !isIndividuallyJustified(r.method, r.path))
      return { file, prefix, declared: declared.length, undocumented }
    }),
  )
}

const deferredFiles = new Set(UNDOCUMENTED_MODULES.map((m) => m.file))

describe('route coverage — the gate sees every registered module (#1443)', () => {
  it('derives its scope from the app registration table, not a list in this file', async () => {
    const modules = await registeredRouteModules()

    // A parser that silently matches nothing would make every assertion below
    // vacuously pass — the failure mode this whole gate exists to prevent.
    expect(modules.length).toBeGreaterThan(20)
    expect(modules.some((m) => m.file === 'agents.ts' && m.prefix === '/agents')).toBe(true)
    // Mounted at the root, i.e. the prefix-less registration form parses too.
    expect(modules.some((m) => m.prefix === '')).toBe(true)
  })

  it('accounts for every registered route: documented, justified, or deferred', async () => {
    const survey = await surveyRegisteredRoutes()

    const unaccounted = survey
      .filter((s) => s.undocumented.length > 0 && !deferredFiles.has(s.file))
      .map((s) => `${s.file}: ${s.undocumented.map((r) => `${r.method} ${r.path}`).join(', ')}`)

    expect(
      unaccounted,
      'These routes are registered but neither documented in openapi/spec.ts, ' +
        'listed in KNOWN_UNDOCUMENTED_ROUTES with a reason, nor in a module ' +
        'deferred to #1446. Document them, or justify them — do not widen a ceiling.',
    ).toEqual([])
  })

  it('every deferred module still exists and is still undocumented', async () => {
    const survey = await surveyRegisteredRoutes()
    const byFile = new Map(survey.map((s) => [s.file, s]))

    const stale: string[] = []
    for (const { file } of UNDOCUMENTED_MODULES) {
      const entry = byFile.get(file)
      if (!entry) {
        stale.push(`${file} — deferred but no longer a registered route module`)
        continue
      }
      if (entry.undocumented.length === 0) {
        stale.push(`${file} — fully documented now; remove it from UNDOCUMENTED_MODULES`)
      }
    }

    // Keeps the deferral list honest in BOTH directions: an entry that has been
    // documented (or deleted) must leave, or the ceiling below stops meaning
    // anything.
    expect(stale, 'Stale entries in UNDOCUMENTED_MODULES.').toEqual([])
  })

  it('holds the undocumented surface shrink-only', async () => {
    const survey = await surveyRegisteredRoutes()
    const undocumentedRoutes =
      survey.reduce((n, s) => n + s.undocumented.length, 0) + KNOWN_UNDOCUMENTED_ROUTES.length

    expect(
      UNDOCUMENTED_MODULES.length,
      `Deferred modules grew past the ceiling (${MAX_UNDOCUMENTED_MODULES}). ` +
        'Document the new module instead of deferring it, or lower the ceiling in the same PR.',
    ).toBeLessThanOrEqual(MAX_UNDOCUMENTED_MODULES)

    expect(
      undocumentedRoutes,
      `Undocumented routes grew past the ceiling (${MAX_UNDOCUMENTED_ROUTES}). ` +
        'A new route must be documented in openapi/spec.ts.',
    ).toBeLessThanOrEqual(MAX_UNDOCUMENTED_ROUTES)
  })

  it('records the measured surface so the ratchet reflects reality', async () => {
    const survey = await surveyRegisteredRoutes()
    const declared = survey.reduce((n, s) => n + s.declared, 0)
    const undocumented =
      survey.reduce((n, s) => n + s.undocumented.length, 0) + KNOWN_UNDOCUMENTED_ROUTES.length

    // The recorded ceilings are the CURRENT numbers, not slack. If this fails
    // after a backfill, lower the ceilings in the same PR — that is the ratchet
    // tightening, and it is the only direction it may move.
    expect(declared).toBeGreaterThan(100)
    expect(undocumented).toBe(MAX_UNDOCUMENTED_ROUTES)
    expect(UNDOCUMENTED_MODULES.length).toBe(MAX_UNDOCUMENTED_MODULES)
  })
})
