/**
 * Run budgets for the catalog crons (#4300).
 *
 * Discovery: a candidate the run budget does not reach is not probed and not
 * inserted; it is counted `deferred` and the next run considers it again.
 * The Bazaar index read is bounded per page in time and size, and per run in
 * pages. The refresh's rotation is pinned against real Postgres in
 * `catalog-refresh-rotation.db.test.ts`, because it rests on `ORDER BY`.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DISCOVERY_INDEX_MAX_PAGES,
  DISCOVERY_INDEX_PAGE_MAX_BYTES,
  fetchBazaarResources,
  ingestDiscoveredCatalog,
} from '../catalog-discovery.js'
import type { CatalogRow } from '../merchant-catalog.js'

const ACCEPTS = [{ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '20000', payTo: '0x' + '11'.repeat(20) }]

function paid402(): Response {
  return new Response(null, {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify({ x402Version: 2, accepts: ACCEPTS })).toString('base64') },
  })
}

function indexPage(items: unknown[], total = items.length): Response {
  return new Response(JSON.stringify({ items, pagination: { limit: 100, offset: 0, total } }), { status: 200 })
}

function fakeDb() {
  const inserted: string[] = []
  return {
    inserted,
    db: {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.startsWith('INSERT')) inserted.push(String((values ?? [])[3]))
        return { rows: [] as CatalogRow[] }
      },
    },
  }
}

const merchants = { findOrCreateMerchantByHost: async () => ({ id: 'merchant-1' }) }

describe('discovery run budget (#4300)', () => {
  it('stops probing candidates at the run budget and defers the rest, unprobed and uninserted', async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ resource: `https://seller${i}.example/paid`, type: 'http', accepts: ACCEPTS }))
    const indexFetch = vi.fn(async () => indexPage(items))
    let clock = 0
    const probed: string[] = []
    const probeFetch = vi.fn(async (input: string | URL | Request) => {
      probed.push(String(input))
      clock += 10
      return paid402()
    }) as unknown as typeof fetch
    const { db, inserted } = fakeDb()

    // 10 ms per probe and a 35 ms budget: three probes fit, the fourth would not.
    const result = await ingestDiscoveredCatalog(db, indexFetch as unknown as typeof fetch, 50, merchants, probeFetch, {
      runBudgetMs: 35,
      probeBudgetMs: 10,
      now: () => clock,
    })

    expect(probed).toEqual(items.slice(0, 3).map((i) => i.resource))
    expect(inserted).toEqual(items.slice(0, 3).map((i) => i.resource))
    expect(result).toMatchObject({ candidates: 6, ingested: 3, deferred: 3, failedProbe: 0 })
  })

  it('probes every candidate when the budget is not reached', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ resource: `https://seller${i}.example/paid`, type: 'http', accepts: ACCEPTS }))
    const { db } = fakeDb()
    const result = await ingestDiscoveredCatalog(
      db,
      (async () => indexPage(items)) as unknown as typeof fetch,
      50,
      merchants,
      (async () => paid402()) as unknown as typeof fetch,
    )
    expect(result).toMatchObject({ ingested: 3, deferred: 0 })
  })
})

describe('Bazaar index read bounds (#4300)', () => {
  it('passes an abort signal, so one page cannot hang the run', async () => {
    let seen: AbortSignal | null | undefined
    const indexFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal
      return indexPage([])
    })
    await fetchBazaarResources(indexFetch as unknown as typeof fetch)
    expect(seen).toBeInstanceOf(AbortSignal)
  })

  it('refuses a page larger than the byte cap', async () => {
    const huge = 'x'.repeat(DISCOVERY_INDEX_PAGE_MAX_BYTES + 1)
    const indexFetch = vi.fn(async () => new Response(JSON.stringify({ items: [{ resource: huge }] }), { status: 200 }))
    await expect(fetchBazaarResources(indexFetch as unknown as typeof fetch)).rejects.toThrow(/exceeded/)
  })

  it('reads at most the page cap, even when every page claims there is more', async () => {
    let offset = 0
    const indexFetch = vi.fn(async () => {
      offset += 1
      return indexPage([{ resource: `https://one${offset}.example/` }], 10_000)
    })
    const out = await fetchBazaarResources(indexFetch as unknown as typeof fetch, 1_000)
    expect(indexFetch).toHaveBeenCalledTimes(DISCOVERY_INDEX_MAX_PAGES)
    expect(out).toHaveLength(DISCOVERY_INDEX_MAX_PAGES)
  })
})
