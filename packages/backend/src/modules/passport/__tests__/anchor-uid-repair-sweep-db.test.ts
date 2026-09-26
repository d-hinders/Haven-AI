/**
 * #3342 — the anchor-UID repair sweep against the REAL database.
 *
 * Every claim here is a claim about what Postgres returns, not about control
 * flow (the chain is mocked; the database is not — same split as
 * `revocation-convergence.test.ts`):
 *
 * - the STALL the issue measured (N = limit correct older rows + one phantom:
 *   3 ticks, `{"attempted":10,"repaired":0,"unrepairable":10}`) is gone — the
 *   phantom is repaired within `ceil(N/limit)+1` ticks and the healthy rows
 *   leave the queue instead of heading it forever;
 * - STEADY STATE: a confirmed row is not re-read — reads per tick are bounded
 *   independent of how many healthy rows precede a phantom (the acceptance
 *   criterion `updated_at` churn cannot meet);
 * - a repair that THROWS is deferred — it does not head the next tick;
 * - healthy rows are counted `healthy`, never folded into `unrepairable` or
 *   `repaired`.
 *
 * Each seeded row carries its OWN uid and anchor tx (the unique
 * `agent_passports_uid_idx` forbids sharing one UID across rows — real rows
 * never do), and the mock provider answers per tx hash: the receipt each row
 * is re-read from is THAT row's own anchor receipt, exactly the pre-fix
 * population's shape. The sweep function's isolation and accounting are
 * pinned in `anchor-uid-repair.test.ts` (DB mocked); THIS file pins the SQL —
 * the selector's marker exclusion, the CAS guards, the defer bump.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import * as repo from '../../../infra/repositories/agent-passports.js'
import { repairAnchoredUids } from '../issuance.js'

const CHAIN = 84532
const RELAYER = '0x' + '11'.repeat(20)
const PREVIOUS_RELAYER = '0x' + '55'.repeat(20)
const FOREIGN_ATTESTER = '0x' + '77'.repeat(20)
const FOREIGN_SCHEMA = '0x' + '99'.repeat(32)
const PINNED_SCHEMA = '0x' + '5c'.repeat(32)
/** The UID an anchor tx actually emitted — one per row, in the registry. */
const realUid = (n: number) => '0x' + (20 + n).toString(16).padStart(2, '0').repeat(32)
const phantomUid = (n: number) => '0x' + (200 + n).toString(16).padStart(2, '0').repeat(32)
const txOf = (n: number) => '0x' + (100 + n).toString(16).padStart(2, '0').repeat(32)

// The repair runs the REAL chain reader against a mocked provider: receipts
// are fixtures keyed by tx hash, the SQL is real.
const getTransaction = vi.fn()
const getTransactionReceipt = vi.fn()
const provider = { getTransaction, getTransactionReceipt }
vi.mock('../../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: RELAYER, provider }) }
})

const { buildAttestCall, repairAnchorUidFromReceipt } = await import('../attestation.js')
const { getEasDeployment } = await import('../schema.js')
const { Interface } = await import('ethers')

let seq = 0
type ReceiptSpec = { uid: string; schemaUid?: string; attester?: string; txFrom?: string; to?: string }
let receipts: Map<string, ReceiptSpec>

const iface = new Interface([
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
])

function attestedLog(uid: string, schemaUid: string, attester: string) {
  const encoded = iface.encodeEventLog('Attested', [
    '0x' + '22'.repeat(20),
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

async function txBodyFor(spec: ReceiptSpec) {
  return {
    data: buildAttestCall(CHAIN, {
      agentEoa: '0x' + '22'.repeat(20),
      smartAccount: '0x' + '33'.repeat(20),
      treasury: '0x' + '44'.repeat(20),
      assuranceLevel: 0,
      policyUri: 'haven:agent:3342',
      issuedAt: 1_700_000_000,
      expiresAt: 0,
    }).data,
    to: spec.to ?? getEasDeployment(CHAIN).eas,
    from: spec.txFrom ?? RELAYER,
  }
}

/** Point the mock provider at a per-tx receipt registry. */
function stageReceipts(specs: Record<string, ReceiptSpec>) {
  receipts = new Map(Object.entries(specs))
  getTransaction.mockImplementation(async (hash: string) => {
    const spec = receipts.get(hash)
    return spec ? txBodyFor(spec) : null
  })
  getTransactionReceipt.mockImplementation(async (hash: string) => {
    const spec = receipts.get(hash)
    if (!spec) return null
    return {
      status: 1,
      logs: [attestedLog(spec.uid, spec.schemaUid ?? PINNED_SCHEMA, spec.attester ?? RELAYER)],
    }
  })
}

/** One anchored passport row, aged past the selector's freshness guard. */
async function seedAnchoredRow(opts: {
  storedUid: string | null
  txHash: string
  older?: boolean
}): Promise<string> {
  seq += 1
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`p3342-${seq}-${Date.now()}@test.example`],
  )
  const safe = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id) VALUES ($1, $2, $3) RETURNING id`,
    [user.rows[0].id, '0x' + 'b'.repeat(40), CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, account_id, delegate_address, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [user.rows[0].id, `p3342 agent ${seq}`, safe.rows[0].id, '0x' + 'a'.repeat(40)],
  )
  const agentId = agent.rows[0].id
  await repo.insertRequested(agentId, CHAIN, 0)
  if (opts.storedUid !== null) {
    await repo.markAnchored(agentId, {
      attestationUid: opts.storedUid,
      txHash: opts.txHash,
      agentEoa: '0x' + 'a'.repeat(40),
      smartAccount: null,
    })
  } else {
    // A row whose UID was never recorded but whose anchor tx exists.
    await db.query(
      `UPDATE agent_passports SET status = 'anchored', tx_hash = $2,
         agent_eoa = $3, anchored_at = NOW(), updated_at = NOW()
       WHERE agent_id = $1`,
      [agentId, opts.txHash, '0x' + 'a'.repeat(40)],
    )
  }
  const age = opts.older ? '2 hours' : '90 minutes'
  await db.query(
    `UPDATE agent_passports SET anchored_at = NOW() - INTERVAL '${age}',
       updated_at = NOW() - INTERVAL '${age}' WHERE agent_id = $1`,
    [agentId],
  )
  return agentId
}

describeDb('#3342 — the repair sweep drains (real DB)', () => {
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

  it('STALL: N = limit healthy older rows + one phantom — the phantom is repaired within ceil(N/limit)+1 ticks and healthy rows stop being read', async () => {
    const limit = 4
    // The phantom is the OLDEST row (anchored_at furthest back), like the
    // issue's probe where it sits behind the correct rows.
    const phantom = await seedAnchoredRow({ storedUid: phantomUid(1), txHash: txOf(1), older: true })
    const healthy: string[] = []
    const specs: Record<string, ReceiptSpec> = {
      [txOf(1)]: { uid: realUid(1) }, // the phantom's OWN anchor receipt
    }
    for (let i = 0; i < limit; i += 1) {
      const n = i + 2
      healthy.push(await seedAnchoredRow({ storedUid: realUid(n), txHash: txOf(n) }))
      specs[txOf(n)] = { uid: realUid(n) }
    }
    stageReceipts(specs)

    // Tick 1: the batch is the oldest `limit` rows — the phantom (older) plus
    // limit-1 healthy rows. Healthy rows are CONFIRMED (marker set), the
    // phantom is REPAIRED — in ONE tick, not ceil(N/limit) round-robins.
    const tick1 = await repairAnchoredUids(limit)
    expect(tick1.repaired).toBe(1)
    expect(tick1.healthy).toBe(limit - 1)
    expect(tick1.unrepairable).toBe(0)

    const phantomRow = await repo.findByAgent(phantom)
    expect(phantomRow?.attestation_uid?.toLowerCase()).toBe(realUid(1))
    // Tick 2: the ONE healthy row that did not fit tick 1's batch (5 rows,
    // limit 4) — ceil(N/limit)+1 = 2 ticks to reach the phantom, exactly the
    // acceptance criterion. It is confirmed, not re-read afterwards.
    const tick2 = await repairAnchoredUids(limit)
    expect(tick2.attempted).toBe(1)
    expect(tick2.healthy).toBe(1)
    expect(tick2.repaired).toBe(0)

    // Tick 3: the queue is EMPTY, and the marker is durable — the confirmed
    // rows stay out even when aged again (no hourly round-robin).
    await db.query(
      `UPDATE agent_passports SET updated_at = NOW() - INTERVAL '3 hours' WHERE agent_id = ANY($1)`,
      [healthy],
    )
    const tick3 = await repairAnchoredUids(limit)
    expect(tick3.attempted).toBe(0)
  })

  it('STEADY STATE: reads per tick stay bounded as confirmed rows accumulate — the queue drains instead of round-robining', async () => {
    const limit = 3
    const specs: Record<string, ReceiptSpec> = {}
    for (let i = 0; i < 2 * limit; i += 1) {
      await seedAnchoredRow({ storedUid: realUid(i + 1), txHash: txOf(i + 1) })
      specs[txOf(i + 1)] = { uid: realUid(i + 1) }
    }
    stageReceipts(specs)
    // Tick 1: the oldest `limit` rows are confirmed and leave the queue.
    const tick1 = await repairAnchoredUids(limit)
    expect(tick1.attempted).toBe(limit)
    expect(tick1.healthy).toBe(limit)
    // Tick 2: the NEXT `limit` rows — the first batch is not re-read.
    const tick2 = await repairAnchoredUids(limit)
    expect(tick2.attempted).toBe(limit)
    expect(tick2.healthy).toBe(limit)
    // Tick 3: the queue is EMPTY — bounded reads, drained queue.
    const tick3 = await repairAnchoredUids(limit)
    expect(tick3.attempted).toBe(0)
    // Provider reads: one receipt + one tx per row ONCE — not per tick forever.
    expect(getTransactionReceipt.mock.calls.length).toBe(2 * limit)
    expect(getTransaction.mock.calls.length).toBe(2 * limit)
  })

  it('a repair that THROWS (uid collision on the unique index) is deferred — it does not head the next tick', async () => {
    // The poison row's receipt carries a UID that ANOTHER row already holds:
    // its CAS write violates agent_passports_uid_idx and throws.
    const poison = await seedAnchoredRow({ storedUid: phantomUid(1), txHash: txOf(1), older: true })
    const collisionHolder = await seedAnchoredRow({ storedUid: realUid(1), txHash: txOf(2) })
    const healthy = await seedAnchoredRow({ storedUid: realUid(3), txHash: txOf(3) })
    stageReceipts({
      [txOf(1)]: { uid: realUid(1) }, // collides with collisionHolder's stored UID
      [txOf(2)]: { uid: realUid(2) },
      [txOf(3)]: { uid: realUid(3) },
    })
    void collisionHolder
    void healthy

    const tick1 = await repairAnchoredUids(10)
    expect(tick1.repaired).toBe(1) // the healthy row
    expect(tick1.healthy).toBe(1) // the collision holder (matches its receipt)
    expect(tick1.unrepairable).toBe(1) // the poison row
    const deferred = tick1.rows.find((r) => r.outcome === 'deferred')
    expect(deferred?.agent_id).toBe(poison)
    expect(deferred?.reason).toMatch(/duplicate key|agent_passports_uid_idx/)

    // The defer bumped updated_at: the poison row is NOT due again within 1h.
    const due = await repo.listAnchorRepairsDue(10)
    expect(due.map((r) => r.agent_id)).not.toContain(poison)
  })

  it('a foreign-schema log is refused: the row stays as-is and is reported with its agent_id', async () => {
    const agentId = await seedAnchoredRow({ storedUid: phantomUid(1), txHash: txOf(1) })
    stageReceipts({ [txOf(1)]: { uid: realUid(1), schemaUid: FOREIGN_SCHEMA } })
    const result = await repairAnchorUidFromReceipt(CHAIN, agentId, {
      attestation_uid: phantomUid(1),
      tx_hash: txOf(1),
    })
    expect(result.repaired).toBe(false)
    expect(result.outcome).toBe('unrepairable')
    expect(result.reason).toMatch(/no Attested log yet/)
    const row = await repo.findByAgent(agentId)
    expect(row?.attestation_uid?.toLowerCase()).toBe(phantomUid(1))
    // Still due — never marked, never guessed.
    const due = await repo.listAnchorRepairsDue(10)
    expect(due.map((r) => r.agent_id)).toContain(agentId)
  })

  it('a foreign-attester log is refused; a PREVIOUS-relayer mint is still repairable', async () => {
    // Foreign attester: log says 0x77… attested it, tx was sent by 0x11….
    const foreignAgent = await seedAnchoredRow({ storedUid: phantomUid(1), txHash: txOf(1) })
    stageReceipts({ [txOf(1)]: { uid: realUid(1), attester: FOREIGN_ATTESTER } })
    const refused = await repairAnchorUidFromReceipt(CHAIN, foreignAgent, {
      attestation_uid: phantomUid(1),
      tx_hash: txOf(1),
    })
    expect(refused.repaired).toBe(false)
    expect(refused.reason).toMatch(/proven-ours invariant/)
    const refusedRow = await repo.findByAgent(foreignAgent)
    expect(refusedRow?.attestation_uid?.toLowerCase()).toBe(phantomUid(1))

    // Previous relayer: the row's tx was sent by 0x55… and its log says 0x55…
    // — consistent, so it is OURS even though 0x55… is not the CURRENT relayer.
    const prevAgent = await seedAnchoredRow({ storedUid: phantomUid(2), txHash: txOf(2) })
    stageReceipts({ [txOf(2)]: { uid: realUid(2), attester: PREVIOUS_RELAYER, txFrom: PREVIOUS_RELAYER } })
    const repaired = await repairAnchorUidFromReceipt(CHAIN, prevAgent, {
      attestation_uid: phantomUid(2),
      tx_hash: txOf(2),
    })
    expect(repaired.repaired).toBe(true)
    expect(repaired.uid).toBe(realUid(2))
    const row = await repo.findByAgent(prevAgent)
    expect(row?.attestation_uid?.toLowerCase()).toBe(realUid(2))
    // ...and the repaired row is confirmed out of the queue by the same write.
    const due = await repo.listAnchorRepairsDue(10)
    expect(due.map((r) => r.agent_id)).not.toContain(prevAgent)
  })
})
