import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { fetchX402ActivityTransactions } from '@/lib/x402-activity-transactions'

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const SECOND_SAFE_ADDRESS = '0x4444444444444444444444444444444444444444'
const MERCHANT_ADDRESS = '0x2222222222222222222222222222222222222222'
const TOKEN_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

function payment(overrides: Record<string, unknown> = {}) {
  return {
    type: 'payment',
    id: 'payment-1',
    agent_id: 'agent-1',
    agent_name: 'Research agent',
    token: 'USDC',
    token_address: TOKEN_ADDRESS,
    amount_raw: '1000000',
    amount: '1',
    to: MERCHANT_ADDRESS,
    status: 'confirmed',
    tx_hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
    source: 'x402',
    x402_resource_url: 'https://api.example.com/data',
    x402_merchant_address: MERCHANT_ADDRESS,
    safe_address: SAFE_ADDRESS,
    explorer_url: null,
    confirmed_at: '2026-05-08T11:49:59Z',
    created_at: '2026-05-08T11:49:00Z',
    ...overrides,
  }
}

function mockBridgeResponses({
  activity,
  agents = [],
  safes,
}: {
  activity: unknown[]
  agents?: unknown[]
  safes: unknown[]
}) {
  mockApiGet.mockImplementation(async (path: string) => {
    if (path === '/agent-activity/feed?limit=100') {
      return { activity }
    }
    if (path === '/agents') {
      return { agents }
    }
    if (path === '/auth/me') {
      return { safes }
    }
    throw new Error(`Unexpected path: ${path}`)
  })
}

describe('x402 activity transaction bridge', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  it('does not resolve duplicate same-address Safes without chain context', async () => {
    mockBridgeResponses({
      activity: [payment()],
      safes: [
        { id: 'safe-gnosis', safe_address: SAFE_ADDRESS, chain_id: 100, name: 'Gnosis wallet' },
        { id: 'safe-base', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Base wallet' },
      ],
    })

    await expect(fetchX402ActivityTransactions()).resolves.toEqual([])
  })

  it('resolves duplicate same-address Safes when chain context is present', async () => {
    mockBridgeResponses({
      activity: [payment({ chain_id: 8453 })],
      safes: [
        { id: 'safe-gnosis', safe_address: SAFE_ADDRESS, chain_id: 100, name: 'Gnosis wallet' },
        { id: 'safe-base', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Base wallet' },
      ],
    })

    const transactions = await fetchX402ActivityTransactions()

    expect(transactions).toHaveLength(1)
    expect(transactions[0]).toMatchObject({
      safeId: 'safe-base',
      chainId: 8453,
      safeName: 'Base wallet',
      safeAddress: SAFE_ADDRESS,
    })
  })

  it('rejects activity with a Safe ID and chain mismatch', async () => {
    mockBridgeResponses({
      activity: [payment({ safe_id: 'safe-base', chain_id: 100 })],
      safes: [
        { id: 'safe-base', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Base wallet' },
      ],
    })

    await expect(fetchX402ActivityTransactions()).resolves.toEqual([])
  })

  it('uses explicit activity Safe identity even if the agent current Safe changed', async () => {
    mockBridgeResponses({
      activity: [payment({ safe_id: 'safe-old', chain_id: 8453 })],
      agents: [{
        id: 'agent-1',
        name: 'Research agent',
        safe_id: 'safe-current',
        safe_address: SECOND_SAFE_ADDRESS,
        safe_name: 'Current wallet',
        allowances: [],
      }],
      safes: [
        { id: 'safe-old', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Old wallet' },
        { id: 'safe-current', safe_address: SECOND_SAFE_ADDRESS, chain_id: 8453, name: 'Current wallet' },
      ],
    })

    const transactions = await fetchX402ActivityTransactions()

    expect(transactions).toHaveLength(1)
    expect(transactions[0]).toMatchObject({
      safeId: 'safe-old',
      safeAddress: SAFE_ADDRESS,
      safeName: 'Old wallet',
      chainId: 8453,
    })
  })

  it('does not default missing chain context to Gnosis', async () => {
    mockBridgeResponses({
      activity: [payment({ safe_id: 'stale-safe', chain_id: null })],
      safes: [],
    })

    await expect(fetchX402ActivityTransactions()).resolves.toEqual([])
  })
})
