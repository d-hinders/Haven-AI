/**
 * Real-DB tests for the outbound-txs repository (#1555, epic #1554).
 *
 * The property that justifies this table existing at all — two concurrent
 * claimants can never take the same row — IS Postgres row-locking
 * (`FOR UPDATE SKIP LOCKED`), so it is proven here against real Postgres per
 * the testing strategy, never against a mock that would prove only the mock.
 */
import { beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  claimNextOutboundTx,
  claimOrphanedOutboundTx,
  countLaneAttemptsAtNonce,
  enqueueOutboundTx,
  listUnminedOutboundTxs,
  markOutboundTxBroadcast,
  markOutboundTxFailed,
  markOutboundTxMined,
  markOutboundTxReplaced,
} from '../outbound-txs.js'

// A UNIQUE chain id per test: claim-next is chain-scoped, so this makes each
// test hermetic against any row another test (or an unsettled async tail)
// leaves behind — the CI-only failure this fixed was exactly such a leak.
// Randomised base per module load: unqualified table names resolve via
// `search_path = test_wN,public`, so a worker whose schema predates this
// table silently reads/writes the SHARED public one, where rows survive
// across runs — a fixed base then collides with a previous run's rows.
let chainCounter = 84_532_000 + Math.floor(Math.random() * 900_000)
let CHAIN = 0
const TO = '0xDB9B1e94B5b69Df7e401DDbedE43491141047dB3'
const DATA = '0x' + 'ab'.repeat(200)
const TX = '0x' + 'cd'.repeat(32)

function enqueue(submitter = 'test') {
  return enqueueOutboundTx({ chainId: CHAIN, submitter, toAddress: TO, data: DATA, valueAtomic: 0n })
}

describeDb('outbound-txs repository (#1555)', () => {
  initDbHarness()
  beforeEach(async () => {
    CHAIN = ++chainCounter
    await resetDb()
  })

  it('enqueues queued with addresses lower-cased, and claim returns oldest-first', async () => {
    const first = await enqueue('a')
    const second = await enqueue('b')
    expect(first.status).toBe('queued')
    expect(first.to_address).toBe(TO.toLowerCase())

    const claimed = await claimNextOutboundTx(CHAIN)
    expect(claimed?.id).toBe(first.id)
    expect(claimed?.claimed_at).not.toBeNull()
    // The claim is a LEASE: status stays queued so a crash here is recoverable.
    expect(claimed?.status).toBe('queued')

    const next = await claimNextOutboundTx(CHAIN)
    expect(next?.id).toBe(second.id)
  })

  it('CONCURRENCY: a claimant holding the oldest row does not stall the next claimant', async () => {
    // Deterministic overlap, not a Promise.all coin-flip (the first draft's
    // race never actually overlapped, so removing SKIP LOCKED still passed —
    // a guard that cannot fail). Here a transaction HOLDS the row lock,
    // uncommitted, while the second claim runs: with SKIP LOCKED the second
    // claimant takes the next row immediately; without it, it waits for the
    // lock and then EvalPlanQual re-check yields nothing — the lane stalls
    // behind one claimant, the exact serialisation bug the table exists to
    // remove. Proven: this test fails under a FOR UPDATE-only mutation.
    const first = await enqueue('a')
    const second = await enqueue('b')

    const holder = await db.connect()
    let claimPromise: Promise<unknown> | undefined
    try {
      await holder.query('BEGIN')
      const held = await holder.query(
        `SELECT id FROM outbound_txs WHERE id = $1 FOR UPDATE`,
        [first.id],
      )
      expect(held.rows[0].id).toBe(first.id)

      // While the lock is held: the pool-side claimant must get row two,
      // PROMPTLY. Raced against a timer rather than awaited bare, because the
      // mutated form (no SKIP LOCKED) does not return a wrong row — it BLOCKS
      // on the held lock, and a bare await would hang the whole runner past
      // every timeout instead of failing this assertion.
      claimPromise = claimNextOutboundTx(CHAIN)
      const winner = await Promise.race([
        claimPromise,
        new Promise((resolve) => setTimeout(() => resolve('STALLED' as const), 1_500)),
      ])
      expect(winner).not.toBe('STALLED')
      expect((winner as { id?: string })?.id).toBe(second.id)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      // Let a stalled claimant finish against the released lock so nothing
      // dangles into pool teardown.
      await claimPromise?.then(
        () => undefined,
        () => undefined,
      )
    }
  })

  it('a claimed row is invisible to other claimants until its lease expires', async () => {
    const row = await enqueue()
    const claimed = await claimNextOutboundTx(CHAIN)
    expect(claimed?.id).toBe(row.id)

    // Fresh lease → nothing to claim.
    expect(await claimNextOutboundTx(CHAIN)).toBeNull()

    // Expire the lease the way time would (crash between claim and broadcast).
    await db.query(`UPDATE outbound_txs SET claimed_at = NOW() - INTERVAL '3 minutes' WHERE id = $1`, [row.id])
    const readopted = await claimNextOutboundTx(CHAIN)
    expect(readopted?.id).toBe(row.id)
  })

  it('walks the lifecycle: broadcast → mined, with the queued-guard refusing a second broadcast', async () => {
    const row = await enqueue()
    const broadcast = await markOutboundTxBroadcast(row.id, {
      txHash: TX,
      nonce: 781n,
      maxFeePerGas: 2_000_000_000n,
    })
    expect(broadcast?.status).toBe('broadcast')
    expect(broadcast?.nonce).toBe('781')
    expect(broadcast?.max_fee_per_gas).toBe('2000000000')

    // Guarded transition: marking broadcast twice returns null, not a rewrite.
    expect(await markOutboundTxBroadcast(row.id, { txHash: TX, nonce: 782n })).toBeNull()

    const mined = await markOutboundTxMined(row.id)
    expect(mined?.status).toBe('mined')
    // Terminal: cannot fail a mined row.
    expect(await markOutboundTxFailed(row.id, 'late error')).toBeNull()
  })

  it('records a replacement chain in both directions', async () => {
    const original = await enqueue()
    await markOutboundTxBroadcast(original.id, { txHash: TX, nonce: 1n })
    const bumped = await enqueue('bump-worker')

    const replaced = await markOutboundTxReplaced(original.id, bumped.id)
    expect(replaced?.status).toBe('replaced')
    expect(replaced?.replaced_by).toBe(bumped.id)
  })

  it('the unmined scan sees only stale broadcast rows on the requested chain', async () => {
    const stale = await enqueue()
    await markOutboundTxBroadcast(stale.id, { txHash: TX, nonce: 1n })
    await db.query(`UPDATE outbound_txs SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [stale.id])

    const fresh = await enqueue()
    await markOutboundTxBroadcast(fresh.id, { txHash: '0x' + 'ef'.repeat(32), nonce: 2n })

    const unmined = await listUnminedOutboundTxs(CHAIN, 300)
    expect(unmined.map((r) => r.id)).toEqual([stale.id])
  })

  it('at most ONE live broadcast per (chain, nonce) — schema-enforced, not worker discipline', async () => {
    // Replacements legitimately share a nonce, but only after the replaced
    // row leaves 'broadcast'. Two simultaneous live broadcasts at one nonce
    // is the ambiguous state the bump worker must never produce — and now
    // cannot, whatever its bugs.
    const a = await enqueue()
    const b = await enqueue()
    await markOutboundTxBroadcast(a.id, { txHash: TX, nonce: 5n })
    await expect(
      markOutboundTxBroadcast(b.id, { txHash: '0x' + 'ef'.repeat(32), nonce: 5n }),
    ).rejects.toThrow(/duplicate key|unique/i)

    // The legal sequence: replace a first, then the nonce is reusable.
    await markOutboundTxReplaced(a.id, b.id)
    const rebroadcast = await markOutboundTxBroadcast(b.id, { txHash: '0x' + 'ef'.repeat(32), nonce: 5n })
    expect(rebroadcast?.status).toBe('broadcast')
  })

  it('stores the full calldata and value verbatim — what the bump worker re-broadcasts', async () => {
    const row = await enqueueOutboundTx({
      chainId: CHAIN, submitter: 'sweep', toAddress: TO, data: DATA, valueAtomic: 123n,
    })
    expect(row.data).toBe(DATA.toLowerCase())
    expect(row.value_atomic).toBe('123')
  })

  it('orphan claim (#1558): AGE-GATED — a young unclaimed row is an in-flight inline submission, not an orphan', async () => {
    const young = await enqueue('sweep')
    expect(await claimOrphanedOutboundTx(CHAIN, 600)).toBeNull()

    // Age the row past the orphan threshold: now it is adoptable.
    await db.query(`UPDATE outbound_txs SET created_at = NOW() - INTERVAL '11 minutes' WHERE id = $1`, [young.id])
    const adopted = await claimOrphanedOutboundTx(CHAIN, 600)
    expect(adopted?.id).toBe(young.id)

    // And a broadcast row is never an orphan candidate, whatever its age.
    await markOutboundTxBroadcast(young.id, { txHash: TX, nonce: 1n })
    expect(await claimOrphanedOutboundTx(CHAIN, 600)).toBeNull()
  })

  it('countLaneAttemptsAtNonce (#1558): counts replaced AND nonce-stamped failed attempts, per lane', async () => {
    const a = await enqueue()
    const b = await enqueue()
    const c = await enqueue()
    const failedAttempt = await enqueue()
    await markOutboundTxBroadcast(a.id, { txHash: TX, nonce: 7n })
    await markOutboundTxReplaced(a.id, b.id)
    await markOutboundTxBroadcast(b.id, { txHash: '0x' + 'ee'.repeat(32), nonce: 7n })
    // A bump attempt whose broadcast THREW: failed, stamped with lane 7.
    await markOutboundTxFailed(failedAttempt.id, 'bump broadcast failed: nonce too low', undefined, 7n)
    // A different nonce on the same chain does not count toward lane 7.
    await markOutboundTxBroadcast(c.id, { txHash: '0x' + 'ef'.repeat(32), nonce: 8n })

    expect(await countLaneAttemptsAtNonce(CHAIN, 7n)).toBe(2)
    expect(await countLaneAttemptsAtNonce(CHAIN, 8n)).toBe(0)
  })

  it('the status CHECK constraint is real — garbage states are rejected by Postgres', async () => {
    const row = await enqueue()
    await expect(
      db.query(`UPDATE outbound_txs SET status = 'zombie' WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/check constraint/i)
  })
})
