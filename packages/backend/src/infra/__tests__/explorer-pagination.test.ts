/**
 * The pagination loops behind the explorer legs (#2884).
 *
 * These stub `fetch`, so they prove the loop's SHAPE — cursor following,
 * page increments, the budget — not the explorers' behaviour under it (a
 * 429 on page 7 is the live providers' answer, not a stub's; the loop keeps
 * the pre-existing retry-then-fail path, and a failed leg is unknown rather
 * than truncated, which `transactions-truncation.test.ts` pins).
 *
 * Both mechanisms #2882 distinguished are exercised here on both sides of
 * the budget: Blockscout v2 by its `next_page_params` cursor, the
 * Etherscan-shaped v1 legs by walking pages until one comes back short —
 * `offset` is requested explicitly there, so a short page is a real
 * completion signal once the loop can actually reach one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EXPLORER_MAX_PAGES,
  EXPLORER_PAGE_SIZE,
  fetchERC20Transfers,
  fetchInternalTransactions,
  fetchNormalTransactions,
} from '../explorer-api.js'

const SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response)
}

function blockscoutNativeItems(count: number, firstBlock: number) {
  return Array.from({ length: count }, (_, i) => ({
    hash: `0x${(firstBlock + i).toString(16).padStart(64, '0')}`,
    block_number: firstBlock + i,
    timestamp: '2026-05-08T11:49:59Z',
    from: { hash: '0xAAAA0000000000000000000000000000000000A1' },
    to: { hash: SAFE },
    value: '1000000000000000000',
    gas_limit: '21000',
    gas_used: '21000',
    status: 'ok',
    method: null,
  }))
}

function etherscanRows(count: number, firstBlock: number) {
  return Array.from({ length: count }, (_, i) => ({
    blockNumber: String(firstBlock + i),
    timeStamp: '1778240999',
    hash: `0x${(firstBlock + i).toString(16).padStart(64, '0')}`,
    from: '0xAAAA0000000000000000000000000000000000A1',
    to: SAFE,
    value: '1000000000000000000',
    gas: '21000',
    gasUsed: '21000',
    isError: '0',
    functionName: '',
  }))
}

/** The `page` query param of the Nth fetch call (Etherscan legs). */
function requestedPage(call: unknown[]): string {
  const url = new URL(String(call[0]))
  return url.searchParams.get('page') ?? ''
}

/** True when the Nth fetch call carries the cursor params (Blockscout legs). */
function carriesCursor(call: unknown[], cursor: Record<string, unknown>): boolean {
  const url = new URL(String(call[0]))
  return Object.entries(cursor).every(
    ([k, v]) => url.searchParams.get(k) === String(v),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Blockscout v2 legs — cursor following (fetchNormalTransactions on 8453)', () => {
  it('follows next_page_params across pages and stops when the cursor is absent', async () => {
    const cursorPage2 = { block_number: 44_999_900, index: 7, items_count: 50 }
    const cursorPage3 = { block_number: 44_999_800, index: 3, items_count: 50 }
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input)
      if (!url.includes('block_number=')) {
        return jsonResponse({ items: blockscoutNativeItems(40, 45_000_000), next_page_params: cursorPage2 })
      }
      if (url.includes('block_number=44999900')) {
        return jsonResponse({ items: blockscoutNativeItems(40, 44_999_900), next_page_params: cursorPage3 })
      }
      return jsonResponse({ items: blockscoutNativeItems(40, 44_999_800), next_page_params: null })
    })
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchNormalTransactions(8453, SAFE)

    // 120 rows — well past the one-window cap this issue removes.
    expect(leg.rows).toHaveLength(120)
    expect(leg.hasMore).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // The cursor the provider handed back is what page 2 requested.
    expect(carriesCursor(fetchMock.mock.calls[1], cursorPage2)).toBe(true)
    expect(carriesCursor(fetchMock.mock.calls[2], cursorPage3)).toBe(true)
    // The leg's own static params (here: none beyond the resource path) are
    // not lost between hops.
    expect(String(fetchMock.mock.calls[1][0])).toContain(`/addresses/${SAFE}/transactions`)
  })

  it('stops at EXPLORER_MAX_PAGES with hasMore true — the capped read', async () => {
    // The provider always offers another page: the budget is the only thing
    // that ends the loop, and the leg must say the read was capped.
    const fetchMock = vi.fn(() =>
      jsonResponse({
        items: blockscoutNativeItems(40, 45_000_000),
        next_page_params: { block_number: 1, index: 0, items_count: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchNormalTransactions(8453, SAFE)

    expect(fetchMock).toHaveBeenCalledTimes(EXPLORER_MAX_PAGES)
    expect(leg.rows).toHaveLength(40 * EXPLORER_MAX_PAGES)
    expect(leg.hasMore).toBe(true)
  })

  it('does not report hasMore when one page holds more than EXPLORER_PAGE_SIZE rows', async () => {
    // The provider sets its own page size, so a row count means nothing —
    // only the cursor does. A generous page with no cursor is complete.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        jsonResponse({
          items: blockscoutNativeItems(EXPLORER_PAGE_SIZE + 30, 45_000_000),
          next_page_params: null,
        }),
      ),
    )

    const leg = await fetchNormalTransactions(8453, SAFE)

    expect(leg.rows).toHaveLength(EXPLORER_PAGE_SIZE + 30)
    expect(leg.hasMore).toBe(false)
  })

  it('applies the same loop to the ERC-20 leg', async () => {
    const transferItems = Array.from({ length: 10 }, (_, i) => ({
      transaction_hash: `0x${(46_000_000 + i).toString(16).padStart(64, '0')}`,
      block_number: 46_000_000 + i,
      timestamp: '2026-05-08T11:49:59Z',
      from: { hash: '0xAAAA0000000000000000000000000000000000A1' },
      to: { hash: SAFE },
      total: { value: '1000000', decimals: '6' },
      token: { address_hash: '0xusdc', name: 'USD Coin', symbol: 'USDC', decimals: '6' },
    }))
    const fetchMock = vi.fn((_input: string | URL) =>
      jsonResponse({
        items: transferItems,
        next_page_params: { block_number: 1, index: 0, items_count: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchERC20Transfers(8453, SAFE)

    expect(fetchMock).toHaveBeenCalledTimes(EXPLORER_MAX_PAGES)
    expect(leg.rows).toHaveLength(10 * EXPLORER_MAX_PAGES)
    expect(leg.hasMore).toBe(true)
    // The ERC-20 filter param rides along on every hop.
    expect(String(fetchMock.mock.calls[1][0])).toContain('type=ERC-20')
  })
})

describe('Etherscan-shaped v1 legs — page walking (chain 100)', () => {
  it('increments page until a short page comes back', async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const action = new URL(String(input)).searchParams.get('action')
      if (action === 'txlist') {
        const page = Number(requestedPage([input]))
        // Pages 1 and 2 full, page 3 short: the source is exhausted there.
        const count = page < 3 ? EXPLORER_PAGE_SIZE : 20
        return jsonResponse({ status: '1', message: 'OK', result: etherscanRows(count, 45_000_000 - page) })
      }
      return jsonResponse({ status: '1', message: 'OK', result: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchNormalTransactions(100, SAFE)

    expect(leg.rows).toHaveLength(EXPLORER_PAGE_SIZE * 2 + 20)
    expect(leg.hasMore).toBe(false)
    expect(fetchMock.mock.calls.map(requestedPage)).toEqual(['1', '2', '3'])
    // `offset` is requested explicitly on every hop — the page size is ours.
    expect(String(fetchMock.mock.calls[1][0])).toContain(`offset=${EXPLORER_PAGE_SIZE}`)
  })

  it('stops at EXPLORER_MAX_PAGES on all-full pages with hasMore true', async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const action = new URL(String(input)).searchParams.get('action')
      if (action === 'txlist') {
        return jsonResponse({ status: '1', message: 'OK', result: etherscanRows(EXPLORER_PAGE_SIZE, 45_000_000) })
      }
      return jsonResponse({ status: '1', message: 'OK', result: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchNormalTransactions(100, SAFE)

    expect(fetchMock).toHaveBeenCalledTimes(EXPLORER_MAX_PAGES)
    expect(fetchMock.mock.calls.map(requestedPage)).toEqual(['1', '2', '3', '4'])
    expect(leg.rows).toHaveLength(EXPLORER_PAGE_SIZE * EXPLORER_MAX_PAGES)
    expect(leg.hasMore).toBe(true)
  })

  it('stops after one fetch when the first page is already short', async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const action = new URL(String(input)).searchParams.get('action')
      if (action === 'txlist') {
        return jsonResponse({ status: '1', message: 'OK', result: etherscanRows(3, 45_000_000) })
      }
      return jsonResponse({ status: '1', message: 'OK', result: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchNormalTransactions(100, SAFE)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(leg.rows).toHaveLength(3)
    expect(leg.hasMore).toBe(false)
  })

  it('pages the internal-transactions leg the same way', async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const action = new URL(String(input)).searchParams.get('action')
      if (action === 'txlistinternal') {
        return jsonResponse({ status: '1', message: 'OK', result: etherscanRows(10, 44_000_000) })
      }
      return jsonResponse({ status: '1', message: 'OK', result: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const leg = await fetchInternalTransactions(100, SAFE)

    // 10 < 50: short first page, loop ends — the leg is bounded by content,
    // not by the budget.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(leg.rows).toHaveLength(10)
    expect(leg.hasMore).toBe(false)
  })
})
