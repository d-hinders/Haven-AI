import { describe, expect, it, vi } from 'vitest'
import { selectX402SettlementScheme, type X402PaymentOption } from '@haven_ai/sdk'
import { probeCatalogEntry, selectCatalogPaymentOption, type CatalogRow } from '../merchant-catalog.js'
import { ingestDiscoveredCatalog } from '../catalog-discovery.js'

/**
 * #4389: the catalog judges a merchant's 402 by the pay path's own scheme
 * selection over every `accepts[]` option, not by `accepts[0]`, and labels the
 * asset from the chain registry instead of defaulting to "USDC".
 *
 * Before this change (characterized in the previous commit): a payable Base
 * option after an unsupported `accepts[0]` recorded the unsupported network;
 * an unsettleable scheme on Base was recorded as verified; EURe and an unknown
 * address were both labelled USDC; discovery skipped the first case and
 * ingested the second.
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
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
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

const SOLANA_OPTION = {
  scheme: 'exact', network: 'solana:mainnet', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '20000', payTo: 'So1anaPayTo1111111111111111111111111111111', maxTimeoutSeconds: 300,
}

const EURE_ON_GNOSIS = {
  ...BASE_OPTION, network: 'eip155:100', asset: '0xcB444e90D8198415266c6a2724b7900fb12FC56E', amount: '1000000000000000000',
}

const UNKNOWN_ASSET_ON_BASE = { ...BASE_OPTION, asset: '0x4200000000000000000000000000000000000006' }

function challenge(accepts: unknown[]): typeof fetch {
  return vi.fn().mockResolvedValue(new Response(null, {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': b64({ x402Version: 2, accepts }) },
  })) as unknown as typeof fetch
}

describe('catalog payability (#4389) — the probe', () => {
  it('a payable Base option after an unsupported accepts[0] is the one recorded', async () => {
    const result = await probeCatalogEntry(ENTRY, challenge([SOLANA_OPTION, BASE_OPTION]))
    expect(result).toMatchObject({
      ok: true,
      network: 'eip155:8453',
      asset: 'USDC',
      priceAtomic: '20000',
      priceDisplay: '0.02 USDC',
      payTo: PAY_TO,
      assetTransferMethods: ['eip3009'],
    })
  })

  it('an option with a scheme Haven cannot settle is a miss, not a verified row', async () => {
    expect(await probeCatalogEntry(ENTRY, challenge([{ ...BASE_OPTION, scheme: 'upto' }]))).toEqual({ ok: false })
  })

  it('a known non-USDC asset (EURe on Gnosis) is a miss, never labelled USDC', async () => {
    expect(await probeCatalogEntry(ENTRY, challenge([EURE_ON_GNOSIS]))).toEqual({ ok: false })
  })

  it('an unknown asset address on Base is a miss, never labelled USDC', async () => {
    expect(await probeCatalogEntry(ENTRY, challenge([UNKNOWN_ASSET_ON_BASE]))).toEqual({ ok: false })
  })

  it('an unpayable accepts[0] does not hide a payable option behind it', async () => {
    const result = await probeCatalogEntry(ENTRY, challenge([UNKNOWN_ASSET_ON_BASE, BASE_OPTION]))
    expect(result).toMatchObject({ ok: true, network: 'eip155:8453', asset: 'USDC', priceAtomic: '20000' })
  })

  it('prefers the erc7710 option, as a delegation-rail agent is quoted, and records the payable schemes on its chain', async () => {
    const erc7710 = { ...BASE_OPTION, amount: '25000', extra: { assetTransferMethod: 'erc7710' } }
    const result = await probeCatalogEntry(ENTRY, challenge([BASE_OPTION, erc7710]))
    expect(result).toMatchObject({ ok: true, priceAtomic: '25000', assetTransferMethods: ['eip3009', 'erc7710'] })
  })

  it('an option on an unpayable scheme does not count toward the recorded methods', async () => {
    const permit2 = { ...BASE_OPTION, extra: { assetTransferMethod: 'permit2' } }
    const result = await probeCatalogEntry(ENTRY, challenge([BASE_OPTION, permit2]))
    expect(result).toMatchObject({ ok: true, assetTransferMethods: ['eip3009'] })
  })

  it('a payable scheme on the other Base network does not count toward the recorded methods', async () => {
    const erc7710 = { ...BASE_OPTION, extra: { assetTransferMethod: 'erc7710' } }
    const sepolia = { ...BASE_OPTION, network: 'eip155:84532', asset: BASE_SEPOLIA_USDC }
    const result = await probeCatalogEntry(ENTRY, challenge([erc7710, sepolia]))
    expect(result).toMatchObject({ ok: true, network: 'eip155:8453', assetTransferMethods: ['erc7710'] })
  })

  it('records the x402 short network name as CAIP-2, the form agents are filtered on', async () => {
    const result = await probeCatalogEntry(ENTRY, challenge([{ ...BASE_OPTION, network: 'base-sepolia', asset: BASE_SEPOLIA_USDC }]))
    expect(result).toMatchObject({ ok: true, network: 'eip155:84532', asset: 'USDC' })
  })

  it('an option whose fields are not strings is not an option — a clean miss, no throw', async () => {
    // A throw would still read as a miss (#4300), but it is logged as a parse
    // bug (#4341); a mistyped option is not a bug, so nothing is logged.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await probeCatalogEntry(ENTRY, challenge([{ ...BASE_OPTION, amount: 1000 }]))).toEqual({ ok: false })
      expect(await probeCatalogEntry(ENTRY, challenge([{ ...BASE_OPTION, asset: 42 }]))).toEqual({ ok: false })
      expect(await probeCatalogEntry(ENTRY, challenge([null, BASE_OPTION]))).toMatchObject({ ok: true })
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('catalog payability (#4389) — agrees with the pay path', () => {
  // The fixtures the probe tests use, plus the cases the SDK selector
  // distinguishes. For each, the catalog verdict and the pay path's own
  // selection (delegation rail) must pick the same option, or both none.
  const cases: Array<[string, unknown[]]> = [
    ['solana then base', [SOLANA_OPTION, BASE_OPTION]],
    ['upto on base', [{ ...BASE_OPTION, scheme: 'upto' }]],
    ['EURe on gnosis', [EURE_ON_GNOSIS]],
    ['unknown asset on base', [UNKNOWN_ASSET_ON_BASE]],
    ['unknown asset then payable', [UNKNOWN_ASSET_ON_BASE, BASE_OPTION]],
    ['eip3009 then erc7710', [BASE_OPTION, { ...BASE_OPTION, amount: '25000', extra: { assetTransferMethod: 'erc7710' } }]],
    ['erc7710 only', [{ ...BASE_OPTION, extra: { assetTransferMethod: 'erc7710' } }]],
    ['permit2 only', [{ ...BASE_OPTION, extra: { assetTransferMethod: 'permit2' } }]],
    ['base sepolia short name', [{ ...BASE_OPTION, network: 'base-sepolia', asset: BASE_SEPOLIA_USDC }]],
    ['mainnet USDC address on a sepolia option', [{ ...BASE_OPTION, network: 'eip155:84532' }]],
    ['zero amount', [{ ...BASE_OPTION, amount: '0' }]],
    ['empty', []],
  ]

  for (const [name, accepts] of cases) {
    it(`agrees on: ${name}`, () => {
      const pay = selectX402SettlementScheme(accepts as X402PaymentOption[], { delegationRail: true })
      const catalog = selectCatalogPaymentOption({ accepts })
      expect(catalog?.option ?? null).toEqual(pay?.option ?? null)
      expect(catalog?.scheme ?? null).toEqual(pay?.scheme ?? null)
    })
  }
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

describe('discovery payability (#4389)', () => {
  it('an index entry whose payable Base option is listed after an unsupported one is probed and ingested on Base', async () => {
    const { db, merchants, fetchMock, inserts } = discoveryHarness([SOLANA_OPTION, BASE_OPTION], [SOLANA_OPTION, BASE_OPTION])
    const result = await ingestDiscoveredCatalog(db, fetchMock, undefined, merchants, fetchMock)
    expect(result).toMatchObject({ scanned: 1, candidates: 1, skippedUnsupported: 0, ingested: 1 })
    expect(inserts).toHaveLength(1)
    // price_display, price_atomic, asset, network are $5..$8 of the insert.
    expect(inserts[0]!.slice(4, 8)).toEqual(['0.02 USDC', '20000', 'USDC', 'eip155:8453'])
  })

  it('an index entry on Base with an unsettleable scheme is skipped, never probed', async () => {
    const upto = { ...BASE_OPTION, scheme: 'upto' }
    const { db, merchants, fetchMock, inserts } = discoveryHarness([upto], [upto])
    const result = await ingestDiscoveredCatalog(db, fetchMock, undefined, merchants, fetchMock)
    expect(result).toMatchObject({ candidates: 0, skippedUnsupported: 1, ingested: 0 })
    expect(inserts).toHaveLength(0)
    // Only the index page was fetched: no probe was spent on it.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('an index entry listing only a non-USDC asset is skipped', async () => {
    const { db, merchants, fetchMock } = discoveryHarness([UNKNOWN_ASSET_ON_BASE], [UNKNOWN_ASSET_ON_BASE])
    const result = await ingestDiscoveredCatalog(db, fetchMock, undefined, merchants, fetchMock)
    expect(result).toMatchObject({ candidates: 0, skippedUnsupported: 1 })
  })
})
