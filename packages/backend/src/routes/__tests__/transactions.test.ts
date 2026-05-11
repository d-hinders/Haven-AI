import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSafeTransactions, mergeX402Transactions } from '../transactions.js'
import type { FastifyBaseLogger } from 'fastify'
import pool from '../../db.js'

const SAFE_ADDRESS = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const LOWERCASE_SAFE_ADDRESS = SAFE_ADDRESS.toLowerCase()
const SENDER = '0x55C9d84427756D6f82480427Bb778F6dc0cC755E'
const TX_HASH = '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1'
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fetchSafeTransactions', () => {
  it('uses Safe Transaction Service transfers when Base Blockscout address history is empty', async () => {
    let safeServiceUrl = ''
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()

      if (url.includes('/token-transfers')) {
        return jsonResponse({ items: [], next_page_params: null })
      }

      if (url.includes('/addresses/') && url.includes('/transactions')) {
        return jsonResponse({ items: [], next_page_params: null })
      }

      if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
        safeServiceUrl = url
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
      safeAddress: LOWERCASE_SAFE_ADDRESS,
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
    expect(safeServiceUrl).toContain(`/safes/${SAFE_ADDRESS}/transfers/`)
  })
})

describe('mergeX402Transactions', () => {
  it('normalizes x402 funding intents into merchant-facing transactions', async () => {
    vi.spyOn(pool, 'query').mockResolvedValueOnce({
      rows: [
        {
          id: 'payment-id',
          tx_hash: TX_HASH,
          agent_id: 'agent-id',
          agent_name: 'Research assistant',
          safe_id: 'safe-id',
          safe_address: SAFE_ADDRESS,
          safe_name: 'Main wallet',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC_ADDRESS,
          to_address: '0x1111111111111111111111111111111111111111',
          amount_raw: '20000',
          amount_human: '0.02',
          x402_merchant_address: '0x2222222222222222222222222222222222222222',
          x402_resource_url: 'https://api.example.com/data',
          confirmed_at: '2026-05-08T11:50:10Z',
          created_at: '2026-05-08T11:49:55Z',
        },
      ],
    } as never)

    const result = await mergeX402Transactions(
      'user-id',
      [{
        id: 'safe-id',
        safe_address: SAFE_ADDRESS,
        chain_id: 8453,
        name: 'Main wallet',
      }],
      [{
        hash: TX_HASH,
        type: 'erc20',
        from: SAFE_ADDRESS,
        to: '0x1111111111111111111111111111111111111111',
        value: '20000',
        valueFormatted: '0.02',
        asset: 'USDC',
        decimals: 6,
        direction: 'out',
        timestamp: 1778240999,
        blockNumber: 45725826,
        isError: false,
        tokenAddress: USDC_ADDRESS,
        tokenSymbol: 'USDC',
        chainId: 8453,
        safeId: 'safe-id',
        safeAddress: SAFE_ADDRESS,
        safeName: 'Main wallet',
      }],
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      hash: TX_HASH,
      from: SAFE_ADDRESS,
      to: '0x2222222222222222222222222222222222222222',
      value: '20000',
      valueFormatted: '0.02',
      asset: 'USDC',
      direction: 'out',
      source: 'x402',
      x402ResourceUrl: 'https://api.example.com/data',
      x402MerchantAddress: '0x2222222222222222222222222222222222222222',
      safeId: 'safe-id',
      safeName: 'Main wallet',
      agentId: 'agent-id',
      agentName: 'Research assistant',
    })
  })
})
