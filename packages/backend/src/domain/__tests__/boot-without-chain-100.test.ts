/**
 * #3642 (epic #3634, Gnosis removal 2b-i) — the backend's modules load with
 * chain 100 gone from the registry.
 *
 * `domain/tokens.ts` used to export `SUPPORTED_TOKENS = getSupportedTokens(100)`
 * and `TOKEN_BY_ADDRESS = getChain(100).tokenByAddress`, both evaluated at
 * MODULE LOAD: deleting `CHAIN_REGISTRY[100]` would have crashed the backend at
 * boot. This file deletes the entry BEFORE any backend module is imported and
 * then loads every route module — which pulls in the domain, modules, infra and
 * rails layers they depend on — so a new load-time chain-100 read anywhere on
 * that graph fails here, by name, before slice 2e removes the registry entry.
 *
 * Vitest isolates module state per test file, so the deletion cannot leak into
 * another suite.
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { CHAIN_REGISTRY } from '@haven_ai/core'

const saved = CHAIN_REGISTRY[100]
delete CHAIN_REGISTRY[100]

const ROUTES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'routes')
const routeModules = readdirSync(ROUTES).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))

describe('#3642 — the backend loads with chain 100 gone from the registry', () => {
  afterAll(() => {
    if (saved) CHAIN_REGISTRY[100] = saved
  })

  it('the deletion is live, and the scan has a real population', () => {
    expect(100 in CHAIN_REGISTRY).toBe(false)
    expect(routeModules.length).toBeGreaterThan(30)
  })

  it('domain/tokens.ts loads (no load-time chain-100 read)', async () => {
    await expect(import('../tokens.js')).resolves.toBeDefined()
  })

  it.each(routeModules)('routes/%s loads', async (file) => {
    await expect(import(join(ROUTES, file))).resolves.toBeDefined()
  })
})
