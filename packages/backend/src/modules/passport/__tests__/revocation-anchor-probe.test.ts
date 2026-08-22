/**
 * #1758 — `readRevocationAnchor`: the probe that closes a stuck revocation.
 *
 * The question worth testing is not "does it return the right string", it is
 * **what does it take to get `'revoked'` out of it**, because that is the
 * answer that writes a TERMINAL state: `revocation_status = 'confirmed'` is
 * the one value `listStuckRevocations` never looks at again. Get it wrong and
 * the stuck-revoke alarm is silenced for an agent whose attestation is still
 * live and merchant-readable — the exact inversion of the alarm's purpose.
 *
 * So every test below either withholds `'revoked'` or pins the single fact
 * that earns it: a non-zero `revocationTime` read as of a SETTLED block.
 *
 * The chain is a collaborator this module does not own, so it is mocked
 * (`docs/contributing/testing-strategy.md`). The evidence lookup is the data
 * layer and is exercised against real Postgres in
 * `infra/repositories/__tests__/outbound-txs.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const RELAYER = '0x' + '11'.repeat(20)
const UID = '0x' + 'cd'.repeat(32)
const EVIDENCE_TX = '0x' + '11'.repeat(32)

/** Chain head, and the finalized block a healthy OP-stack node reports. */
const HEAD = 1_000
const FINALIZED = 900

const getBlockNumber = vi.fn()
const getBlock = vi.fn()
let provider: unknown = { getBlockNumber, getBlock }

vi.mock('../../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: RELAYER, provider }) }
})

const findOutboundEvidenceTxHash = vi.fn()
vi.mock('../../../infra/repositories/outbound-txs.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../infra/repositories/outbound-txs.js')
  >('../../../infra/repositories/outbound-txs.js')
  return {
    ...actual,
    findOutboundEvidenceTxHash: (...a: unknown[]) => findOutboundEvidenceTxHash(...a),
  }
})

/**
 * `getAttestation` per block. The whole reorg question is expressible only
 * because the answer can differ between the head and the settled block.
 */
const attestationByBlock = vi.fn()

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers')
  class FakeContract {
    getAttestation = async (uid: string, overrides?: { blockTag?: number }) =>
      attestationByBlock(uid, overrides?.blockTag)
  }
  return { ...actual, Contract: FakeContract }
})

const {
  readRevocationAnchor,
  buildRevokeCall,
  PASSPORT_REVOKE_SUBMITTER,
  SETTLED_CHAIN_READ_DEPTH_BLOCKS,
} = await import('../attestation.js')

/** What EAS returns: the real struct shape, revoked or not. */
function attestation(revocationTime: number, uid = UID) {
  return { uid, revocationTime: BigInt(revocationTime) }
}

/** What EAS returns for a UID it has never heard of — a ZEROED struct. */
const NOT_FOUND = { uid: '0x' + '00'.repeat(32), revocationTime: 0n }

beforeEach(() => {
  vi.clearAllMocks()
  provider = { getBlockNumber, getBlock }
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = UID
  getBlockNumber.mockResolvedValue(HEAD)
  getBlock.mockResolvedValue({ number: FINALIZED })
  attestationByBlock.mockResolvedValue(attestation(0))
  findOutboundEvidenceTxHash.mockResolvedValue(EVIDENCE_TX)
})

describe('readRevocationAnchor (#1758)', () => {
  it('a non-zero revocationTime at the FINALIZED block is the evidence that converges', async () => {
    attestationByBlock.mockResolvedValue(attestation(1_700_000_000))

    expect(await readRevocationAnchor(84532, UID)).toEqual({
      state: 'revoked',
      txHash: EVIDENCE_TX,
    })
    // Read as of the settled block, not the head — see the reorg test below.
    expect(attestationByBlock).toHaveBeenCalledWith(UID, FINALIZED)
  })

  it('REORG SAFETY: revoked at the head but not at the settled block reads LIVE', async () => {
    // The head can be re-orged away. Writing `confirmed` from it would silence
    // the stuck-revoke alarm permanently for an attestation that came back
    // live — the one direction that hurts. This is the test a mutation from
    // `settledReadBlock(...)` to `'latest'` has to fail.
    attestationByBlock.mockImplementation(async (_uid: string, block: number) =>
      block === HEAD ? attestation(1_700_000_000) : attestation(0),
    )

    expect(await readRevocationAnchor(84532, UID)).toEqual({ state: 'live', txHash: null })
  })

  it('a live attestation reads LIVE and costs no evidence lookup', async () => {
    expect(await readRevocationAnchor(84532, UID)).toEqual({ state: 'live', txHash: null })
    expect(findOutboundEvidenceTxHash).not.toHaveBeenCalled()
  })

  it('a UID not visible as of the settled block is UNKNOWN, never "not revoked"', async () => {
    // An attestation minted minutes ago legitimately does not exist at a
    // finalized block. Reading the zeroed struct's `revocationTime = 0` as
    // `live` would be reading a missing row as a fact about it.
    attestationByBlock.mockResolvedValue(NOT_FOUND)

    expect(await readRevocationAnchor(84532, UID)).toEqual({ state: 'unknown', txHash: null })
  })

  it('no provider is UNKNOWN — no evidence concludes nothing', async () => {
    provider = null

    expect(await readRevocationAnchor(84532, UID)).toEqual({ state: 'unknown', txHash: null })
    expect(attestationByBlock).not.toHaveBeenCalled()
  })

  it('a node that echoes the head for `finalized` falls back to a buried block', async () => {
    // Silently reading the head is exactly the exposure the settled read
    // exists to remove, so an unsupported tag must degrade, not pass through.
    getBlock.mockResolvedValue({ number: HEAD })
    attestationByBlock.mockResolvedValue(attestation(1_700_000_000))

    await readRevocationAnchor(84532, UID)

    expect(attestationByBlock).toHaveBeenCalledWith(UID, HEAD - SETTLED_CHAIN_READ_DEPTH_BLOCKS)
  })

  it('a chain with no settled vantage point is UNKNOWN', async () => {
    getBlockNumber.mockResolvedValue(10)
    getBlock.mockRejectedValue(new Error('unknown block tag'))

    expect(await readRevocationAnchor(84532, UID)).toEqual({ state: 'unknown', txHash: null })
    expect(attestationByBlock).not.toHaveBeenCalled()
  })

  it('revoked with NO recorded transaction is reported honestly, not papered over', async () => {
    attestationByBlock.mockResolvedValue(attestation(1_700_000_000))
    findOutboundEvidenceTxHash.mockResolvedValue(null)

    expect(await readRevocationAnchor(84532, UID)).toEqual({ state: 'revoked', txHash: null })
  })

  it('the evidence is looked up by the SAME submitter and calldata the revoke wrote', async () => {
    // Writer and reader drifting apart would not fail loudly — it would return
    // no evidence, and the row that could have converged would alarm forever.
    attestationByBlock.mockResolvedValue(attestation(1_700_000_000))

    await readRevocationAnchor(84532, UID)

    expect(findOutboundEvidenceTxHash).toHaveBeenCalledWith(
      84532,
      PASSPORT_REVOKE_SUBMITTER,
      buildRevokeCall(84532, UID).data,
    )
  })
})
