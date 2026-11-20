/**
 * The inbound-hash discovery read behind the merchant index (#5012).
 *
 * What is pinned here and nowhere else: the read asks Alchemy for ONE token
 * into ONE address, oldest first, inside the range it was given, and follows
 * `pageKey` to the end — past the feed's four-page budget — so a burst between
 * two reads is not cut off. A page that fails stops the read with every hash
 * before the block it was in, never a hash it cannot vouch for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>()
  return { config: { ...actual.config, alchemyHistoryApiKey: 'alc-test-key' } }
})

import {
  ALCHEMY_INBOUND_MAX_PAGES,
  ALCHEMY_INBOUND_PAGE_SIZE,
  EXPLORER_MAX_PAGES,
  discoverInboundTokenTransferHashes,
} from '../explorer-api.js'

const ACCOUNT = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

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

function rpcError() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }),
  } as Response)
}

function transfer(block: number, hash: string) {
  return {
    blockNum: `0x${block.toString(16)}`,
    hash,
    from: '0xAAAA0000000000000000000000000000000000A1',
    to: ACCOUNT,
    asset: 'USDC',
    category: 'erc20',
    rawContract: { value: '0xf4240', address: USDC, decimal: '0x6' },
  }
}

function hashOf(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('discoverInboundTokenTransferHashes (#5012)', () => {
  it('asks for one token into one address, oldest first, inside the range', async () => {
    const fetchMock = vi.fn(() => rpcResult([transfer(120, hashOf(1))]))
    vi.stubGlobal('fetch', fetchMock)

    const found = await discoverInboundTokenTransferHashes(84532, ACCOUNT, USDC, 100, 400)

    expect(found).toEqual({ ok: true, txHashes: [hashOf(1)] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = bodyOf(fetchMock.mock.calls[0]!)
    expect(body.method).toBe('alchemy_getAssetTransfers')
    expect(body.params[0]).toMatchObject({
      fromBlock: '0x64',
      toBlock: '0x190',
      toAddress: ACCOUNT,
      contractAddresses: [USDC],
      category: ['erc20'],
      order: 'asc',
      maxCount: `0x${ALCHEMY_INBOUND_PAGE_SIZE.toString(16)}`,
    })
    expect(body.params[0]).not.toHaveProperty('fromAddress')
  })

  it('follows pageKey past the feed page budget: 1,000 transfers over 10 pages are all found', async () => {
    const pages = 10
    const perPage = 100
    expect(pages).toBeGreaterThan(EXPLORER_MAX_PAGES)
    let call = 0
    const fetchMock = vi.fn(() => {
      const page = call++
      const rows = Array.from({ length: perPage }, (_, i) => {
        const n = page * perPage + i
        return transfer(1_000 + n, hashOf(n + 1))
      })
      return rpcResult(rows, page < pages - 1 ? `key-${page + 1}` : undefined)
    })
    vi.stubGlobal('fetch', fetchMock)

    const found = await discoverInboundTokenTransferHashes(84532, ACCOUNT, USDC, 1_000, 5_000)

    expect(fetchMock).toHaveBeenCalledTimes(pages)
    expect(found?.ok).toBe(true)
    expect(found?.txHashes).toHaveLength(pages * perPage)
    expect(new Set(found?.txHashes).size).toBe(pages * perPage)
    // Each later page carries the pageKey the previous one returned.
    expect(bodyOf(fetchMock.mock.calls[3]!).params[0]!.pageKey).toBe('key-3')
  })

  it('names a transaction once when it carries several transfers into the account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => rpcResult([transfer(120, hashOf(7)), transfer(120, hashOf(7)), transfer(121, hashOf(8))])),
    )
    const found = await discoverInboundTokenTransferHashes(84532, ACCOUNT, USDC, 100, 400)
    expect(found).toEqual({ ok: true, txHashes: [hashOf(7), hashOf(8)] })
  })

  it('stops part-way at a failed page and vouches only for the blocks before the last one read', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call++
        if (call === 1) return rpcResult([transfer(120, hashOf(1)), transfer(150, hashOf(2))], 'key-1')
        return rpcError()
      }),
    )

    const found = await discoverInboundTokenTransferHashes(84532, ACCOUNT, USDC, 100, 400)

    // Block 150 may continue on the page that failed, so the read vouches for
    // blocks up to 149. The hash in block 150 is still named; the caller keeps
    // only legs at or below `readThroughBlock`.
    expect(found).toEqual({ ok: false, txHashes: [hashOf(1), hashOf(2)], readThroughBlock: 149 })
  })

  it('reports nothing read in full when the first page fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => rpcError()))
    expect(await discoverInboundTokenTransferHashes(84532, ACCOUNT, USDC, 100, 400)).toEqual({
      ok: false,
      txHashes: [],
      readThroughBlock: null,
    })
  })

  it('treats a pageKey that never ends as a failure at the page guard', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call++
        return rpcResult([transfer(100 + call, hashOf(call))], 'again')
      }),
    )
    const found = await discoverInboundTokenTransferHashes(84532, ACCOUNT, USDC, 100, 1_000)
    expect(call).toBe(ALCHEMY_INBOUND_MAX_PAGES)
    expect(found?.ok).toBe(false)
  })

  it('answers null for a chain Alchemy is not configured for', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await discoverInboundTokenTransferHashes(100, ACCOUNT, USDC, 1, 2)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
