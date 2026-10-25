/**
 * The catalog ingestion monitor is built ONCE in index.ts (#4407).
 *
 * The per-host probe cooldown lives inside `createCatalogIngestMonitor`.
 * Building the monitor inside the tick closure, or calling
 * `runCatalogIngestTick()` directly, gives every tick a fresh cooldown: it
 * then spans nothing, and a failing merchant is probed on every 5-minute tick.
 * That was the production wiring from #1714 to #4407, while every module test
 * injected its own shared cooldown and passed.
 *
 * A source assertion rather than a boot, the same shape as
 * `passport/__tests__/anchor-seams-wired.test.ts`: importing `index.ts` builds
 * a Fastify app, opens a pool and starts timers. Comments are stripped first,
 * so a call that survives only as a comment does not count.
 *
 * The stripping is TypeScript's own (`transpileModule` with
 * `removeComments`), not a regex. A block-comment regex run over this file
 * opened a fake block at the `/accounting/connections/*` text inside a line
 * comment and closed it at the next jsdoc, so about 35 lines of real code
 * vanished from the scan (#4410 review, cell R1). Only the parser knows where
 * a comment starts; the sanity test below pins a statement from that region.
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

describe('catalog ingestion monitor wiring in index.ts (#4407)', () => {
  it('the comment stripper keeps real code: no region of index.ts is swallowed', () => {
    // Statements from the stretch the old regex swallowed, and from either
    // side of it. If a stripper ever eats code again, these go red first.
    expect(CODE).toMatch(/await app\.register\(accountingConnectionsRoutes/)
    expect(CODE).toMatch(/registerConnector\(new AccountedConnector\(\)\)/)
    expect(CODE).toMatch(/const CATALOG_INGEST_INTERVAL_MS\s*=/)
    // And comments really are gone.
    expect(CODE).not.toMatch(/#2862: provider-generic connections/)
  })

  const create = /const\s+(\w+)\s*=\s*createCatalogIngestMonitor\s*\(\s*\)/g
  const created = [...CODE.matchAll(create)]

  it('builds the monitor exactly once', () => {
    expect(created).toHaveLength(1)
  })

  it('builds it BEFORE the tick closure, so it outlives every tick', () => {
    const closure = CODE.indexOf('const runCatalogIngest = async')
    expect(closure).toBeGreaterThan(-1)
    expect(created[0]!.index!).toBeLessThan(closure)
  })

  it('the leader-locked tick calls that monitor, not a bare runCatalogIngestTick', () => {
    const name = created[0]![1]
    const closure = CODE.slice(CODE.indexOf('const runCatalogIngest = async'))
    const body = closure.slice(0, closure.indexOf('setInterval(runCatalogIngest'))
    expect(body).toMatch(/runIfLeader\(\s*LEADER_LOCK_KEYS\.catalogIngest/)
    expect(body).toMatch(new RegExp(`\\b${name}\\.tick\\(\\s*\\)`))
    expect(CODE).not.toMatch(/\brunCatalogIngestTick\s*\(/)
  })
})
