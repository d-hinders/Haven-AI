/**
 * #3294 — the UID repair for rows anchored before the fix.
 *
 * Pre-fix, `anchorOnChain` recorded the `staticCall` prediction. EAS derives
 * the UID from inputs that include the landing block, so that value never
 * existed on-chain: every revoke of it reverts `NotFound()` while the agent's
 * REAL attestation stays live (dev ran one such row to 590 revoke attempts).
 *
 * The repair re-derives the real UID from the row's own anchor receipt and
 * updates the row — ONLY on positive evidence. What this file pins:
 *
 * - a differing log UID is swapped in (the headline);
 * - no tx hash, an unreadable receipt, or no derivable UID leaves the row
 *   UNCHANGED and REPORTED — never guessed (criterion 3);
 * - an already-correct row costs one receipt read and writes nothing;
 * - a row that moved under us refuses the compare-and-set and defers.
 *
 * The chain is a collaborator this module does not own, so it is mocked
 * (`docs/contributing/testing-strategy.md`); the CAS's SQL behaviour is
 * exercised against real Postgres in the revocation-convergence suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const AGENT = '32940000-0000-4000-8000-000000000001'
const CHAIN = 84532
const TX = '0x' + 'cd'.repeat(32)
const STORED_UID = '0x' + 'ab'.repeat(32)
/** What the anchor receipt's Attested log actually carries — the real one. */
const REAL_UID = '0x' + 'ef'.repeat(32)

const getTransaction = vi.fn()
const getTransactionReceipt = vi.fn()
const provider = { getTransaction, getTransactionReceipt }

/** Real attest calldata for the claimed mint — built by the one encoding home. */
async function stageAttestCalldata() {
  const { buildAttestCall } = await import('../attestation.js')
  const call = buildAttestCall(CHAIN, {
    agentEoa: '0x' + '22'.repeat(20),
    smartAccount: '0x' + '33'.repeat(20),
    treasury: '0x' + '44'.repeat(20),
    assuranceLevel: 0,
    policyUri: 'haven:agent:repair-test',
    issuedAt: 1_700_000_000,
    expiresAt: 0,
  })
  getTransaction.mockResolvedValue({ data: call.data })
}

vi.mock('../../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: '0x' + '11'.repeat(20), provider }) }
})

const repairAnchoredUid = vi.fn()
const listAnchorRepairsDue = vi.fn()
vi.mock('../../../infra/repositories/agent-passports.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../infra/repositories/agent-passports.js')
  >('../../../infra/repositories/agent-passports.js')
  return {
    ...actual,
    repairAnchoredUid: (...a: unknown[]) => repairAnchoredUid(...a),
    listAnchorRepairsDue: (...a: unknown[]) => listAnchorRepairsDue(...a),
  }
})

const { repairAnchorUidFromReceipt } = await import('../attestation.js')
const { repairAnchoredUids } = await import('../issuance.js')

/** A receipt whose Attested log carries REAL_UID under our schema. */
async function stageRealReceipt() {
  const { Interface } = await import('ethers')
  const iface = new Interface([
    'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
  ])
  const encoded = iface.encodeEventLog('Attested', [
    '0x' + '22'.repeat(20),
    '0x' + '11'.repeat(20),
    REAL_UID,
    STORED_UID,
  ])
  await stageAttestCalldata()
  getTransactionReceipt.mockResolvedValue({
    status: 1,
    logs: [{ address: '0x4200000000000000000000000000000000000021', topics: [...encoded.topics], data: encoded.data }],
  })
}

beforeEach(() => {
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = STORED_UID
  getTransaction.mockReset().mockResolvedValue({ data: '0xdeadbeef' })
  getTransactionReceipt.mockReset().mockResolvedValue(null)
  repairAnchoredUid.mockReset().mockResolvedValue(true)
  listAnchorRepairsDue.mockReset().mockResolvedValue([])
})

describe('#3294 — repairAnchorUidFromReceipt', () => {
  it('swaps the stored prediction for the anchor receipt log UID', async () => {
    await stageRealReceipt()

    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(true)
    expect(result.uid).toBe(REAL_UID)
    expect(repairAnchoredUid).toHaveBeenCalledWith(AGENT, STORED_UID, REAL_UID, TX)
  })

  it('a row with NO tx_hash is left unchanged and reported, never guessed', async () => {
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: null,
    })
    expect(result.repaired).toBe(false)
    expect(result.reason).toMatch(/no anchor tx_hash/)
    expect(repairAnchoredUid).not.toHaveBeenCalled()
    expect(getTransactionReceipt).not.toHaveBeenCalled()
  })

  it('an unreadable receipt is reported, not guessed at', async () => {
    getTransactionReceipt.mockRejectedValue(new Error('rpc unreachable'))
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(false)
    expect(result.reason).toMatch(/unreadable/)
    expect(repairAnchoredUid).not.toHaveBeenCalled()
  })

  it('a receipt that cannot be found (pending/dropped) leaves the row unchanged', async () => {
    getTransactionReceipt.mockResolvedValue(null)
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(false)
    expect(repairAnchoredUid).not.toHaveBeenCalled()
  })

  it('a mined-but-reverted anchor tx is reported, not guessed at', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 0, logs: [] })
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(false)
    expect(result.reason).toMatch(/unreadable/)
    expect(repairAnchoredUid).not.toHaveBeenCalled()
  })

  it('a receipt with no Attested log leaves the row unchanged', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 1, logs: [] })
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(false)
    expect(repairAnchoredUid).not.toHaveBeenCalled()
  })

  it('is idempotent: a row already holding the receipt UID writes nothing', async () => {
    await stageRealReceipt()
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: REAL_UID, // already repaired
      tx_hash: TX,
    })
    expect(result.repaired).toBe(false)
    expect(result.reason).toMatch(/already matches/)
    expect(repairAnchoredUid).not.toHaveBeenCalled()
  })

  it('a row that moved under us refuses the CAS and defers', async () => {
    await stageRealReceipt()
    repairAnchoredUid.mockResolvedValue(false)
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(false)
    expect(result.reason).toMatch(/changed since/)
    // The repair still tried — it just lost the race.
    expect(repairAnchoredUid).toHaveBeenCalledWith(AGENT, STORED_UID, REAL_UID, TX)
  })
})

describe('#3294 — the repair sweep (repairAnchoredUids)', () => {
  it('repairs a batched row and counts the outcome', async () => {
    await stageRealReceipt()
    listAnchorRepairsDue.mockResolvedValue([
      { agent_id: AGENT, chain_id: CHAIN, attestation_uid: STORED_UID, tx_hash: TX },
    ])
    expect(await repairAnchoredUids()).toEqual({ attempted: 1, repaired: 1, unrepairable: 0 })
    expect(repairAnchoredUid).toHaveBeenCalledWith(AGENT, STORED_UID, REAL_UID, TX)
  })

  it('an unrepairable row is counted and NOT written, and the batch continues', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 1, logs: [] }) // no log
    listAnchorRepairsDue.mockResolvedValue([
      { agent_id: AGENT, chain_id: CHAIN, attestation_uid: STORED_UID, tx_hash: TX },
      { agent_id: '32940000-0000-4000-8000-000000000002', chain_id: CHAIN, attestation_uid: STORED_UID, tx_hash: null },
    ])
    const result = await repairAnchoredUids()
    expect(result).toEqual({ attempted: 2, repaired: 0, unrepairable: 2 })
    expect(repairAnchoredUid).not.toHaveBeenCalled()
  })

  it('a thrown repair (transient pool error) does not stop the batch', async () => {
    await stageRealReceipt()
    listAnchorRepairsDue.mockResolvedValue([
      { agent_id: AGENT, chain_id: CHAIN, attestation_uid: STORED_UID, tx_hash: TX },
    ])
    repairAnchoredUid.mockRejectedValue(new Error('pool exhausted'))
    const result = await repairAnchoredUids()
    expect(result).toEqual({ attempted: 1, repaired: 0, unrepairable: 1 })
  })

  it('passes the caller through to the paced selector', async () => {
    await repairAnchoredUids(25)
    expect(listAnchorRepairsDue).toHaveBeenCalledWith(25)
  })
})
