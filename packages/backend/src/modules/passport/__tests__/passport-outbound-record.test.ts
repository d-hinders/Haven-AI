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

// The pipeline is mocked here: its real lock/sign/stamp behaviour is proven
// in passport-relayer-lock.test.ts and infra tests; THIS file pins the call
// sites' ordering and fence wiring (recordId passed through).
const submitSpy = vi.fn(async (params: { recordId: string | null }) => {
  trace.push('broadcast')
  void params
  return {
    hash: TX_HASH,
    nonce: 77,
    wait: async () => {
      if (waitReverts) {
        const err = new Error('transaction execution reverted') as Error & { code: string }
        err.code = 'CALL_EXCEPTION'
        throw err
      }
      return { status: 1 }
    },
  }
})
vi.mock('../../../infra/outbound-queue.js', () => ({
  openOutboundRecord: openSpy,
  submitRecorded: submitSpy,
}))

vi.mock('../../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: '0x' + '11'.repeat(20) }) }
})

// Faithful to ethers v6: a mined-and-reverted tx makes wait() THROW a
// CALL_EXCEPTION — it never resolves `{ status: 0 }` (#1556 review). The
// throw lives in submitSpy's returned wait above.
let waitReverts = false
vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers')
  class FakeContract {
    attest = Object.assign(
      async () => {
        throw new Error('direct contract broadcast — must go through submitRecorded (#1559)')
      },
      { staticCall: async () => UID },
    )
    revoke = async () => {
      throw new Error('direct contract broadcast — must go through submitRecorded (#1559)')
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
  it('attest: opens the record BEFORE submitting, hands the pipeline the fence id, closes mined', async () => {
    const result = await anchorOnChain(84532, CLAIM)

    expect(result.txHash).toBe(TX_HASH)
    // The stamp now lives INSIDE the pipeline (#1559) — the site's job is the
    // ordering and the fence wiring.
    expect(trace).toEqual(['record:open', 'broadcast', 'record:mined'])
    expect(openSpy.mock.calls[0][0]).toMatchObject({ chainId: 84532, submitter: 'passport_attest' })
    expect(submitSpy.mock.calls[0][0]).toMatchObject({ recordId: 'rec-1', chainId: 84532 })
    // The record's calldata is the exact bytes a bump would re-broadcast.
    expect((openSpy.mock.calls[0][0] as { data: string }).data.length).toBeGreaterThan(200)
  })

  it('attest: a REVERT (wait throws, per real ethers v6) closes the record as failed', async () => {
    waitReverts = true
    await expect(anchorOnChain(84532, CLAIM)).rejects.toThrow('reverted')
    expect(trace).toEqual(['record:open', 'broadcast', 'record:failed'])
    expect(minedSpy).not.toHaveBeenCalled()
  })

  it('revoke: same shape — open before submit, fence id through, mined on success', async () => {
    await revokeOnChain(84532, UID)
    expect(trace).toEqual(['record:open', 'broadcast', 'record:mined'])
    expect(openSpy.mock.calls[0][0]).toMatchObject({ submitter: 'passport_revoke' })
    expect(submitSpy.mock.calls[0][0]).toMatchObject({ recordId: 'rec-1' })
  })
})
