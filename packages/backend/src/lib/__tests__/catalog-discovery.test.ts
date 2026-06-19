import { describe, expect, it, vi } from 'vitest'
import { ingestDiscoveredCatalog } from '../catalog-discovery.js'
import type { CatalogRow } from '../merchant-catalog.js'

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
  }],
}

function bazaarPage(items: unknown[], total = items.length): Response {
  return new Response(JSON.stringify({ x402Version: 2, items, pagination: { limit: 100, offset: 0, total } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function paid402(): Response {
  return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': b64(X402_BODY) } })
}

/** A fake db that records inserts and returns the given existing resource URLs. */
function fakeDb(existing: string[] = []) {
  const inserts: unknown[][] = []
  const db = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT resource_url')) {
        return { rows: existing.map((u) => ({ resource_url: u })) as unknown as CatalogRow[] }
      }
      if (sql.startsWith('INSERT')) {
        inserts.push(values ?? [])
      }
      return { rows: [] as CatalogRow[] }
    },
  }
  return { db, inserts }
}

describe('ingestDiscoveredCatalog', () => {
  it('ingests a verified, payable, unknown resource', async () => {
    const { db, inserts } = fakeDb()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/discovery/resources')) {
        return bazaarPage([
          { resource: 'https://api.weather.example/paid', type: 'http', accepts: X402_BODY.accepts,
            metadata: { name: 'Weather API', description: 'Per-call forecast data.' } },
        ])
      }
      return paid402()
    })

    const result = await ingestDiscoveredCatalog(db, fetchMock as unknown as typeof fetch)

    expect(result).toMatchObject({ scanned: 1, candidates: 1, ingested: 1, failedProbe: 0 })
    expect(inserts).toHaveLength(1)
    // name, description, category='api', resource_url, price_display, price_atomic, asset, network
    expect(inserts[0]).toEqual([
      'Weather API',
      'Per-call forecast data.',
      'api',
      'https://api.weather.example/paid',
      '$0.02 USDC',
      '20000',
      'USDC',
      'eip155:8453',
    ])
  })

  it('skips resources on unsupported networks (e.g. Solana) without probing', async () => {
    const { db, inserts } = fakeDb()
    const probe = vi.fn()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/discovery/resources')) {
        return bazaarPage([
          { resource: 'https://sol.example/paid', type: 'http',
            accepts: [{ scheme: 'exact', network: 'solana:mainnet', asset: 'x', amount: '1', payTo: 'y' }] },
        ])
      }
      probe()
      return paid402()
    })

    const result = await ingestDiscoveredCatalog(db, fetchMock as unknown as typeof fetch)
    expect(result).toMatchObject({ scanned: 1, candidates: 0, ingested: 0, skippedUnsupported: 1 })
    expect(probe).not.toHaveBeenCalled()
    expect(inserts).toHaveLength(0)
  })

  it('skips resources already in the catalog (respects operator delisting)', async () => {
    const { db, inserts } = fakeDb(['https://api.known.example/paid'])
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/discovery/resources')) {
        return bazaarPage([
          { resource: 'https://api.known.example/paid', type: 'http', accepts: X402_BODY.accepts },
        ])
      }
      return paid402()
    })

    const result = await ingestDiscoveredCatalog(db, fetchMock as unknown as typeof fetch)
    expect(result).toMatchObject({ candidates: 0, ingested: 0, skippedExisting: 1 })
    expect(inserts).toHaveLength(0)
  })

  it('does not ingest a candidate that fails the 402 probe', async () => {
    const { db, inserts } = fakeDb()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/discovery/resources')) {
        return bazaarPage([
          { resource: 'https://api.dead.example/paid', type: 'http', accepts: X402_BODY.accepts },
        ])
      }
      return new Response('gone', { status: 404 })
    })

    const result = await ingestDiscoveredCatalog(db, fetchMock as unknown as typeof fetch)
    expect(result).toMatchObject({ candidates: 1, ingested: 0, failedProbe: 1 })
    expect(inserts).toHaveLength(0)
  })

  it('derives a name from the host when metadata omits one', async () => {
    const { db, inserts } = fakeDb()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/discovery/resources')) {
        return bazaarPage([
          { resource: 'https://www.search.example/q', type: 'http', accepts: X402_BODY.accepts },
        ])
      }
      return paid402()
    })

    await ingestDiscoveredCatalog(db, fetchMock as unknown as typeof fetch)
    expect(inserts[0]?.[0]).toBe('search.example')
  })
})
