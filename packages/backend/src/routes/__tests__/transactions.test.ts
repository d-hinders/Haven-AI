import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSafeTransactions } from '../transactions.js'
import type { FastifyBaseLogger } from 'fastify'

const SAFE_ADDRESS = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const SENDER = '0x55C9d84427756D6f82480427Bb778F6dc0cC755E'
const TX_HASH = '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1'
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('fetchSafeTransactions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses Safe Transaction Service transfers when Base Blockscout address history is empty', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()

      if (url.includes('/token-transfers')) {
        return jsonResponse({ items: [], next_page_params: null })
      }

      if (url.includes('/addresses/') && url.includes('/transactions')) {
        return jsonResponse({ items: [], next_page_params: null })
      }

      if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
        return jsonResponse({
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              type: 'ERC20_TRANSFER',
              executionDate: '2026-05-08T11:49:59Z',
              blockNumber: 45725826,
              transactionHash: TX_HASH,
              to: SAFE_ADDRESS,
              value: '20000',
              tokenAddress: USDC_ADDRESS,
              tokenInfo: {
                type: 'ERC20',
                address: USDC_ADDRESS,
                name: 'USDC',
                symbol: 'USDC',
                decimals: 6,
              },
              from: SENDER,
            },
          ],
        })
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchSafeTransactions({
      safeId: 'safe-id',
      safeAddress: SAFE_ADDRESS,
      chainId: 8453,
      log: { warn: vi.fn() } as unknown as FastifyBaseLogger,
      fresh: true,
    })

    expect(result.hadFailures).toBe(false)
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0]).toMatchObject({
      hash: TX_HASH,
      type: 'erc20',
      from: SENDER,
      to: SAFE_ADDRESS,
      value: '20000',
      valueFormatted: '0.02',
      asset: 'USDC',
      decimals: 6,
      direction: 'in',
      timestamp: 1778240999,
      blockNumber: 45725826,
      isError: false,
      tokenAddress: USDC_ADDRESS,
      tokenSymbol: 'USDC',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://api.safe.global/tx-service/base/api/v1/safes/',
      ),
    )
  })
})
