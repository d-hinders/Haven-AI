/**
 * `index.ts` starts the background jobs from ONE entry point (#4764).
 *
 * This file used to prove the catalog-ingest monitor's lifetime by regexing
 * `index.ts`: the monitor had to be built once, outside the tick closure
 * (#4407). That wiring now lives in `src/background-jobs.ts`, which is
 * importable, so the lifetime is proven BEHAVIOURALLY in
 * `src/__tests__/background-jobs.test.ts` ("builds the catalog-ingest monitor
 * ONCE and holds it across ticks"). The source-scan assertions that used to
 * live here are replaced by that test, not dropped.
 *
 * What remains is the ONE accepted text pin on `index.ts` for jobs: it calls
 * `startBackgroundJobs(` exactly once. Importing `index.ts` builds a Fastify
 * app, opens a pool and starts timers, so a text pin is the only way to see
 * the composition root's own call.
 *
 * The stripping is TypeScript's own (`transpileModule` with
 * `removeComments`), not a regex. A block-comment regex run over this file
 * opened a fake block at the `/accounting/connections/*` text inside a line
 * comment and closed it at the next jsdoc, so about 35 lines of real code
 * vanished from the scan (#4410 review, cell R1). Only the parser knows where
 * a comment starts; the sanity test below pins statements from that region.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const INDEX = readFileSync(fileURLToPath(new URL('../../../index.ts', import.meta.url)), 'utf8')
const CODE = ts.transpileModule(INDEX, {
  compilerOptions: {
    removeComments: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText

describe('index.ts starts the background jobs from one entry point (#4764)', () => {
  it('the comment stripper keeps real code: no region of index.ts is swallowed', () => {
    // Statements from the stretch the old regex swallowed, and from either
    // side of it. If a stripper ever eats code again, these go red first.
    expect(CODE).toMatch(/await app\.register\(accountingConnectionsRoutes/)
    expect(CODE).toMatch(/registerConnector\(new AccountedConnector\(\)\)/)
    // The far end of that window: `start()` runs after the route and connector
    // registrations. This replaced the `CATALOG_INGEST_INTERVAL_MS` pin when
    // that constant moved to `background-jobs.ts` (#4764) — the control is
    // moved, not weakened.
    expect(CODE).toMatch(/await runMigrations\(\)/)
    // And comments really are gone.
    expect(CODE).not.toMatch(/#2862: provider-generic connections/)
  })

  it('calls startBackgroundJobs exactly once', () => {
    // Every call counts, whatever its arguments: a second call would start a
    // second copy of every timer.
    const calls = [...CODE.matchAll(/\bstartBackgroundJobs\s*\(/g)]
    expect(calls).toHaveLength(1)
  })
})
