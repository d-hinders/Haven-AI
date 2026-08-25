/**
 * #1743 — characterization of the stuck-`passport_attest` lane wedge, on real
 * Postgres. These tests PIN the deliberate #1735 trade before any recovery
 * mechanism exists: a fee-stuck or dropped attest holds the relayer nonce
 * lane, the bump worker alerts instead of replacing, and nothing automated
 * frees the lane. When #1743's owner decision lands and a recovery is built,
 * the wedge assertions here are the red-first baseline that the recovery
 * flips — and the controls are the guards it must NOT flip:
 *
 * - a stuck attest is never replaced, re-broadcast, or closed by the worker
 *   (replacing orphans #1043's hash-keyed receipt recovery; re-broadcasting
 *   mints a second live credential);
 * - a merely-slow attest (younger than STALE_BROADCAST_SECONDS) is not even
 *   scanned, let alone touched — the age gate is the first thing standing
 *   between "slow" and "stuck", and any future recovery inherits it.
 *
 * The wedge itself is proven against the real migration-061 partial UNIQUE
 * index — `(chain_id, nonce) WHERE status = 'broadcast'` — not a mock: with
 * the attest row holding nonce N, a later submitter whose provider re-reads
 * N (the dropped-tx shape) can never win the lane and broadcasts NOTHING.
 * The fee-stuck shape (later txs take N+1… and queue behind N in the
 * mempool) is chain semantics a unit test cannot observe; the runbook
 * (`docs/operations/delegation-rail-vendor-ops.md` §3) documents it.
 */
import { Wallet } from 'ethers'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from './helpers/db-harness.js'
import { submitRecorded, type SubmitChainDeps } from '../outbound-queue.js'
import {
  STALE_BROADCAST_SECONDS,
  runOutboundBumpTick,
  type BumpDeps,
  type BumpLogger,
} from '../outbound-bump-worker.js'
import {
  claimOrphanedOutboundTx,
  countLaneAttemptsAtNonce,
  enqueueOutboundTx,
  listUnminedOutboundTxs,
  markOutboundTxBroadcast,
  markOutboundTxFailed,
  markOutboundTxMined,
  markOutboundTxReplaced,
  type OutboundTxRow,
} from '../repositories/outbound-txs.js'

const EAS = '0x' + '4a'.repeat(20)
const ATTEST_DATA = '0x' + 'ab'.repeat(80)
const ATTEST_TX = '0x' + 'cd'.repeat(32)
const STUCK_NONCE = 7

// Same randomised-chain isolation belt as outbound-queue.test.ts.
let chainCounter = 93_000_000 + Math.floor(Math.random() * 900_000)
let CHAIN = 0

const log: BumpLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

/** A real broadcast `passport_attest` row at STUCK_NONCE, aged past the
 *  bump worker's stale threshold unless `ageSeconds` says otherwise. */
async function insertStuckAttest(ageSeconds = STALE_BROADCAST_SECONDS + 120): Promise<OutboundTxRow> {
  const queued = await enqueueOutboundTx({
    chainId: CHAIN,
    submitter: 'passport_attest',
    toAddress: EAS,
    data: ATTEST_DATA,
  })
  const stamped = await markOutboundTxBroadcast(queued.id, {
    txHash: ATTEST_TX,
    nonce: BigInt(STUCK_NONCE),
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
  })
  if (!stamped) throw new Error('fixture stamp refused')
  await db.query(
    `UPDATE outbound_txs SET updated_at = NOW() - ($2 * INTERVAL '1 second') WHERE id = $1`,
    [stamped.id, ageSeconds],
  )
  return stamped
}

async function rowsFor(chainId: number): Promise<OutboundTxRow[]> {
  const { rows } = await db.query<OutboundTxRow>(
    `SELECT * FROM outbound_txs WHERE chain_id = $1 ORDER BY created_at, id`,
    [chainId],
  )
  return rows
}

/** The worker's production deps against the REAL repository, with only the
 *  chain injected: the receipt read answers `null` (truly unmined) and any
 *  broadcast attempt is recorded so the tests can assert none happened. */
function realRepoDeps(broadcasts: unknown[]): BumpDeps {
  return {
    listUnmined: listUnminedOutboundTxs,
    claimOrphan: claimOrphanedOutboundTx,
    enqueue: enqueueOutboundTx,
    markBroadcast: markOutboundTxBroadcast,
    markMined: markOutboundTxMined,
    markFailed: (id, reason, nonce) => markOutboundTxFailed(id, reason, undefined, nonce),
    markReplaced: markOutboundTxReplaced,
    countLaneAttempts: countLaneAttemptsAtNonce,
    getReceiptStatus: async () => null,
    currentFees: async () => ({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 2_000_000n }),
    sendRaw: async (chainId, tx) => {
      broadcasts.push({ chainId, ...tx })
      return { hash: '0x' + 'ee'.repeat(32), nonce: tx.nonce ?? 99 }
    },
  }
}

describeDb('stuck passport_attest wedges the relayer nonce lane (#1743 characterization)', () => {
  beforeAll(() => initDbHarness())
  beforeEach(async () => {
    CHAIN = ++chainCounter
    vi.clearAllMocks()
    await resetDb()
  })

  it('the bump tick alerts and walks away: no replacement, no broadcast, no close — the row stays the lane holder', async () => {
    const stuck = await insertStuckAttest()

    const broadcasts: unknown[] = []
    const result = await runOutboundBumpTick(CHAIN, realRepoDeps(broadcasts), log)

    expect(result.alerted).toBe(1)
    expect(result.bumped).toBe(0)
    expect(result.closedMined).toBe(0)
    expect(result.closedFailed).toBe(0)
    expect(broadcasts).toEqual([])

    const rows = await rowsFor(CHAIN)
    expect(rows).toHaveLength(1) // no replacement row was even enqueued
    expect(rows[0].id).toBe(stuck.id)
    expect(rows[0].status).toBe('broadcast')
    expect(rows[0].nonce).toBe(String(STUCK_NONCE))
    expect(rows[0].tx_hash).toBe(ATTEST_TX)
  })

  it('ticks are idempotent about the wedge: a second tick re-alerts and still changes nothing — no automated recovery exists', async () => {
    await insertStuckAttest()
    const broadcasts: unknown[] = []
    const deps = realRepoDeps(broadcasts)

    const first = await runOutboundBumpTick(CHAIN, deps, log)
    // Age the row past the threshold again (the tick did not touch it, but be
    // explicit that the SECOND tick sees it as stale too, not as fresh).
    await db.query(
      `UPDATE outbound_txs SET updated_at = NOW() - ($2 * INTERVAL '1 second') WHERE chain_id = $1`,
      [CHAIN, STALE_BROADCAST_SECONDS + 120],
    )
    const second = await runOutboundBumpTick(CHAIN, deps, log)

    expect(first.alerted).toBe(1)
    expect(second.alerted).toBe(1)
    expect(broadcasts).toEqual([])
    const rows = await rowsFor(CHAIN)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('broadcast')
  })

  it('POSITIVE CONTROL: a merely-slow attest (under the stale threshold) is not scanned, alerted, or touched', async () => {
    // 60 s old: past nothing. A recovery that could fire here would be firing
    // on every ordinarily-slow block inclusion.
    const young = await insertStuckAttest(60)

    const broadcasts: unknown[] = []
    const result = await runOutboundBumpTick(CHAIN, realRepoDeps(broadcasts), log)

    expect(result.alerted).toBe(0)
    expect(result.bumped).toBe(0)
    expect(broadcasts).toEqual([])
    const rows = await rowsFor(CHAIN)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(young.id)
    expect(rows[0].status).toBe('broadcast')
  })

  it('the lane CANNOT advance: with the attest holding nonce N as `broadcast`, migration 061 refuses every later stamp at N and nothing reaches the chain', async () => {
    // The dropped-tx shape: the mempool has forgotten the attest, so the
    // provider's pending count falls back to N — but the durable row still
    // holds the lane, which is exactly what protects #1043's recovery from a
    // second broadcast racing the first.
    await insertStuckAttest()

    const nonceReads: number[] = []
    const broadcasts: number[] = []
    const provider = {
      getNetwork: async () => ({ chainId: BigInt(CHAIN), name: 'test' }),
      getFeeData: async () => ({ maxFeePerGas: 200n, maxPriorityFeePerGas: 10n, gasPrice: 200n }),
      estimateGas: async () => 60_000n,
      getTransactionCount: async () => {
        nonceReads.push(STUCK_NONCE)
        return STUCK_NONCE
      },
      broadcastTransaction: async (raw: string) => {
        const { Transaction } = await import('ethers')
        const parsed = Transaction.from(raw)
        broadcasts.push(parsed.nonce)
        return { hash: parsed.hash, nonce: parsed.nonce } as never
      },
    }
    const wallet = new Wallet('0x' + '33'.repeat(32), provider as never)
    const chain: SubmitChainDeps = {
      getRelayer: (() => wallet) as never,
      withRelayerSendLock: async (_chainId, fn) => fn(),
    }

    const sweep = await enqueueOutboundTx({
      chainId: CHAIN,
      submitter: 'sweep',
      toAddress: EAS,
      data: '0x' + 'ff'.repeat(40),
    })

    await expect(
      submitRecorded({ chainId: CHAIN, recordId: sweep.id, to: EAS, data: '0x' + 'ff'.repeat(40) }, undefined, chain),
    ).rejects.toThrow(/could not win a nonce lane/)

    // Every attempt re-read the same held nonce; NOTHING was broadcast — the
    // wedge is total, not a retry that eventually squeezes through.
    expect(nonceReads.length).toBeGreaterThanOrEqual(2)
    expect(broadcasts).toEqual([])

    const rows = await rowsFor(CHAIN)
    expect(rows.map((r) => [r.submitter, r.status, r.nonce])).toEqual([
      ['passport_attest', 'broadcast', String(STUCK_NONCE)],
      ['sweep', 'queued', null], // still adoptable; it never won the lane
    ])
  })
})
