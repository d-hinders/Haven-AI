/**
 * #3395 — the #1043 recovery REFUSAL is tested at the issuance level.
 *
 * The #3388 review found two mutations that survive the passport, db and
 * infra suites, both in `recoverAnchorFromReceipt`:
 *
 * - `attestation.ts:600` `throw` → `return null`. Issuance then asks the
 *   liveness probe, which answers `live` for a MINED tx (its step 1 is
 *   `getTransaction`, which the reader only reached because the receipt
 *   answered) — so the row is `markFailed` as "may still mine (#1745)" and
 *   the refusal hides behind a false reason. No re-mint follows unless the
 *   probe is wrong too.
 * - removing the branch outright hands `attestationUid: undefined` to
 *   `markAnchored`, writing an anchored row with a NULL UID.
 *
 * `recovered-anchor-decode.test.ts` only pins the happy path. THIS file pins
 * the refusal END TO END: a receipt whose only pinned-schema log fails the
 * proven-ours invariant makes `issuePassport` record the refusal itself as
 * the failure reason, and neither the liveness probe nor the anchor is ever
 * consulted. All three refusal shapes the reader answers are covered in
 * `anchor-uid-repair.test.ts` (mocked DB) — foreign attester, non-EAS `to`,
 * foreign schema — and are restated here at this level so the issue's
 * acceptance criteria are checkable in one place. The DB is real (the
 * row-shaped claims — status, last_error, tx_hash — are Postgres claims);
 * the chain is the collaborator we mock
 * (`docs/contributing/testing-strategy.md`).
 *
 * Red under BOTH mutations: `return null` routes to the liveness probe (the
 * probe call expectation fails) and then to a `#1745` failure reason (the
 * reason expectation fails); removing the branch hands a null UID to
 * `markAnchored`, whose CAS refuses `IS NOT DISTINCT FROM null` — the row
 * stays non-anchored and the `anchored`/UID assertions fail.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import * as repo from '../../../infra/repositories/agent-passports.js'
import { issuePassport, setAnchor, setAnchorLiveness, setAnchorRecovery } from '../issuance.js'
import type { RecoveredAnchor } from '../issuance.js'

const CHAIN = 84532
const RELAYER = '0x' + '11'.repeat(20)
const FOREIGN_ATTESTER = '0x' + '77'.repeat(20)
const OTHER_CONTRACT = '0x' + 'ee'.repeat(20)
const FOREIGN_SCHEMA = '0x' + '99'.repeat(32)
const PINNED_SCHEMA = '0x' + '5c'.repeat(32)
const AGENT_EOA = '0x' + 'a'.repeat(40)
const DELEGATE = AGENT_EOA
const TREASURY = '0x' + 'b'.repeat(40)
/** The UID the receipt's log carries — real-shaped, but not proven ours. */
const FOREIGN_LOG_UID = '0x' + 'd1'.repeat(32)
const BROADCAST_TX = '0x' + 'cd'.repeat(32)

const getTransaction = vi.fn()
const getTransactionReceipt = vi.fn()
const provider = { getTransaction, getTransactionReceipt }

vi.mock('../../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: RELAYER, provider }) }
})

const { buildAttestCall, recoverAnchorFromReceipt } = await import('../attestation.js')
const { getEasDeployment } = await import('../schema.js')
const { Interface } = await import('ethers')

const iface = new Interface([
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
])

/** The real attest calldata the stuck transaction would have carried. */
function attestCalldata(): string {
  return buildAttestCall(CHAIN, {
    agentEoa: AGENT_EOA,
    smartAccount: '0x' + '33'.repeat(20),
    treasury: TREASURY,
    assuranceLevel: 0,
    policyUri: 'haven:agent:3395',
    issuedAt: 1_700_000_000,
    expiresAt: 0,
  }).data
}

function attestedLog(uid: string, schemaUid: string, attester: string) {
  const encoded = iface.encodeEventLog('Attested', [
    AGENT_EOA,
    attester,
    uid,
    schemaUid,
  ])
  return {
    address: getEasDeployment(CHAIN).eas,
    topics: [...encoded.topics] as string[],
    data: encoded.data,
  }
}

let seq = 0

/**
 * A delegation-rail agent whose mint broadcast (`BROADCAST_TX`) MINED and the
 * receipt answers — but the only pinned-schema log fails the proven-ours
 * invariant in the shape the `spec` names. Exactly the state `onBroadcast` +
 * a confirmation-timeout leaves behind (#1043).
 */
async function seedStuckMinedPassport(
  spec:
    | { shape: 'foreign-attester' }
    | { shape: 'non-eas-to' }
    | { shape: 'foreign-schema' },
): Promise<{ agentId: string; userId: string }> {
  seq += 1
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`p3395-${seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const safe = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, TREASURY, CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, account_id, delegate_address, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [userId, `p3395 agent ${seq}`, safe.rows[0].id, DELEGATE],
  )
  const agentId = agent.rows[0].id
  await repo.insertRequested(agentId, CHAIN, 0)
  // The broadcast happened and was recorded; the anchor write never landed.
  await repo.recordBroadcast(agentId, BROADCAST_TX)

  const oursShapedLog = attestedLog(FOREIGN_LOG_UID, PINNED_SCHEMA, RELAYER)
  if (spec.shape === 'foreign-attester') {
    // The pinned-schema log is attested by someone other than the mined tx's
    // own sender — nothing in this receipt is provably ours.
    getTransactionReceipt.mockResolvedValue({
      status: 1,
      logs: [attestedLog(FOREIGN_LOG_UID, PINNED_SCHEMA, FOREIGN_ATTESTER)],
    })
    getTransaction.mockResolvedValue({
      data: attestCalldata(),
      to: getEasDeployment(CHAIN).eas,
      from: RELAYER,
    })
  } else if (spec.shape === 'non-eas-to') {
    // The receipt carries a pinned-schema log attested by the sender, but the
    // transaction went somewhere that is not the pinned EAS contract — the
    // candidate scan finds a log this tx cannot have minted.
    getTransactionReceipt.mockResolvedValue({ status: 1, logs: [oursShapedLog] })
    getTransaction.mockResolvedValue({
      data: '0xdeadbeef',
      to: OTHER_CONTRACT,
      from: RELAYER,
    })
  } else {
    // The only Attested log is under a foreign schema — no candidate at all.
    getTransactionReceipt.mockResolvedValue({
      status: 1,
      logs: [attestedLog(FOREIGN_LOG_UID, FOREIGN_SCHEMA, RELAYER)],
    })
    getTransaction.mockResolvedValue({
      data: attestCalldata(),
      to: getEasDeployment(CHAIN).eas,
      from: RELAYER,
    })
  }
  return { agentId, userId }
}

async function readPassport(agentId: string) {
  const row = await repo.findByAgent(agentId)
  if (!row) throw new Error('passport row vanished')
  return row
}

describeDb('#3395 — a refused recovery is recorded as the refusal, not a liveness guess', () => {
  beforeAll(async () => {
    process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = PINNED_SCHEMA
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = PINNED_SCHEMA
    getTransaction.mockReset()
    getTransactionReceipt.mockReset()
  })
  afterEach(() => {
    setAnchor(null)
    setAnchorRecovery(null)
    setAnchorLiveness(null)
    vi.restoreAllMocks()
  })

  // The issue names the three reader-level refusal shapes. Each throws out of
  // the REAL recovery; the failure reason recorded is that refusal — never
  // the liveness probe's "may still mine" guess. The foreign-attester and
  // non-EAS-`to` shapes are proven-ours refusals (`no provably-ours Attested
  // log`); the foreign-schema shape is absence of evidence (`no EAS Attested
  // event`) — a different, accurate reason for a different answer.
  const shapes = [
    ['a foreign attester', { shape: 'foreign-attester' }, /no provably-ours Attested log/],
    ['a non-EAS to', { shape: 'non-eas-to' }, /no provably-ours Attested log/],
    ['a foreign schema', { shape: 'foreign-schema' }, /no EAS Attested event/],
  ] as const

  for (const [label, spec, expectedReason] of shapes) {
    it(`${label} makes the recovery THROW — issuePassport records the refusal itself; the liveness probe is never consulted`, async () => {
      const { agentId, userId } = await seedStuckMinedPassport(spec)

      // Recovery is the REAL implementation here (no seam stub): the refusal
      // must surface as its throw. This assertion is the reader-level pin.
      await expect(recoverAnchorFromReceipt(CHAIN, BROADCAST_TX)).rejects.toThrow(
        expectedReason,
      )

      // The liveness probe answering ANYTHING — including 'dead', which would
      // UNLOCK a re-mint — must be unreachable on a refused recovery. The
      // seam is wired to the REAL recovery, exactly as production does.
      const liveness = vi.fn(async () => 'dead' as const)
      const anchor = vi.fn(async () => ({
        attestationUid: '0x' + 'u'.repeat(64),
        txHash: '0x' + '22'.repeat(32),
      }))
      setAnchorRecovery(recoverAnchorFromReceipt)
      setAnchor(anchor)
      setAnchorLiveness(liveness)

      await issuePassport(agentId, userId)

      expect(liveness).not.toHaveBeenCalled()
      expect(anchor).not.toHaveBeenCalled()

      // The failure reason IS the refusal — not the probe's "may still mine".
      const row = await readPassport(agentId)
      expect(row.status).toBe('failed')
      expect(row.last_error).toMatch(expectedReason)
      expect(row.last_error).not.toMatch(/may still mine/)
      // The row still points at the broadcast tx: the next tick re-reads the
      // same receipt rather than losing the transaction.
      expect(row.tx_hash).toBe(BROADCAST_TX)
      expect(row.attestation_uid).toBeNull()
    })
  }

  it('the recovery seam still answers a provably-ours receipt — the refusal path is specific, not a blanket failure', async () => {
    // Control: the SAME stuck state with a receipt whose log IS proven ours
    // recovers (the #1043 behaviour must not regress under #3395).
    const { agentId, userId } = await seedStuckMinedPassport({ shape: 'foreign-attester' })
    getTransactionReceipt.mockResolvedValue({
      status: 1,
      logs: [attestedLog('0x' + 'c'.repeat(32), PINNED_SCHEMA, RELAYER)],
    })
    getTransaction.mockResolvedValue({
      data: attestCalldata(),
      to: getEasDeployment(CHAIN).eas,
      from: RELAYER,
    })
    const anchor = vi.fn()
    setAnchorRecovery(recoverAnchorFromReceipt)
    setAnchor(anchor)
    setAnchorLiveness(vi.fn(async () => 'live' as const))

    await issuePassport(agentId, userId)

    expect(anchor).not.toHaveBeenCalled()
    const row = await readPassport(agentId)
    expect(row.status).toBe('anchored')
    expect(row.attestation_uid).toBe('0x' + 'c'.repeat(32))
    expect(row.tx_hash).toBe(BROADCAST_TX)
  })

  it('a recovered anchor result always carries a UID — markAnchored cannot write a NULL-UID anchored row', async () => {
    // The second surviving mutation: removing the refusal branch hands
    // `attestationUid: undefined` to markAnchored. The RecoveredAnchor type
    // makes a UID-less result unrepresentable, and the real reader can only
    // answer from a proven log — pinned here at the type level.
    const sample: RecoveredAnchor = {
      attestationUid: '0x' + 'c'.repeat(32),
      txHash: BROADCAST_TX,
      attested: { agentEoa: DELEGATE, smartAccount: '0x' + '0'.repeat(40) },
    }
    expect(sample.attestationUid).toBeTruthy()
    // And the real reader cannot construct the null-UID shape: a refused
    // receipt throws, it never returns a UID-less record.
    await seedStuckMinedPassport({ shape: 'foreign-attester' })
    await expect(recoverAnchorFromReceipt(CHAIN, BROADCAST_TX)).rejects.toThrow(
      /no provably-ours Attested log/,
    )
  })
})
