/**
 * #3669 (epic #3634, decision (c), #3635) — chain 100 (Gnosis) is KNOWN but not
 * SUPPORTED: its history keeps rendering, and nothing is ever written for it.
 *
 * Pins, through the real aggregator with the explorer read and the inbound
 * ingest stood in:
 *   - a chain-100 account's history still resolves its asset symbol and
 *     decimals from the known registry entry (the provider's wrong
 *     `tokenDecimal` is overridden by the registry's 6 for USDC.e);
 *   - `ingestInboundTransfers` is NOT called for chain 100 (read-only) and IS
 *     called for Base (8453), so the skip is the split, not a dead ingest.
 *
 * The collaborators are mocked because this asserts the call decision, not what
 * the ingest does to the database (that is `receive-ingest.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIngest, mockErc20 } = vi.hoisted(() => ({ mockIngest: vi.fn(), mockErc20: vi.fn() }))

vi.mock('../receive.js', () => ({ ingestInboundTransfers: (...a: unknown[]) => mockIngest(...a) }))
vi.mock('../../../infra/repositories/inbound-transfers.js', () => ({
  findOwnerUserIdForAccount: async () => 'user-1',
}))
vi.mock('../../../infra/explorer-api.js', () => ({
  fetchNormalTransactions: async () => ({ rows: [], hasMore: false }),
  fetchInternalTransactions: async () => ({ rows: [], hasMore: false }),
  fetchERC20Transfers: (...a: unknown[]) => mockErc20(...a),
}))

import { fetchAccountTransactions } from '../aggregate.js'
import { getExplorerUrl } from '../../../domain/chains.js'

const ACCOUNT = '0x00000000000000000000000000000000000000aa'
const USDC_E_GNOSIS = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0'
const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never

function transfer(hash: string) {
  return {
    blockNumber: '10',
    timeStamp: '1700000000',
    hash,
    from: '0x00000000000000000000000000000000000000bb',
    to: ACCOUNT,
    value: '2500000',
    contractAddress: USDC_E_GNOSIS,
    tokenName: 'x',
    tokenSymbol: 'WRONG',
    tokenDecimal: '18', // the provider is wrong on purpose; the registry decides
  }
}

describe('chain-100 history is known-but-read-only (#3669)', () => {
  beforeEach(() => {
    mockIngest.mockReset().mockResolvedValue(undefined)
    mockErc20.mockReset().mockResolvedValue({ rows: [transfer('0xh100')], hasMore: false })
  })

  it('renders chain-100 history with the registry symbol and decimals', async () => {
    const res = await fetchAccountTransactions({
      accountId: 'acct-100',
      accountAddress: ACCOUNT,
      chainId: 100,
      log,
      fresh: true,
    })
    expect(res.transactions).toHaveLength(1)
    expect(res.transactions[0]).toMatchObject({ asset: 'USDC.e', decimals: 6, valueFormatted: '2.50', direction: 'in' })
  })

  it('persisted chain-100 rows still get a Gnosis explorer link', () => {
    expect(getExplorerUrl(100, 'tx', '0xabc')).toBe('https://gnosisscan.io/tx/0xabc')
  })

  it('attempts NO inbound_transfers write for chain 100', async () => {
    await fetchAccountTransactions({ accountId: 'acct-100', accountAddress: ACCOUNT, chainId: 100, log, fresh: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('still ingests for a supported chain (Base)', async () => {
    mockErc20.mockResolvedValue({ rows: [], hasMore: false })
    await fetchAccountTransactions({ accountId: 'acct-8453', accountAddress: ACCOUNT, chainId: 8453, log, fresh: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(mockIngest).toHaveBeenCalledTimes(1)
    expect(mockIngest.mock.calls[0]![0]).toMatchObject({ id: 'acct-8453', chainId: 8453 })
  })
})
