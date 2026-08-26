/**
 * #1743 — the stuck-`passport_attest` lane wedge and its OPERATOR-TRIGGERED
 * recovery (Option A), on real Postgres.
 *
 * The first half pins the PRE-TRIGGER state, unchanged from the #2061
 * baseline: a fee-stuck or dropped attest holds the relayer nonce lane and
 * the bump worker alerts instead of replacing — by design, the worker NEVER
 * recovers this on its own (no timer, owner decision on #1743). What the
 * baseline's "no automated recovery exists" characterization pinned is now
 * flipped by the second half: `cancelStuckOutboundLane` — the encoded form of
 * the runbook's same-nonce cancel, triggered by an operator — frees the lane
 * through the outbound pipeline, and the controls it must NOT flip hold:
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
  LANE_CANCEL_SUBMITTER,
  cancelStuckOutboundLane,
  type LaneCancelDeps,
} from '../outbound-lane-cancel.js'
import {
  claimOrphanedOutboundTx,
  countLaneAttemptsAtNonce,
  enqueueOutboundTx,
  findOutboundTxById,
  failCancelAttemptAndRestoreLane,
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

  it('ticks are idempotent about the wedge: a second tick re-alerts and still changes nothing — the WORKER never recovers it (recovery is operator-triggered, below)', async () => {
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

/**
 * The Option-A trigger (#1743): `cancelStuckOutboundLane` against the real
 * repository and real migration-061 index, with the chain stubbed at the same
 * boundary the wedge tests above stub (`SubmitChainDeps` for the pipeline,
 * receipt/fee reads injected). The relayer wallet is a throwaway test key;
 * nothing here can reach a real chain.
 */
describeDb('operator lane cancel frees the wedge (#1743 Option A)', () => {
  beforeAll(() => initDbHarness())
  beforeEach(async () => {
    CHAIN = ++chainCounter
    vi.clearAllMocks()
    await resetDb()
  })

  /** The trigger's chain surface: a fake provider that records broadcasts and
   *  lets the test observe the DB state AT broadcast time (stamp-order proof). */
  function cancelHarness(opts: { receiptStatus?: 0 | 1 | null; broadcastError?: string; estimateGasError?: string } = {}) {
    const broadcasts: { nonce: number; to: string | null; value: bigint; dbCancelStatusAtBroadcast?: string; dbAttestStatusAtBroadcast?: string; hash: string | null }[] = []
    const provider = {
      getNetwork: async () => ({ chainId: BigInt(CHAIN), name: 'test' }),
      getFeeData: async () => ({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 2_000_000n, gasPrice: 3_000_000_000n }),
      estimateGas: async () => {
        if (opts.estimateGasError) throw new Error(opts.estimateGasError)
        return 21_000n
      },
      getTransactionCount: async () => STUCK_NONCE + 1, // the cancel occupies N in the mempool
      broadcastTransaction: async (raw: string) => {
        if (opts.broadcastError) throw new Error(opts.broadcastError)
        const { Transaction } = await import('ethers')
        const parsed = Transaction.from(raw)
        // Observe the durable record AT the moment the tx would hit the
        // mempool: the stamp must already be there (#1559 fence), and the
        // attest must already have left `broadcast` (061 ordering).
        const rows = await rowsFor(CHAIN)
        const cancelRow = rows.find((r) => r.submitter === LANE_CANCEL_SUBMITTER)
        const attestRow = rows.find((r) => r.submitter === 'passport_attest')
        broadcasts.push({
          nonce: parsed.nonce,
          to: parsed.to,
          value: parsed.value,
          hash: parsed.hash,
          dbCancelStatusAtBroadcast: cancelRow?.status,
          dbAttestStatusAtBroadcast: attestRow?.status,
        })
        return { hash: parsed.hash, nonce: parsed.nonce } as never
      },
    }
    const wallet = new Wallet('0x' + '33'.repeat(32), provider as never)
    const deps: LaneCancelDeps = {
      getRow: findOutboundTxById,
      enqueue: enqueueOutboundTx,
      markMined: markOutboundTxMined,
      markFailed: (id, reason, nonce) => markOutboundTxFailed(id, reason, undefined, nonce),
      markReplaced: markOutboundTxReplaced,
      failCancelAndRestore: failCancelAttemptAndRestoreLane,
      relayerAddress: () => wallet.address,
      chain: { getRelayer: (() => wallet) as never, withRelayerSendLock: async (_c, fn) => fn() },
      getReceiptStatus: async () => opts.receiptStatus ?? null,
      currentFees: async () => ({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 2_000_000n }),
    }
    return { deps, broadcasts, wallet }
  }

  it('FLIPS the baseline: the trigger cancels the stuck attest through the pipeline — same nonce, same chain, 0-value self-send, stamped BEFORE broadcast, attest re-keyed to nothing', async () => {
    const stuck = await insertStuckAttest()
    const { deps, broadcasts, wallet } = cancelHarness()

    const result = await cancelStuckOutboundLane(stuck.id, deps)
    if (result.outcome !== 'cancel_broadcast') throw new Error(`expected cancel_broadcast, got ${JSON.stringify(result)}`)
    expect(result.nonce).toBe(String(STUCK_NONCE))

    // Exactly one broadcast reached the chain: the cancel, at the stuck
    // nonce, to the relayer itself, carrying nothing.
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].nonce).toBe(STUCK_NONCE)
    expect(broadcasts[0].to?.toLowerCase()).toBe(wallet.address.toLowerCase())
    expect(broadcasts[0].value).toBe(0n)
    // Stamp order (#1559 fence, 061-compatible): at broadcast time the cancel
    // row was ALREADY stamped `broadcast` and the attest had ALREADY left it.
    expect(broadcasts[0].dbCancelStatusAtBroadcast).toBe('broadcast')
    expect(broadcasts[0].dbAttestStatusAtBroadcast).toBe('replaced')

    const rows = await rowsFor(CHAIN)
    expect(rows).toHaveLength(2)
    const attest = rows.find((r) => r.id === stuck.id)!
    const cancel = rows.find((r) => r.submitter === LANE_CANCEL_SUBMITTER)!
    expect(attest.status).toBe('replaced')
    expect(attest.replaced_by).toBe(cancel.id)
    // The attest's recovery key is untouched — #1043 still finds it by hash.
    expect(attest.tx_hash).toBe(ATTEST_TX)
    expect(cancel.status).toBe('broadcast')
    expect(cancel.nonce).toBe(String(STUCK_NONCE))
    expect(cancel.chain_id).toBe(CHAIN)
    expect(cancel.tx_hash).toBe(broadcasts[0].hash)
    expect(cancel.data).toBe('0x')
    // Fees are a valid same-nonce replacement: ≥ +12.5% over the stuck tx.
    expect(BigInt(cancel.max_fee_per_gas!)).toBeGreaterThanOrEqual(2_000_000_000n + 2_000_000_000n / 8n)
    expect(BigInt(cancel.max_priority_fee_per_gas!)).toBeGreaterThanOrEqual(1_000_000n + 1_000_000n / 8n)
    // The claim counts against the lane's incident cap.
    expect(await countLaneAttemptsAtNonce(CHAIN, BigInt(STUCK_NONCE))).toBe(1)
  })

  it("FLIPS the baseline's 'lane CANNOT advance': after the trigger, a later submitter wins the next nonce and broadcasts", async () => {
    const stuck = await insertStuckAttest()
    const { deps } = cancelHarness()
    const first = await cancelStuckOutboundLane(stuck.id, deps)
    expect(first.outcome).toBe('cancel_broadcast')

    // The exact shape of the baseline's wedge test, re-run post-trigger: the
    // provider now reports pending nonce N+1 (the cancel occupies N), and the
    // sweep's stamp at N+1 is admitted — the lane flows.
    const laneBroadcasts: number[] = []
    const provider = {
      getNetwork: async () => ({ chainId: BigInt(CHAIN), name: 'test' }),
      getFeeData: async () => ({ maxFeePerGas: 200n, maxPriorityFeePerGas: 10n, gasPrice: 200n }),
      estimateGas: async () => 60_000n,
      getTransactionCount: async () => STUCK_NONCE + 1,
      broadcastTransaction: async (raw: string) => {
        const { Transaction } = await import('ethers')
        const parsed = Transaction.from(raw)
        laneBroadcasts.push(parsed.nonce)
        return { hash: parsed.hash, nonce: parsed.nonce } as never
      },
    }
    const wallet = new Wallet('0x' + '33'.repeat(32), provider as never)
    const chain: SubmitChainDeps = {
      getRelayer: (() => wallet) as never,
      withRelayerSendLock: async (_chainId, fn) => fn(),
    }
    const sweep = await enqueueOutboundTx({ chainId: CHAIN, submitter: 'sweep', toAddress: EAS, data: '0x' + 'ff'.repeat(40) })
    await submitRecorded({ chainId: CHAIN, recordId: sweep.id, to: EAS, data: '0x' + 'ff'.repeat(40) }, undefined, chain)

    expect(laneBroadcasts).toEqual([STUCK_NONCE + 1])
    const rows = await rowsFor(CHAIN)
    expect(rows.find((r) => r.id === sweep.id)?.status).toBe('broadcast')
    expect(rows.find((r) => r.id === sweep.id)?.nonce).toBe(String(STUCK_NONCE + 1))
  })

  it('POSITIVE CONTROL inherited: a merely-slow attest is REFUSED — nothing enqueued, nothing broadcast, row untouched', async () => {
    const young = await insertStuckAttest(60)
    const { deps, broadcasts } = cancelHarness()

    const result = await cancelStuckOutboundLane(young.id, deps)
    expect(result.outcome).toBe('refused')
    if (result.outcome === 'refused') expect(result.code).toBe('too_young')
    expect(broadcasts).toEqual([])
    const rows = await rowsFor(CHAIN)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('broadcast')
    expect(rows[0].tx_hash).toBe(ATTEST_TX)
  })

  it('chain-first: an attest that actually MINED is closed from the receipt, never cancelled', async () => {
    const stuck = await insertStuckAttest()
    const { deps, broadcasts } = cancelHarness({ receiptStatus: 1 })
    const result = await cancelStuckOutboundLane(stuck.id, deps)
    expect(result).toEqual({ outcome: 'closed_mined', rowId: stuck.id })
    expect(broadcasts).toEqual([])
    const rows = await rowsFor(CHAIN)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('mined')
  })

  it('chain-first: a mined-and-reverted attest is closed failed — the lane is already free', async () => {
    const stuck = await insertStuckAttest()
    const { deps, broadcasts } = cancelHarness({ receiptStatus: 0 })
    const result = await cancelStuckOutboundLane(stuck.id, deps)
    expect(result).toEqual({ outcome: 'closed_reverted', rowId: stuck.id })
    expect(broadcasts).toEqual([])
    expect((await rowsFor(CHAIN))[0].status).toBe('failed')
  })

  it('IDEMPOTENT: a second trigger while the cancel is in flight is a clear refusal — one cancel, one fee, one broadcast, ever', async () => {
    const stuck = await insertStuckAttest()
    const { deps, broadcasts } = cancelHarness()

    const first = await cancelStuckOutboundLane(stuck.id, deps)
    expect(first.outcome).toBe('cancel_broadcast')
    const second = await cancelStuckOutboundLane(stuck.id, deps)
    expect(second.outcome).toBe('refused')
    if (second.outcome === 'refused') {
      expect(second.code).toBe('not_broadcast')
      expect(second.detail).toContain('already in flight')
    }

    expect(broadcasts).toHaveLength(1)
    const rows = await rowsFor(CHAIN)
    expect(rows.filter((r) => r.submitter === LANE_CANCEL_SUBMITTER)).toHaveLength(1)
  })

  it("refuses a rebroadcast-safe submitter's stuck row — the bump worker owns those, cancel would burn a retryable payload", async () => {
    const sweep = await enqueueOutboundTx({ chainId: CHAIN, submitter: 'sweep', toAddress: EAS, data: '0x' + 'ff'.repeat(40) })
    const stamped = await markOutboundTxBroadcast(sweep.id, { txHash: '0x' + '77'.repeat(32), nonce: BigInt(STUCK_NONCE) })
    await db.query(`UPDATE outbound_txs SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [stamped!.id])
    const { deps, broadcasts } = cancelHarness()

    const result = await cancelStuckOutboundLane(sweep.id, deps)
    expect(result.outcome).toBe('refused')
    if (result.outcome === 'refused') expect(result.code).toBe('automated_recovery_owns_it')
    expect(broadcasts).toEqual([])
    expect((await rowsFor(CHAIN))[0].status).toBe('broadcast')
  })

  it('a PRE-STAMP failure closes the cancel attempt failed AT the nonce and ROLLS THE CLAIM BACK — the wedge stays loud and the trigger re-runnable', async () => {
    const stuck = await insertStuckAttest()
    const { deps, broadcasts } = cancelHarness({ estimateGasError: 'gas estimation refused' })

    const result = await cancelStuckOutboundLane(stuck.id, deps)
    expect(result.outcome).toBe('refused')
    if (result.outcome === 'refused') {
      expect(result.code).toBe('broadcast_failed')
      expect(result.detail).toContain('rolled back')
    }
    expect(broadcasts).toEqual([])

    const rows = await rowsFor(CHAIN)
    const cancel = rows.find((r) => r.submitter === LANE_CANCEL_SUBMITTER)!
    expect(cancel.status).toBe('failed')
    expect(cancel.nonce).toBe(String(STUCK_NONCE))
    // Nothing was sent, so the flip is undone: the attest is `broadcast`
    // again — the worker's per-tick alert resumes AND a repaired re-trigger
    // succeeds instead of being refused forever (review finding).
    const attest = rows.find((r) => r.id === stuck.id)!
    expect(attest.status).toBe('broadcast')
    expect(attest.replaced_by).toBeNull()
    // failed cancel attempt = 1 counted attempt at N.
    expect(await countLaneAttemptsAtNonce(CHAIN, BigInt(STUCK_NONCE))).toBe(1)

    const retry = cancelHarness()
    const second = await cancelStuckOutboundLane(stuck.id, retry.deps)
    expect(second.outcome).toBe('cancel_broadcast')
  })

  it('a POST-STAMP send error leaves the stamped cancel row broadcast — never failed — and the worker re-broadcasts it (review finding: a failed row would wedge the lane silently)', async () => {
    const stuck = await insertStuckAttest()
    const { deps, broadcasts } = cancelHarness({ broadcastError: 'connection reset by peer' })

    const result = await cancelStuckOutboundLane(stuck.id, deps)
    if (result.outcome !== 'cancel_stamped_send_unconfirmed') {
      throw new Error(`expected cancel_stamped_send_unconfirmed, got ${JSON.stringify(result)}`)
    }
    expect(result.nonce).toBe(String(STUCK_NONCE))
    expect(broadcasts).toEqual([])

    let rows = await rowsFor(CHAIN)
    const cancel = rows.find((r) => r.id === result.cancelRowId)!
    expect(cancel.status).toBe('broadcast') // the one state a scan reconciles
    expect(cancel.nonce).toBe(String(STUCK_NONCE))
    expect(rows.find((r) => r.id === stuck.id)?.status).toBe('replaced')

    // The ordinary worker tick now owns it: lane_cancel is rebroadcast-safe,
    // so the stale row is fee-replaced from its stored calldata — the lane
    // recovery is loud and self-healing, not dead-ended.
    await db.query(`UPDATE outbound_txs SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [result.cancelRowId])
    const workerBroadcasts: { nonce?: number }[] = []
    const workerDeps = realRepoDeps(workerBroadcasts)
    const tick = await runOutboundBumpTick(CHAIN, workerDeps, log)
    expect(tick.bumped).toBe(1)
    expect(workerBroadcasts).toHaveLength(1)
    expect(workerBroadcasts[0].nonce).toBe(STUCK_NONCE)

    rows = await rowsFor(CHAIN)
    const replacement = rows.find((r) => r.submitter === LANE_CANCEL_SUBMITTER && r.status === 'broadcast')!
    expect(replacement.nonce).toBe(String(STUCK_NONCE))
    expect(rows.find((r) => r.id === result.cancelRowId)?.status).toBe('replaced')
  })

  it('RACE — cancel wins: the ordinary bump tick closes the cancel row mined; the burned nonce is the probe evidence (#1745), no new machinery', async () => {
    const stuck = await insertStuckAttest()
    const { deps } = cancelHarness()
    const result = await cancelStuckOutboundLane(stuck.id, deps)
    if (result.outcome !== 'cancel_broadcast') throw new Error('trigger failed')

    // Age the cancel into the worker's scan, then run the UNMODIFIED tick:
    // its chain-first read finds the cancel mined and closes the row.
    await db.query(`UPDATE outbound_txs SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [result.cancelRowId])
    const workerBroadcasts: unknown[] = []
    const workerDeps = realRepoDeps(workerBroadcasts)
    workerDeps.getReceiptStatus = async (_chain, txHash) => (txHash === result.txHash ? 1 : null)
    const tick = await runOutboundBumpTick(CHAIN, workerDeps, log)

    expect(tick.closedMined).toBe(1)
    expect(workerBroadcasts).toEqual([])
    const rows = await rowsFor(CHAIN)
    expect(rows.find((r) => r.id === result.cancelRowId)?.status).toBe('mined')
    // The attest can never mine (nonce burned); its row stays `replaced` and
    // its hash unchanged — the re-mint decision belongs to the liveness probe
    // (proven `dead` for exactly this shape in anchor-tx-liveness.test.ts).
    expect(rows.find((r) => r.id === stuck.id)?.status).toBe('replaced')
  })

  it('RACE — attest lands late: nothing re-keyed the attest (hash intact for #1043 recovery) and the losing cancel\'s bump attempt is a counted, closed failure', async () => {
    const stuck = await insertStuckAttest()
    const { deps } = cancelHarness()
    const result = await cancelStuckOutboundLane(stuck.id, deps)
    if (result.outcome !== 'cancel_broadcast') throw new Error('trigger failed')

    // The attest mined at N, so the cancel can never mine: its receipt stays
    // null and any fee-replacement of it is rejected by the chain.
    await db.query(`UPDATE outbound_txs SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [result.cancelRowId])
    const workerDeps = realRepoDeps([])
    workerDeps.getReceiptStatus = async () => null
    workerDeps.sendRaw = async () => {
      throw new Error('nonce too low')
    }
    await runOutboundBumpTick(CHAIN, workerDeps, log)

    const rows = await rowsFor(CHAIN)
    // The attest's identity is untouched: same row, same hash — #1043's
    // receipt recovery finds the ORIGINAL anchor and no second credential is
    // minted (proven `live` for this shape in anchor-tx-liveness.test.ts).
    const attest = rows.find((r) => r.id === stuck.id)!
    expect(attest.tx_hash).toBe(ATTEST_TX)
    expect(attest.status).toBe('replaced')
    // The failed bump attempt on the dead cancel is closed and counted, so
    // the lane cap escalates to the incident alert instead of looping.
    const failedAttempt = rows.find((r) => r.status === 'failed' && r.submitter === LANE_CANCEL_SUBMITTER)
    expect(failedAttempt).toBeDefined()
    expect(failedAttempt!.nonce).toBe(String(STUCK_NONCE))
    expect(await countLaneAttemptsAtNonce(CHAIN, BigInt(STUCK_NONCE))).toBeGreaterThanOrEqual(2)
  })
})
