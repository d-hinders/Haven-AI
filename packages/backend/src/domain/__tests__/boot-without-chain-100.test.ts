/**
 * #3642 (epic #3634, Gnosis removal 2b-i) — the backend's route and worker
 * modules load with chain 100 gone from the registry.
 *
 * `domain/tokens.ts` used to export two legacy chain-100 token maps
 * (`getSupportedTokens(100)` and `getChain(100).tokenByAddress`), both
 * evaluated at MODULE LOAD: deleting `CHAIN_REGISTRY[100]` would have crashed
 * the backend at boot. This file deletes the entry BEFORE any backend module is
 * imported (the setup files import no backend module), then loads:
 *   - every `routes/*.ts` module, which pulls in the domain, modules, infra and
 *     rails layers they depend on;
 *   - the background workers and middleware that `src/index.ts` wires but no
 *     route imports (WORKER_ROOTS below).
 * A new load-time chain-100 read anywhere on that graph fails here, by name,
 * before slice 2e removes the registry entry. `src/index.ts` itself is not
 * loaded: it starts the server and its timers.
 *
 * The imports run in `beforeAll` (the hook budget), never in a test body: a
 * cold module-graph load costs seconds under a full suite, and the per-test
 * 5 s budget would turn a slow runner into a false red (#2329). Each module
 * still reports by name through its settled result.
 *
 * Vitest isolates module state per test file, so the deletion cannot leak into
 * another suite.
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHAIN_REGISTRY } from '@haven_ai/core'

const saved = CHAIN_REGISTRY[100]
delete CHAIN_REGISTRY[100]

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROUTES = join(SRC, 'routes')
const MIDDLEWARE = join(SRC, 'middleware')
const isModule = (f: string) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')

const routeModules = readdirSync(ROUTES).filter(isModule).map((f) => `routes/${f}`)
const WORKER_ROOTS = [
  'domain/tokens.ts',
  'infra/outbound-bump-worker.ts',
  'infra/delegate-balance-monitor.ts',
  'infra/chain/batched-token-balances.ts',
  'modules/ops/onchain-readers.ts',
  ...readdirSync(MIDDLEWARE).filter(isModule).map((f) => `middleware/${f}`),
]
const ALL = [...routeModules, ...WORKER_ROOTS]

const loaded = new Map<string, PromiseSettledResult<unknown>>()

describe('#3642 — route and worker modules load with chain 100 gone from the registry', () => {
  beforeAll(async () => {
    const results = await Promise.allSettled(ALL.map((rel) => import(join(SRC, rel))))
    ALL.forEach((rel, i) => loaded.set(rel, results[i]!))
  }, 120_000)

  afterAll(() => {
    if (saved) CHAIN_REGISTRY[100] = saved
  })

  it('the deletion is live, and the scan has a real population', () => {
    expect(100 in CHAIN_REGISTRY).toBe(false)
    expect(routeModules.length).toBeGreaterThan(30)
    expect(loaded.size).toBe(ALL.length)
  })

  it.each(ALL)('%s loads', (rel) => {
    const result = loaded.get(rel)!
    expect(result.status === 'rejected' ? String((result as PromiseRejectedResult).reason) : 'loaded').toBe('loaded')
  })
})
