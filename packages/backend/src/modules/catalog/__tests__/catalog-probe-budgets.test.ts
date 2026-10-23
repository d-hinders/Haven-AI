/**
 * #4281: the two catalog probe budgets.
 *
 * The refresh re-probes listed merchants hourly, and a sleeping merchant
 * (Railway serverless, such as the dev Demo-merchant) cold-starts on that
 * probe in about 4–5 s. So the refresh gets a 15 s total deadline. A
 * discovery candidate is an unknown seller-listed URL and keeps the
 * ingestion probe's 5 s.
 *
 * `safeRequest` is replaced here only to read the options the DEFAULT
 * transports pass. Nothing else in the guard is mocked, and every other test
 * of it runs the real loop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seen: Array<{ url: string; timeoutMs: number | undefined; maxBytes: number | undefined }> = []

vi.mock('../../../infra/http/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/http/ssrf-guard.js')>()
  return {
    ...actual,
    safeRequest: vi.fn(async (url: string, _request: unknown, options?: { timeoutMs?: number; maxBytes?: number }) => {
      seen.push({ url, timeoutMs: options?.timeoutMs, maxBytes: options?.maxBytes })
      return { ok: false as const, reason: 'timeout' as const, detail: 'budget test' }
    }),
  }
})

import { ingestDiscoveredCatalog } from '../catalog-discovery.js'
import { refreshCatalog, type CatalogRow, type QueryableLike } from '../merchant-catalog.js'

beforeEach(() => {
  seen.length = 0
})

describe('catalog probe budgets (#4281)', () => {
  it('the refresh probes with a 15 s total deadline and a 256 KiB cap', async () => {
    const db: QueryableLike = {
      query: async (sql: string) =>
        sql.startsWith('SELECT')
          ? { rows: [{ id: 'cat-1', resource_url: 'https://demo-merchant.example/mcp', protocol: 'mcp', tool_name: 't', tool_arguments: {}, rail: 'x402', status: 'active', consecutive_failures: 0 } as unknown as CatalogRow] }
          : { rows: [] },
    }
    await refreshCatalog(db)
    expect(seen).toEqual([{ url: 'https://demo-merchant.example/mcp', timeoutMs: 15_000, maxBytes: 256 * 1024 }])
  })

  it('a discovery candidate probes with the ingestion budget, 5 s', async () => {
    const candidate = 'https://seller.example/paid'
    let pages = 0
    const indexFetch = vi.fn(async () => {
      pages += 1
      const items = pages === 1
        ? [{ resource: candidate, type: 'http', accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '1' }] }]
        : []
      return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const db: QueryableLike = { query: async () => ({ rows: [] }) }
    await ingestDiscoveredCatalog(db, indexFetch as unknown as typeof fetch)
    expect(seen).toEqual([{ url: candidate, timeoutMs: 5_000, maxBytes: 256 * 1024 }])
  })
})
