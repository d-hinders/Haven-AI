/**
 * #4281: every catalog probe goes through the SSRF guard.
 *
 * Since #4245, `merchant_catalog` is not operator-only: where
 * `CATALOG_DISCOVERY_ENABLED=true` the discovery cron inserts seller-listed
 * x402 Bazaar URLs, and the hourly refresh re-probes every non-delisted row.
 * These tests pin that neither path reaches the process-global `fetch` with
 * a URL a third party chose. The guarded transport classifies the resolved
 * address and pins the socket to it, the same control the ingestion probe
 * (`probe.ts`, #1713) has always used.
 *
 * No test here opens a socket. The refused hosts are IP literals or
 * locally-bound names, which the guard refuses before any DNS lookup, and the
 * global `fetch` is replaced with a spy that would answer a valid 402. So a
 * regression that routed a probe back to it would VERIFY the row, not just
 * fail it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestDiscoveredCatalog } from '../catalog-discovery.js'
import {
  createGuardedCatalogFetch,
  probeCatalogEntry,
  refreshCatalog,
  type CatalogRow,
  type QueryableLike,
} from '../merchant-catalog.js'
import type { PinnedRequest, PinnedResponse, PinnedTransport, ResolvedAddress } from '../../../infra/http/ssrf-guard.js'

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

const X402_BODY = {
  x402Version: 2,
  accepts: [{
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '20000',
    payTo: '0x' + '11'.repeat(20),
    maxTimeoutSeconds: 300,
  }],
}

function payable402(): Response {
  return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': b64(X402_BODY) } })
}

function rowFor(overrides: Partial<CatalogRow>): CatalogRow {
  return {
    id: 'cat-1', name: 'Row', description: '', category: 'data',
    resource_url: 'https://api.merchant.example/paid', rail: 'x402', protocol: 'http',
    tool_name: null, tool_arguments: null, price_display: '0.02 USDC', price_atomic: '20000',
    asset: 'USDC', network: 'eip155:8453', asset_transfer_methods: null,
    status: 'active', verified_at: null, consecutive_failures: 0,
    created_at: '', updated_at: '',
    ...overrides,
  } as CatalogRow
}

let globalFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  globalFetch = vi.fn(async () => payable402())
  vi.stubGlobal('fetch', globalFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('catalog probes do not reach the global fetch (#4281)', () => {
  it('probeCatalogEntry with no transport injected refuses an IP-literal host without calling fetch', async () => {
    const result = await probeCatalogEntry({
      resource_url: 'https://127.0.0.1/paid', protocol: 'http', tool_name: null, tool_arguments: null, rail: 'x402',
    })
    expect(result.ok).toBe(false)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('refreshCatalog with no transport injected does not verify a bazaar row on a locally-bound host', async () => {
    const queries: Array<[string, unknown[] | undefined]> = []
    const db: QueryableLike = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push([sql, values])
        if (sql.startsWith('SELECT')) {
          return { rows: [rowFor({ id: 'cat-bazaar', source: 'bazaar', resource_url: 'https://metadata.internal.localhost/paid' } as Partial<CatalogRow>)] }
        }
        return { rows: [] }
      },
    }
    const result = await refreshCatalog(db)
    expect(result).toEqual({ verified: 0, degraded: 0 })
    expect(globalFetch).not.toHaveBeenCalled()
    const miss = queries.find(([sql, v]) => sql.includes('consecutive_failures = $2') && v?.[0] === 'cat-bazaar')
    expect(miss?.[1]).toEqual(['cat-bazaar', 1, 'active'])
  })

  it('ingestDiscoveredCatalog probes a candidate through the guard, never through the index fetch', async () => {
    const candidate = 'https://10.0.0.5/paid'
    let indexPages = 0
    const indexFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      // A fetch that would verify the candidate, so a probe routed back to
      // it ingests the row instead of merely failing it.
      if (url === candidate) return payable402()
      indexPages += 1
      const items = indexPages === 1 ? [{ resource: candidate, type: 'http', accepts: X402_BODY.accepts }] : []
      return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const db: QueryableLike = {
      query: async (sql: string) => {
        if (sql.includes('SELECT resource_url FROM merchant_catalog')) return { rows: [] }
        return { rows: [] }
      },
    }
    const merchants = { findOrCreateMerchantByHost: async () => ({ id: 'merchant-1' }) }
    const result = await ingestDiscoveredCatalog(db, indexFetch as unknown as typeof fetch, undefined, merchants as never)
    expect(result.candidates).toBe(1)
    expect(result.failedProbe).toBe(1)
    expect(result.ingested).toBe(0)
    expect(indexFetch.mock.calls.map(([url]) => url)).not.toContain(candidate)
    expect(globalFetch).not.toHaveBeenCalled()
  })
})

const publicResolver = async (): Promise<ResolvedAddress[]> => [{ address: '93.184.216.34', family: 4 }]
const challenge402: PinnedResponse = {
  status: 402,
  location: null,
  body: '',
  headers: { 'payment-required': b64(X402_BODY) },
}

describe('the guarded catalog transport (#4281)', () => {
  it('verifies an operator row exactly as before, pinned to the validated address', async () => {
    const transport = vi.fn<PinnedTransport>(async () => challenge402)
    const result = await probeCatalogEntry(
      { resource_url: 'https://api.merchant.example/paid', protocol: 'http', tool_name: null, tool_arguments: null, rail: 'x402' },
      createGuardedCatalogFetch({ resolver: publicResolver, transport }),
    )
    expect(result).toMatchObject({ ok: true, priceAtomic: '20000', priceDisplay: '0.02 USDC', network: 'eip155:8453', payTo: '0x' + '11'.repeat(20) })
    const sent = transport.mock.calls[0]![0] as PinnedRequest
    expect(sent).toMatchObject({ address: '93.184.216.34', method: 'GET', body: null })
    expect(sent.url.toString()).toBe('https://api.merchant.example/paid')
  })

  it('keeps the MCP tools/call probe shape: POST, JSON-RPC body, JSON-or-SSE accept', async () => {
    const transport = vi.fn<PinnedTransport>(async () => challenge402)
    await probeCatalogEntry(
      { resource_url: 'https://mcp.merchant.example/mcp', protocol: 'mcp', tool_name: 'create_text', tool_arguments: { prompt: 'hi' }, rail: 'x402' },
      createGuardedCatalogFetch({ resolver: publicResolver, transport }),
    )
    const sent = transport.mock.calls[0]![0] as PinnedRequest
    expect(sent.method).toBe('POST')
    expect(JSON.parse(sent.body!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_text', arguments: { prompt: 'hi' } },
    })
    expect(sent.headers).toMatchObject({ accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
  })

  it('keeps a declared POST with its example body (#3769)', async () => {
    const transport = vi.fn<PinnedTransport>(async () => challenge402)
    await probeCatalogEntry(
      {
        resource_url: 'https://api.merchant.example/price', protocol: 'http', tool_name: null, tool_arguments: null, rail: 'x402',
        http_method: 'post', body_type: 'json', body_example: { token: 'eth' },
      } as never,
      createGuardedCatalogFetch({ resolver: publicResolver, transport }),
    )
    const sent = transport.mock.calls[0]![0] as PinnedRequest
    expect(sent.method).toBe('POST')
    expect(sent.body).toBe('{"token":"eth"}')
  })

  it('refuses a refreshed row whose name resolves into private space and counts the miss', async () => {
    const transport = vi.fn<PinnedTransport>(async () => challenge402)
    const queries: Array<[string, unknown[] | undefined]> = []
    const db: QueryableLike = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push([sql, values])
        if (sql.startsWith('SELECT')) {
          return { rows: [rowFor({ id: 'cat-rebind', resource_url: 'https://rebind.seller.example/paid' })] }
        }
        return { rows: [] }
      },
    }
    const result = await refreshCatalog(db, createGuardedCatalogFetch({
      resolver: async () => [{ address: '169.254.169.254', family: 4 }],
      transport,
    }))
    expect(result).toEqual({ verified: 0, degraded: 0 })
    expect(transport).not.toHaveBeenCalled()
    const miss = queries.find(([sql, v]) => sql.includes('consecutive_failures = $2') && v?.[0] === 'cat-rebind')
    expect(miss?.[1]).toEqual(['cat-rebind', 1, 'active'])
  })

  it('turns a redirect on an MCP POST probe into a failed probe, not a crash', async () => {
    const transport = vi.fn<PinnedTransport>(async () => ({ status: 307, location: 'https://elsewhere.example/mcp', body: '' }))
    const result = await probeCatalogEntry(
      { resource_url: 'https://mcp.merchant.example/mcp', protocol: 'mcp', tool_name: 't', tool_arguments: {}, rail: 'x402' },
      createGuardedCatalogFetch({ resolver: publicResolver, transport }),
    )
    expect(result).toEqual({ ok: false })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('answers a body-less status without throwing inside the adapter', async () => {
    const guarded = createGuardedCatalogFetch({ resolver: publicResolver, transport: async () => ({ status: 204, location: null, body: '' }) })
    const response = await guarded('https://api.merchant.example/paid')
    expect(response.status).toBe(204)
  })

  it('rejects a non-string body instead of sending it', async () => {
    const transport = vi.fn<PinnedTransport>(async () => challenge402)
    const guarded = createGuardedCatalogFetch({ resolver: publicResolver, transport })
    const outcome = await guarded('https://api.merchant.example/paid', { method: 'POST', body: new Uint8Array([1]) }).then(
      () => 'resolved',
      () => 'rejected',
    )
    expect(outcome).toBe('rejected')
    expect(transport).not.toHaveBeenCalled()
  })
})
