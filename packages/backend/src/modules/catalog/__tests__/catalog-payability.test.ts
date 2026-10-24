import { describe, expect, it, vi } from 'vitest'
import { probeCatalogEntry, type CatalogRow } from '../merchant-catalog.js'
import { ingestDiscoveredCatalog } from '../catalog-discovery.js'

/**
 * #4389: what the catalog records for a 402 whose payable option is not
 * `accepts[0]`, whose `accepts[0]` is unpayable, or whose asset is not USDC.
 * These cases are written down BEFORE the change, as today's behaviour.
 */

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

const ENTRY = {
  resource_url: 'https://api.merchant.example/paid',
  protocol: 'http' as const,
  tool_name: null,
  tool_arguments: null,
  rail: 'x402' as const,
}

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAY_TO = '0x' + '22'.repeat(20)

/** A payable Base USDC EIP-3009 option. */
const BASE_OPTION = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: BASE_USDC,
  amount: '20000',
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
}

function challenge(accepts: unknown[]): typeof fetch {
  return vi.fn().mockResolvedValue(new Response(null, {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': b64({ x402Version: 2, accepts }) },
  })) as unknown as typeof fetch
}

describe('catalog payability (#4389) — today', () => {
  it('accepts[0] on an unsupported network, accepts[1] payable on Base: records accepts[0]', async () => {
    const result = await probeCatalogEntry(ENTRY, challenge([
      { scheme: 'exact', network: 'solana:mainnet', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '20000', payTo: 'So1anaPayTo1111111111111111111111111111111', maxTimeoutSeconds: 300 },
      BASE_OPTION,
    ]))
    expect(result.ok).toBe(true)
    expect(result.network).toBe('solana:mainnet')
  })

  it('accepts[0] on Base with a scheme Haven cannot settle: records it as verified', async () => {
    const result = await probeCatalogEntry(ENTRY, challenge([{ ...BASE_OPTION, scheme: 'upto' }]))
    expect(result.ok).toBe(true)
    expect(result.network).toBe('eip155:8453')
  })

  it('a known non-USDC asset (EURe on Gnosis) is labelled USDC', async () => {
    const result = await probeCatalogEntry(ENTRY, challenge([
      { ...BASE_OPTION, network: 'eip155:100', asset: '0xcB444e90D8198415266c6a2724b7900fb12FC56E', amount: '1000000000000000000' },
    ]))
    expect(result.ok).toBe(true)
    expect(result.asset).toBe('USDC')
  })

  it('an unknown asset address on Base is labelled USDC', async () => {
    const result = await probeCatalogEntry(ENTRY, challenge([
      { ...BASE_OPTION, asset: '0x4200000000000000000000000000000000000006' },
    ]))
    expect(result.ok).toBe(true)
    expect(result.asset).toBe('USDC')
  })
})

/** A Bazaar page and a 402 for every probe; the fake db records inserts. */
function discoveryHarness(indexAccepts: unknown[], liveAccepts: unknown[]) {
  const inserts: unknown[][] = []
  const db = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT resource_url')) return { rows: [] as CatalogRow[] }
      if (sql.startsWith('INSERT')) inserts.push(values ?? [])
      return { rows: [] as CatalogRow[] }
    },
  }
  const merchants = { findOrCreateMerchantByHost: async () => ({ id: 'merchant-1' }) }
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input).includes('/discovery/resources')) {
      return new Response(JSON.stringify({
        x402Version: 2,
        items: [{ resource: 'https://api.multi.example/paid', type: 'http', accepts: indexAccepts }],
        pagination: { limit: 100, offset: 0, total: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': b64({ x402Version: 2, accepts: liveAccepts }) } })
  }) as unknown as typeof fetch
  return { db, merchants, fetchMock, inserts }
}

const SOLANA_OPTION = {
  scheme: 'exact', network: 'solana:mainnet', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '20000', payTo: 'So1anaPayTo1111111111111111111111111111111', maxTimeoutSeconds: 300,
}

describe('discovery payability (#4389) — today', () => {
  it('an index entry whose accepts[0] is unsupported is skipped, even with a payable Base option after it', async () => {
    const { db, merchants, fetchMock, inserts } = discoveryHarness([SOLANA_OPTION, BASE_OPTION], [SOLANA_OPTION, BASE_OPTION])
    const result = await ingestDiscoveredCatalog(db, fetchMock, undefined, merchants, fetchMock)
    expect(result).toMatchObject({ scanned: 1, candidates: 0, skippedUnsupported: 1, ingested: 0 })
    expect(inserts).toHaveLength(0)
  })

  it('an index entry on Base with an unsettleable scheme is a candidate and is ingested', async () => {
    const upto = { ...BASE_OPTION, scheme: 'upto' }
    const { db, merchants, fetchMock, inserts } = discoveryHarness([upto], [upto])
    const result = await ingestDiscoveredCatalog(db, fetchMock, undefined, merchants, fetchMock)
    expect(result).toMatchObject({ candidates: 1, ingested: 1 })
    expect(inserts).toHaveLength(1)
  })
})
