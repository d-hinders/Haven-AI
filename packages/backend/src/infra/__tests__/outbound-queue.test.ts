/**
 * Real-DB tests for the outbound-record call-site glue (#1556).
 *
 * The property the epic bought with this slice: the row exists in Postgres
 * BEFORE any broadcast happens, so a process death mid-flight leaves a
 * record the bump worker (#1558) can act on. That ordering is asserted by
 * probing the database at the moment the "broadcast" would run — not by
 * trusting call order in a mock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from './helpers/db-harness.js'
import { openOutboundRecord, type OutboundQueueRepo } from '../outbound-queue.js'
import type { OutboundTxRow } from '../repositories/outbound-txs.js'

const TO = '0xdb9b1e94b5b69df7e401ddbede43491141047db3'
const DATA = '0x' + 'ab'.repeat(80)
const TX = '0x' + 'cd'.repeat(32)

// Randomised base per module load: unqualified table names resolve via
// `search_path = test_wN,public`, so a worker whose schema predates this
// table silently reads/writes the SHARED public one, where rows survive
// across runs — a fixed base then collides with a previous run's rows.
let chainCounter = 91_000_000 + Math.floor(Math.random() * 900_000)
let CHAIN = 0

describeDb('openOutboundRecord (#1556)', () => {
  initDbHarness()
  beforeEach(async () => {
    CHAIN = ++chainCounter
    await resetDb()
  })

  async function rowsFor(chainId: number): Promise<OutboundTxRow[]> {
    const { rows } = await db.query<OutboundTxRow>(
      `SELECT * FROM outbound_txs WHERE chain_id = $1 ORDER BY created_at`,
      [chainId],
    )
    return rows
  }

  it('the queued row exists BEFORE the caller broadcasts — the crash-survival ordering', async () => {
    const record = await openOutboundRecord({ chainId: CHAIN, submitter: 'passport_attest', to: TO, data: DATA })

    // The probe stands where the broadcast would: the record must already be
    // durable at this point, or a crash here loses the transaction's trace.
    const preBroadcast = await rowsFor(CHAIN)
    expect(preBroadcast).toHaveLength(1)
    expect(preBroadcast[0].status).toBe('queued')
    expect(preBroadcast[0].data).toBe(DATA)
    expect(record.id).toBe(preBroadcast[0].id)
  })

  it('stamps broadcast with hash/nonce/fees, then closes as mined', async () => {
    const record = await openOutboundRecord({ chainId: CHAIN, submitter: 'hybrid_deploy', to: TO, data: DATA })
    await record.broadcast({ hash: TX, nonce: 42, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n })

    const [afterBroadcast] = await rowsFor(CHAIN)
    expect(afterBroadcast.status).toBe('broadcast')
    expect(afterBroadcast.tx_hash).toBe(TX)
    expect(afterBroadcast.nonce).toBe('42')
    expect(afterBroadcast.max_fee_per_gas).toBe('2000000000')

    await record.mined()
    expect((await rowsFor(CHAIN))[0].status).toBe('mined')
  })

  it('a reverted receipt closes the record as failed, with the reason', async () => {
    const record = await openOutboundRecord({ chainId: CHAIN, submitter: 'passport_revoke', to: TO, data: DATA })
    await record.broadcast({ hash: TX, nonce: 7 })
    await record.failed('reverted (tx 0xcd…)')

    const [row] = await rowsFor(CHAIN)
    expect(row.status).toBe('failed')
    expect(row.error).toContain('reverted')
  })

  it('FAIL-OPEN: a repository error never reaches the caller, and later calls are no-ops', async () => {
    // The queue is a RECORD on this slice, not the submission authority —
    // a database hiccup must not block a passport anchor or an activation.
    const throwingRepo: OutboundQueueRepo = {
      enqueueOutboundTx: vi.fn().mockRejectedValue(new Error('db down')),
      markOutboundTxBroadcast: vi.fn().mockRejectedValue(new Error('db down')),
      markOutboundTxMined: vi.fn().mockRejectedValue(new Error('db down')),
      markOutboundTxFailed: vi.fn().mockRejectedValue(new Error('db down')),
    }
    const record = await openOutboundRecord(
      { chainId: CHAIN, submitter: 'passport_attest', to: TO, data: DATA },
      throwingRepo,
    )
    expect(record.id).toBeNull()
    await expect(record.broadcast({ hash: TX, nonce: 1 })).resolves.toBeUndefined()
    await expect(record.mined()).resolves.toBeUndefined()
    // With no id, the marks are never even attempted.
    expect(throwingRepo.markOutboundTxBroadcast).not.toHaveBeenCalled()

    // And a mark failure AFTER a successful open is also absorbed.
    const halfOpen = await openOutboundRecord(
      { chainId: CHAIN, submitter: 'passport_attest', to: TO, data: DATA },
      { ...throwingRepo, enqueueOutboundTx: (p) => import('../repositories/outbound-txs.js').then((m) => m.enqueueOutboundTx(p)) },
    )
    expect(halfOpen.id).not.toBeNull()
    await expect(halfOpen.broadcast({ hash: TX, nonce: 1 })).resolves.toBeUndefined()
  })
})
