/**
 * #1556 — the passport anchor keeps its durable outbound record honestly:
 * opened BEFORE the broadcast, stamped with the broadcast's own hash/nonce,
 * closed from the receipt. The queue module is mocked with spies (its real
 * database behaviour is proven in `infra/__tests__/outbound-queue.test.ts`);
 * what THIS file pins is the call-site ordering, which is the crash-survival
 * property: enqueue-after-broadcast would record nothing a crash could lose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TX_HASH = '0x' + 'cd'.repeat(32)
const UID = '0x' + 'ab'.repeat(32)

const trace: string[] = []
type Stamp = { hash: string; nonce: number | bigint }
const broadcastSpy = vi.fn(async (stamp: Stamp) => {
  trace.push('record:broadcast')
  void stamp
})
const minedSpy = vi.fn(async () => {
  trace.push('record:mined')
})
const failedSpy = vi.fn(async () => {
  trace.push('record:failed')
})
type OpenParams = { chainId: number; submitter: string; to: string; data: string }
const openSpy = vi.fn(async (params: OpenParams) => {
  trace.push('record:open')
  void params
  return { id: 'rec-1', broadcast: broadcastSpy, mined: minedSpy, failed: failedSpy }
})

vi.mock('../../../infra/outbound-queue.js', () => ({ openOutboundRecord: openSpy }))

vi.mock('../../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: '0x' + '11'.repeat(20) }) }
})

// Faithful to ethers v6: a mined-and-reverted tx makes wait() THROW a
// CALL_EXCEPTION — it never resolves `{ status: 0 }` (#1556 review: a mock
// that returned status 0 made the revert branch look covered while the real
// path was dead code).
let waitReverts = false
const wait = async () => {
  if (waitReverts) {
    const err = new Error('transaction execution reverted') as Error & { code: string }
    err.code = 'CALL_EXCEPTION'
    throw err
  }
  return { status: 1 }
}
vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers')
  class FakeContract {
    attest = Object.assign(
      async () => {
        trace.push('broadcast')
        return {
          hash: TX_HASH,
          nonce: 77,
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000n,
          wait,
        }
      },
      { staticCall: async () => UID },
    )
    revoke = async () => {
      trace.push('broadcast')
      return { hash: TX_HASH, nonce: 78, wait }
    }
  }
  return { ...actual, Contract: FakeContract }
})

const { anchorOnChain, revokeOnChain } = await import('../attestation.js')

const CLAIM = {
  agentEoa: '0x' + '22'.repeat(20),
  smartAccount: '0x' + '33'.repeat(20),
  treasury: '0x' + '44'.repeat(20),
  assuranceLevel: 0,
  policyUri: 'https://example.test/policy',
  issuedAt: 1_700_000_000,
  expiresAt: 1_800_000_000,
}

beforeEach(() => {
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = UID
  trace.length = 0
  waitReverts = false
  vi.clearAllMocks()
})

describe('passport anchor outbound record (#1556)', () => {
  it('attest: opens the record BEFORE broadcasting, stamps the hash, closes mined', async () => {
    const result = await anchorOnChain(84532, CLAIM)

    expect(result.txHash).toBe(TX_HASH)
    expect(trace).toEqual(['record:open', 'broadcast', 'record:broadcast', 'record:mined'])
    expect(openSpy.mock.calls[0][0]).toMatchObject({ chainId: 84532, submitter: 'passport_attest' })
    // The stamp carries the broadcast's own identifiers — what the unmined
    // scan (#1558) keys on.
    expect(broadcastSpy.mock.calls[0][0]).toMatchObject({ hash: TX_HASH, nonce: 77 })
    // The record's calldata is the exact bytes a bump would re-broadcast.
    expect((openSpy.mock.calls[0][0] as { data: string }).data.length).toBeGreaterThan(200)
  })

  it('attest: a REVERT (wait throws, per real ethers v6) closes the record as failed', async () => {
    waitReverts = true
    await expect(anchorOnChain(84532, CLAIM)).rejects.toThrow('reverted')
    expect(trace).toEqual(['record:open', 'broadcast', 'record:broadcast', 'record:failed'])
    expect(minedSpy).not.toHaveBeenCalled()
  })

  it('revoke: same shape — open before broadcast, mined on success', async () => {
    await revokeOnChain(84532, UID)
    expect(trace).toEqual(['record:open', 'broadcast', 'record:broadcast', 'record:mined'])
    expect(openSpy.mock.calls[0][0]).toMatchObject({ submitter: 'passport_revoke' })
  })
})
