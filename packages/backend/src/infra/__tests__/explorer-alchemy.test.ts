/**
 * Base / Base Sepolia history through Alchemy's transfers API, used when
 * `ALCHEMY_HISTORY_API_KEY` is set. Base's public Blockscout API answers
 * Railway with a Cloudflare challenge (HTTP 403), so this is the read path
 * production depends on once the key is configured.
 *
 * Pins: both directions are read (the API filters one per call), amounts
 * come from the exact hex `rawContract.value`, `pageKey` is followed up to
 * the page budget and a remaining key reports `hasMore`, the internal leg is
 * skipped, and the key — which sits in the endpoint path — never reaches an
 * error message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>()
  return { config: { ...actual.config, alchemyHistoryApiKey: 'alc-test-key' } }
})

import {
  ALCHEMY_PAGE_SIZE,
  EXPLORER_MAX_PAGES,
  alchemyHistoryEndpoint,
  fetchERC20Transfers,
  fetchInternalTransactions,
  fetchNormalTransactions,
} from '../explorer-api.js'

const ACCOUNT = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const OTHER = '0xAAAA0000000000000000000000000000000000A1'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

interface Body {
  method: string
  params: Array<Record<string, unknown>>
}

function bodyOf(call: unknown[]): Body {
  return JSON.parse(String((call[1] as RequestInit).body)) as Body
}

function rpcResult(transfers: unknown[], pageKey?: string) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { transfers, ...(pageKey ? { pageKey } : {}) } }),
  } as Response)
}

function transfer(overrides: Record<string, unknown> = {}) {
  return {
    blockNum: '0x2a',
    hash: '0xabc',
    from: OTHER,
    to: ACCOUNT,
    value: 1.2345678901234567, // the rounded float — must NOT be used
    asset: 'ETH',
    category: 'external',
    rawContract: { value: '0x112210f4768db400', address: null, decimal: '0x12' },
    metadata: { blockTimestamp: '2026-10-09T10:00:00.000Z' },
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Alchemy history routing', () => {
  it('serves Base and Base Sepolia, and no other chain', () => {
    expect(alchemyHistoryEndpoint(8453)).toBe('https://base-mainnet.g.alchemy.com/v2/alc-test-key')
    expect(alchemyHistoryEndpoint(84532)).toBe('https://base-sepolia.g.alchemy.com/v2/alc-test-key')
    expect(alchemyHistoryEndpoint(100)).toBeNull()
  })
})

describe('normal leg (category external)', () => {
  it('reads both directions and maps exact amounts, block and timestamp', async () => {
    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => {
      const params = (JSON.parse(String(init?.body)) as Body).params[0]!
      return params.toAddress
        ? rpcResult([transfer({ hash: '0xin' })])
        : rpcResult([transfer({ hash: '0xout', from: ACCOUNT, to: OTHER })])
    })
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchNormalTransactions(8453, ACCOUNT)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const bodies = fetchMock.mock.calls.map(bodyOf)
    expect(bodies.map((b) => b.method)).toEqual(['alchemy_getAssetTransfers', 'alchemy_getAssetTransfers'])
    expect(bodies[0]!.params[0]).toMatchObject({ fromAddress: ACCOUNT, category: ['external'], withMetadata: true })
    expect(bodies[1]!.params[0]).toMatchObject({ toAddress: ACCOUNT, category: ['external'] })
    expect(bodies[0]!.params[0]!.maxCount).toBe(`0x${ALCHEMY_PAGE_SIZE.toString(16)}`)

    expect(leg.hasMore).toBe(false)
    expect(leg.rows.map((r) => r.hash)).toEqual(['0xout', '0xin'])
    expect(leg.rows[1]).toMatchObject({
      blockNumber: '42',
      timeStamp: String(Date.parse('2026-10-09T10:00:00.000Z') / 1000),
      from: OTHER,
      to: ACCOUNT,
      value: '1234567890000000000', // 0x112210f4768db400 exactly, not the float above
      isError: '0',
      functionName: '',
    })
  })

  it('follows pageKey and reports hasMore when a key remains at the page budget', async () => {
    const fetchMock = vi.fn(() => rpcResult([transfer()], 'next-page'))
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchNormalTransactions(8453, ACCOUNT)

    // Both directions spend the full budget.
    expect(fetchMock).toHaveBeenCalledTimes(EXPLORER_MAX_PAGES * 2)
    expect(bodyOf(fetchMock.mock.calls[1]!).params[0]!.pageKey).toBe('next-page')
    expect(bodyOf(fetchMock.mock.calls[0]!).params[0]!.pageKey).toBeUndefined()
    expect(leg.hasMore).toBe(true)
  })
})

describe('capped reads stay one contiguous window', () => {
  it('drops the uncapped direction\'s rows older than where the capped direction stopped', async () => {
    // Outbound: busy — every page is full and offers another, so it caps at
    // block 0x3e8 (1000). Inbound: sparse — one recent row and one a year old.
    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => {
      const params = (JSON.parse(String(init?.body)) as Body).params[0]!
      if (params.fromAddress) {
        return rpcResult([transfer({ hash: '0xout', from: ACCOUNT, to: OTHER, blockNum: '0x3e8' })], 'more')
      }
      return rpcResult([
        transfer({ hash: '0xin-recent', blockNum: '0x7d0' }), // 2000
        transfer({ hash: '0xin-at-floor', blockNum: '0x3e8' }), // 1000, kept
        transfer({ hash: '0xin-ancient', blockNum: '0xa' }), // 10, inside the gap
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchNormalTransactions(8453, ACCOUNT)

    expect(leg.hasMore).toBe(true)
    const hashes = leg.rows.map((r) => r.hash)
    expect(hashes).toContain('0xin-recent')
    expect(hashes).toContain('0xin-at-floor')
    expect(hashes).not.toContain('0xin-ancient')
  })
})

describe('ERC-20 leg (category erc20)', () => {
  it('maps token contract, symbol and decimals, and drops rows with no contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL, init?: RequestInit) => {
        const params = (JSON.parse(String(init?.body)) as Body).params[0]!
        if (params.fromAddress) return rpcResult([])
        return rpcResult([
          transfer({
            hash: '0xusdc',
            asset: 'USDC',
            category: 'erc20',
            rawContract: { value: '0x2625a0', address: USDC_BASE, decimal: '0x6' },
          }),
          transfer({ hash: '0xorphan', category: 'erc20', rawContract: { value: '0x1', address: null, decimal: null } }),
        ])
      }),
    )

    const leg = await fetchERC20Transfers(8453, ACCOUNT)

    expect(leg.rows).toHaveLength(1)
    expect(leg.rows[0]).toMatchObject({
      hash: '0xusdc',
      value: '2500000',
      contractAddress: USDC_BASE,
      tokenSymbol: 'USDC',
      tokenDecimal: '6',
    })
  })
})

describe('internal leg', () => {
  it('is skipped without a request — Alchemy offers no internal category on Base', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchInternalTransactions(8453, ACCOUNT)

    expect(leg).toEqual({ rows: [], hasMore: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('errors never carry the key', () => {
  it('redacts the key from an HTTP refusal body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          text: () => Promise.resolve('Unauthorized request to /v2/alc-test-key'),
        } as Response),
      ),
    )

    const err = (await fetchNormalTransactions(8453, ACCOUNT).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/^Alchemy transfers error \(chain 8453\): 401/)
    expect(err.message).not.toContain('alc-test-key')
    expect(err.message).toContain('[redacted]')
  })

  it('redacts the key from a JSON-RPC error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad key alc-test-key' } }),
        } as Response),
      ),
    )

    const err = (await fetchERC20Transfers(8453, ACCOUNT).catch((e: unknown) => e)) as Error
    expect(err.message).toBe('Alchemy transfers (chain 8453) refused request: -32600 bad key [redacted]')
  })
})
