/**
 * A read with a failed explorer leg is not cached.
 *
 * A cache hit reports `hadFailures: false`, so a cached failed read would
 * show its incomplete rows as complete for the rest of the TTL — the
 * partial-failure banner cleared on reload while the rows stayed missing.
 * Pins: a failed read is retried on the next (non-fresh) call and reports
 * the failure again; a healthy read is still served from cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockNormal } = vi.hoisted(() => ({ mockNormal: vi.fn() }))

vi.mock('../receive.js', () => ({ ingestInboundTransfers: async () => undefined }))
vi.mock('../../../infra/repositories/inbound-transfers.js', () => ({
  findOwnerUserIdForAccount: async () => 'user-1',
}))
vi.mock('../../../infra/explorer-api.js', () => ({
  fetchNormalTransactions: (...a: unknown[]) => mockNormal(...a),
  fetchInternalTransactions: async () => ({ rows: [], hasMore: false }),
  fetchERC20Transfers: async () => ({ rows: [], hasMore: false }),
}))

import { fetchAccountTransactions } from '../aggregate.js'

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never

function read(accountAddress: string) {
  return fetchAccountTransactions({ accountId: 'acct-1', accountAddress, chainId: 8453, log })
}

describe('failed explorer reads are not cached', () => {
  beforeEach(() => {
    mockNormal.mockReset()
  })

  it('retries a failed read on the next call and reports the failure again', async () => {
    const address = '0x00000000000000000000000000000000000000a1'
    mockNormal.mockRejectedValue(new Error('Blockscout v2 error (chain 8453): 403'))

    const first = await read(address)
    const second = await read(address)

    expect(first.hadFailures).toBe(true)
    expect(second.hadFailures).toBe(true)
    expect(mockNormal).toHaveBeenCalledTimes(2)
  })

  it('still serves a healthy read from cache', async () => {
    const address = '0x00000000000000000000000000000000000000a2'
    mockNormal.mockResolvedValue({ rows: [], hasMore: false })

    const first = await read(address)
    const second = await read(address)

    expect(first.hadFailures).toBe(false)
    expect(second.hadFailures).toBe(false)
    expect(mockNormal).toHaveBeenCalledTimes(1)
  })
})
