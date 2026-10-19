import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'

/**
 * #4021 — the account card's "Last payment" probe. The owner ruling is ANY
 * outgoing transfer (owner sends included, incoming never), so the probe
 * takes the MAX of the chain read and the newest confirmed intent, skips
 * reverted and zero-value rows, refuses to cache a failed read's null, and
 * caches a settled result.
 */

const { fetchAccountTransactionsMock, findLastOutgoingIntentAtMock, logger } = vi.hoisted(() => ({
  fetchAccountTransactionsMock: vi.fn(),
  findLastOutgoingIntentAtMock: vi.fn(),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger,
}))

vi.mock('../aggregate.js', () => ({
  fetchAccountTransactions: (...args: unknown[]) => fetchAccountTransactionsMock(...args),
}))
vi.mock('../../../infra/repositories/dashboard.js', () => ({
  findLastOutgoingIntentAt: (...args: unknown[]) => findLastOutgoingIntentAtMock(...args),
}))

import { fetchLastOutgoingAt } from '../last-outgoing.js'

const ACCOUNT = { id: 'acc-1', chainId: 8453, address: '0xAbC0000000000000000000000000000000000001' }

function tx(overrides: {
  direction?: 'in' | 'out'
  isError?: boolean
  value?: string
  timestamp?: number
}) {
  return {
    hash: '0xtx',
    type: 'native' as const,
    from: ACCOUNT.address,
    to: '0xrecipient',
    value: overrides.value ?? '1000000',
    valueFormatted: '1',
    asset: 'ETH',
    decimals: 18,
    direction: overrides.direction ?? 'out',
    timestamp: overrides.timestamp ?? 1000,
    timestampSource: 'block' as const,
    blockNumber: 100,
    isError: overrides.isError ?? false,
  }
}

function chainRead(transactions: ReturnType<typeof tx>[], hadFailures = false) {
  return { transactions, hadFailures, truncated: false }
}

describe('fetchLastOutgoingAt (#4021)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // A distinct address per test: the cache is keyed on (chainId, address),
    // so tests share the key unless the address differs.
    ACCOUNT.address = `0xAbC${Math.random().toString(16).slice(2, 8).padEnd(36, '0')}`
  })

  it('an incoming transfer never counts, even the newest row', async () => {
    fetchAccountTransactionsMock.mockResolvedValue(
      chainRead([tx({ direction: 'out', timestamp: 100 }), tx({ direction: 'in', timestamp: 200 })]),
    )
    findLastOutgoingIntentAtMock.mockResolvedValue(null)

    await expect(
      fetchLastOutgoingAt(ACCOUNT.id, ACCOUNT.chainId, ACCOUNT.address, logger),
    ).resolves.toBe(new Date(100 * 1000).toISOString())
  })

  it('a reverted send moved nothing and never counts; a zero-value call neither', async () => {
    fetchAccountTransactionsMock.mockResolvedValue(
      chainRead([
        tx({ isError: true, timestamp: 300 }),
        tx({ value: '0', timestamp: 250 }),
        tx({ direction: 'out', timestamp: 100 }),
      ]),
    )
    findLastOutgoingIntentAtMock.mockResolvedValue(null)

    await expect(
      fetchLastOutgoingAt(ACCOUNT.id, ACCOUNT.chainId, ACCOUNT.address, logger),
    ).resolves.toBe(new Date(100 * 1000).toISOString())
  })

  it('the confirmed intent covers a payment the explorer rows never surfaced', async () => {
    fetchAccountTransactionsMock.mockResolvedValue(chainRead([tx({ timestamp: 100 })]))
    const intentAt = new Date('2026-10-01T12:00:00.000Z')
    findLastOutgoingIntentAtMock.mockResolvedValue(intentAt)

    await expect(
      fetchLastOutgoingAt(ACCOUNT.id, ACCOUNT.chainId, ACCOUNT.address, logger),
    ).resolves.toBe(intentAt.toISOString())
  })

  it('the owner send on-chain wins over an older intent — max of the two legs', async () => {
    fetchAccountTransactionsMock.mockResolvedValue(chainRead([tx({ timestamp: 500 })]))
    findLastOutgoingIntentAtMock.mockResolvedValue(new Date(200 * 1000))

    await expect(
      fetchLastOutgoingAt(ACCOUNT.id, ACCOUNT.chainId, ACCOUNT.address, logger),
    ).resolves.toBe(new Date(500 * 1000).toISOString())
  })

  it('no outgoing anything reads as null', async () => {
    fetchAccountTransactionsMock.mockResolvedValue(chainRead([tx({ direction: 'in' })]))
    findLastOutgoingIntentAtMock.mockResolvedValue(null)

    await expect(
      fetchLastOutgoingAt(ACCOUNT.id, ACCOUNT.chainId, ACCOUNT.address, logger),
    ).resolves.toBeNull()
  })

  it('a failed chain read is NOT cached as "no payments" — the next call retries', async () => {
    // A queue, not a positional chain: the db-mock ratchet counts
    // mockResolvedValueOnce occurrences, and this test needs none.
    let reads = 0
    fetchAccountTransactionsMock.mockImplementation(() => {
      reads += 1
      return Promise.resolve(reads === 1 ? chainRead([], true) : chainRead([]))
    })
    findLastOutgoingIntentAtMock.mockResolvedValue(null)
    await expect(
      fetchLastOutgoingAt(ACCOUNT.id, ACCOUNT.chainId, ACCOUNT.address, logger),
    ).resolves.toBeNull()
    expect(reads).toBe(1)

    // A settled null (a genuinely silent account) IS cached — one probe.
    await expect(
      fetchLastOutgoingAt(ACCOUNT.id, ACCOUNT.chainId, ACCOUNT.address, logger),
    ).resolves.toBeNull()
    expect(reads).toBe(2)

    await expect(
      fetchLastOutgoingAt(ACCOUNT.id, ACCOUNT.chainId, ACCOUNT.address, logger),
    ).resolves.toBeNull()
    expect(reads).toBe(2)
  })
})
