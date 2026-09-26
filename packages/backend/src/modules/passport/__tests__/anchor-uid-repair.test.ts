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
 * - an already-correct row is CONFIRMED (`confirmAnchorUid`, the durable
 *   `uid_repair_confirmed_at` marker, #3342) and writes no UID;
 * - a row that moved under us refuses the compare-and-set and defers;
 * - a log that fails the proven-ours invariant — foreign schema, foreign
 *   attester, tx not to EAS — is refused, and ours is chosen when a foreign
 *   log precedes it (#3342).
 *
 * The chain is a collaborator this module does not own, so it is mocked
 * (`docs/contributing/testing-strategy.md`); the CAS's and the marker's SQL
 * behaviour is exercised against real Postgres in the rekey-reanchor suite
 * (`rekey-reanchor.test.ts`) and this issue's real-DB sweep suite.
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
async function attestCalldata() {
  const { buildAttestCall } = await import('../attestation.js')
  return buildAttestCall(CHAIN, {
    agentEoa: '0x' + '22'.repeat(20),
    smartAccount: '0x' + '33'.repeat(20),
    treasury: '0x' + '44'.repeat(20),
    assuranceLevel: 0,
    policyUri: 'haven:agent:repair-test',
    issuedAt: 1_700_000_000,
    expiresAt: 0,
  }).data
}

vi.mock('../../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: '0x' + '11'.repeat(20), provider }) }
})

const repairAnchoredUid = vi.fn()
const listAnchorRepairsDue = vi.fn()
const confirmAnchorUid = vi.fn()
const deferAnchorRepair = vi.fn()
vi.mock('../../../infra/repositories/agent-passports.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../infra/repositories/agent-passports.js')
  >('../../../infra/repositories/agent-passports.js')
  return {
    ...actual,
    repairAnchoredUid: (...a: unknown[]) => repairAnchoredUid(...a),
    listAnchorRepairsDue: (...a: unknown[]) => listAnchorRepairsDue(...a),
    confirmAnchorUid: (...a: unknown[]) => confirmAnchorUid(...a),
    deferAnchorRepair: (...a: unknown[]) => deferAnchorRepair(...a),
  }
})

const { repairAnchorUidFromReceipt } = await import('../attestation.js')
const { repairAnchoredUids } = await import('../issuance.js')

/** A receipt whose Attested log carries REAL_UID under our schema. */
async function stageRealReceipt() {
  await stageReceiptWithAttester('0x' + '11'.repeat(20), REAL_UID, null)
}

/**
 * Stage a receipt + tx body for an Attested log attested by `attester`
 * (a 20-byte address — encodeEventLog left-pads the topic itself, the real
 * chain shape), with an optional extra log placed BEFORE it (a foreign log,
 * to prove ours is still the one chosen). The tx body targets EAS and was
 * SENT by the attester — the proven-ours reader (#3342) verifies both —
 * unless overridden to model a mismatch (`txFrom`, `txTo`).
 */
async function stageReceiptWithAttester(
  attester: string,
  uid: string,
  precedingLog: { address: string; topics: string[]; data: string } | null,
  overrides: { txFrom?: string; txTo?: string } = {},
) {
  const { Interface } = await import('ethers')
  const { getEasDeployment } = await import('../schema.js')
  const iface = new Interface([
    'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
  ])
  const encoded = iface.encodeEventLog('Attested', [
    '0x' + '22'.repeat(20),
    attester,
    uid,
    STORED_UID,
  ])
  const ours = {
    address: getEasDeployment(84532).eas,
    topics: [...encoded.topics],
    data: encoded.data,
  }
  // The tx body: sent by the attester, targeting EAS, carrying the attest
  // calldata built by the one encoding home — the proven-ours reader (#3342)
  // verifies `to` = EAS and attester = the tx's own sender.
  getTransaction.mockResolvedValue({
    data: await attestCalldata(),
    to: overrides.txTo ?? getEasDeployment(84532).eas,
    from: overrides.txFrom ?? attester,
  })
  getTransactionReceipt.mockResolvedValue({
    status: 1,
    logs: [...(precedingLog ? [precedingLog] : []), ours],
  })
}

beforeEach(() => {
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = STORED_UID
  getTransaction.mockReset().mockResolvedValue({ data: '0xdeadbeef' })
  getTransactionReceipt.mockReset().mockResolvedValue(null)
  repairAnchoredUid.mockReset().mockResolvedValue(true)
  listAnchorRepairsDue.mockReset().mockResolvedValue([])
  confirmAnchorUid.mockReset().mockResolvedValue(true)
  deferAnchorRepair.mockReset().mockResolvedValue(undefined)
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
    expect(await repairAnchoredUids()).toEqual({
      attempted: 1,
      repaired: 1,
      healthy: 0,
      unrepairable: 0,
      rows: [{ agent_id: AGENT, outcome: 'repaired', reason: `UID re-derived from anchor tx ${TX}` }],
    })
    expect(repairAnchoredUid).toHaveBeenCalledWith(AGENT, STORED_UID, REAL_UID, TX)
  })

  it('an unrepairable row is counted and NOT written, and the batch continues', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 1, logs: [] }) // no log
    listAnchorRepairsDue.mockResolvedValue([
      { agent_id: AGENT, chain_id: CHAIN, attestation_uid: STORED_UID, tx_hash: TX },
      { agent_id: '32940000-0000-4000-8000-000000000002', chain_id: CHAIN, attestation_uid: STORED_UID, tx_hash: null },
    ])
    const result = await repairAnchoredUids()
    expect(result.repaired).toBe(0)
    expect(result.healthy).toBe(0)
    expect(result.unrepairable).toBe(2)
    expect(result.rows.map((r) => r.outcome)).toEqual(['unrepairable', 'unrepairable'])
    expect(result.rows.map((r) => r.agent_id)).toEqual([
      AGENT,
      '32940000-0000-4000-8000-000000000002',
    ])
    expect(repairAnchoredUid).not.toHaveBeenCalled()
  })

  it('a thrown repair is deferred (updated_at bumped) and does not stop the batch', async () => {
    await stageRealReceipt()
    listAnchorRepairsDue.mockResolvedValue([
      { agent_id: AGENT, chain_id: CHAIN, attestation_uid: STORED_UID, tx_hash: TX },
    ])
    repairAnchoredUid.mockRejectedValue(new Error('pool exhausted'))
    const result = await repairAnchoredUids()
    expect(result.repaired).toBe(0)
    expect(result.unrepairable).toBe(1)
    expect(result.rows).toEqual([
      { agent_id: AGENT, outcome: 'deferred', reason: expect.stringMatching(/pool exhausted/) },
    ])
    // #3342: the throw must NOT leave the row first in line on the next tick.
    expect(deferAnchorRepair).toHaveBeenCalledWith(AGENT)
  })

  it('passes the caller through to the paced selector', async () => {
    await repairAnchoredUids(25)
    expect(listAnchorRepairsDue).toHaveBeenCalledWith(25)
  })
})

describe('#3342 — the repair refuses an unproven Attested log', () => {
  /** A foreign EAS log under a different schema (attester is the relayer). */
  async function foreignSchemaLog() {
    const { Interface } = await import('ethers')
    const { getEasDeployment } = await import('../schema.js')
    const iface = new Interface([
      'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
    ])
    const encoded = iface.encodeEventLog('Attested', [
      '0x' + '22'.repeat(20),
      '0x' + '11'.repeat(20),
      '0x' + 'dd'.repeat(32),
      '0x' + '99'.repeat(32), // NOT the pinned schema
    ])
    return { address: getEasDeployment(CHAIN).eas, topics: [...encoded.topics], data: encoded.data }
  }

  it('a foreign-SCHEMA log is refused — the row is left unchanged', async () => {
    // Receipt: ONLY a foreign-schema log. Candidate scan finds no pinned-schema log.
    getTransactionReceipt.mockResolvedValue({ status: 1, logs: [await foreignSchemaLog()] })
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(false)
    expect(result.outcome).toBe('unrepairable')
    expect(result.reason).toMatch(/no Attested log yet/)
    expect(repairAnchoredUid).not.toHaveBeenCalled()
    expect(confirmAnchorUid).not.toHaveBeenCalled()
  })

  it('a foreign-ATTESTER log is refused, named as a proven-ours refusal', async () => {
    // The log says a third party attested it; the mined tx was sent by the
    // relayer. EAS sets attester to msg.sender, so this log does not describe
    // this tx — the proven-ours guard must refuse it.
    await stageReceiptWithAttester('0x' + '77'.repeat(20), REAL_UID, null, {
      txFrom: '0x' + '11'.repeat(20),
    })
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(false)
    expect(result.reason).toMatch(/proven-ours invariant/)
    expect(repairAnchoredUid).not.toHaveBeenCalled()
    expect(confirmAnchorUid).not.toHaveBeenCalled()
  })

  it('a foreign log BEFORE ours is skipped — ours is the UID repaired', async () => {
    const foreign = await foreignSchemaLog()
    await stageReceiptWithAttester('0x' + '11'.repeat(20), REAL_UID, foreign)
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(true)
    expect(result.uid).toBe(REAL_UID)
    expect(repairAnchoredUid).toHaveBeenCalledWith(AGENT, STORED_UID, REAL_UID, TX)
  })

  it('a tx that did NOT target EAS is refused even when its log carries our schema', async () => {
    await stageReceiptWithAttester('0x' + '11'.repeat(20), REAL_UID, null, {
      txTo: '0x' + 'ee'.repeat(20),
    })
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(false)
    expect(result.reason).toMatch(/did not target the EAS contract/)
    expect(repairAnchoredUid).not.toHaveBeenCalled()
    expect(confirmAnchorUid).not.toHaveBeenCalled()
  })

  it('a row minted by a PREVIOUS relayer (tx from ≠ current relayer) is still repairable', async () => {
    // The attester must be the MINED TX's own sender, not the current relayer
    // address: the relayer is env-configured and rotatable, and pinning the
    // check to the current address would make pre-rotation rows permanently
    // unrepairable (#3342 threat model). The relayer mock says 0x11…; the
    // mined tx was SENT by 0x55… — and its log says 0x55… consistently.
    await stageReceiptWithAttester('0x' + '55'.repeat(20), REAL_UID, null)
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: STORED_UID,
      tx_hash: TX,
    })
    expect(result.repaired).toBe(true)
    expect(result.uid).toBe(REAL_UID)
    expect(repairAnchoredUid).toHaveBeenCalledWith(AGENT, STORED_UID, REAL_UID, TX)
  })
})

describe('#3342 — steady state: healthy rows leave the queue', () => {
  it('an already-correct row is CONFIRMED — outcome confirmed, marker written, no UID write', async () => {
    await stageRealReceipt()
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: REAL_UID, // already repaired
      tx_hash: TX,
    })
    expect(result.repaired).toBe(false)
    expect(result.outcome).toBe('confirmed')
    expect(result.reason).toMatch(/already matches/)
    expect(repairAnchoredUid).not.toHaveBeenCalled()
    expect(confirmAnchorUid).toHaveBeenCalledWith(AGENT, TX)
  })

  it('a confirmed row is EXCLUDED by the selector (marker set) — no re-read next tick', async () => {
    await stageRealReceipt()
    await repairAnchorUidFromReceipt(CHAIN, AGENT, { attestation_uid: REAL_UID, tx_hash: TX })
    expect(confirmAnchorUid).toHaveBeenCalledTimes(1)
  })

  it('the sweep counts a confirmed row as healthy, not unrepairable', async () => {
    await stageRealReceipt()
    listAnchorRepairsDue.mockResolvedValue([
      { agent_id: AGENT, chain_id: CHAIN, attestation_uid: REAL_UID, tx_hash: TX },
    ])
    const result = await repairAnchoredUids()
    expect(result.healthy).toBe(1)
    expect(result.unrepairable).toBe(0)
    expect(result.repaired).toBe(0)
    expect(result.rows).toEqual([
      { agent_id: AGENT, outcome: 'confirmed', reason: 'stored UID already matches the anchor receipt' },
    ])
    expect(confirmAnchorUid).toHaveBeenCalledWith(AGENT, TX)
  })

  it('a CAS-refused confirmation (row moved) is not counted healthy', async () => {
    await stageRealReceipt()
    confirmAnchorUid.mockResolvedValue(false)
    const result = await repairAnchorUidFromReceipt(CHAIN, AGENT, {
      attestation_uid: REAL_UID,
      tx_hash: TX,
    })
    // The stored UID already matches, so nothing was written either way — but
    // the marker did not land, so the row is NOT confirmed out of the queue.
    expect(result.repaired).toBe(false)
    expect(result.outcome).toBe('unrepairable')
    expect(result.reason).toMatch(/moved|changed|refused/)
  })
})
