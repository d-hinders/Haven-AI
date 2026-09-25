/**
 * Real-DB tests for the outbound-record call-site glue (#1556).
 *
 * The property the epic bought with this slice: the row exists in Postgres
 * BEFORE any broadcast happens, so a process death mid-flight leaves a
 * record the bump worker (#1558) can act on. That ordering is asserted by
 * probing the database at the moment the "broadcast" would run — not by
 * trusting call order in a mock.
 */
import { Wallet, makeError } from 'ethers'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from './helpers/db-harness.js'
import {
  OutboundFencedError,
  openOutboundRecord,
  isPendingTagRefusal,
  submitRecorded,
  type OutboundQueueRepo,
  type SubmitChainDeps,
} from '../outbound-queue.js'
import { markOutboundTxBroadcast, type OutboundTxRow } from '../repositories/outbound-txs.js'

const TO = '0xdb9b1e94b5b69df7e401ddbede43491141047db3'
const DATA = '0x' + 'ab'.repeat(80)
const TX = '0x' + 'cd'.repeat(32)

// Randomised base per module load. Historically load-bearing: the old
// `test_wN,public` search_path let a worker missing this table alias the
// SHARED public one, where a previous run's rows collided with a fixed
// base. #1562 closed that fallback (a missing table is now a loud error);
// the randomisation stays as cheap belt against any future shared state.
let chainCounter = 91_000_000 + Math.floor(Math.random() * 900_000)
let CHAIN = 0

describeDb('openOutboundRecord (#1556)', () => {
  // AWAITED in beforeAll (#1562 follow-up): a bare registration-time call
  // leaves the returned promise dangling and lets the first tests race the
  // worker's own migration DDL — the 42P01/40P01 CI flake. resetDb() now
  // also awaits init as a harness guarantee; this is the readable half.
  beforeAll(() => initDbHarness())
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

  it('CROSS-REPLICA (#1559): the unique live-nonce index arbitrates — the stale replica retries onto the next lane', async () => {
    // Two "replicas" = two submits with pass-through locks (each real replica
    // has its OWN in-process lock; across replicas only Postgres is shared).
    // Replica B's provider view of the pending nonce is deliberately STALE:
    // it still says 5 after A broadcast at 5. The partial UNIQUE
    // (chain_id, nonce) WHERE status='broadcast' index — real Postgres, not a
    // mock — must reject B's stamp and force the retry that re-reads.
    let pendingNonce = 5
    const broadcasts: number[] = []
    const provider = {
      getNetwork: async () => ({ chainId: BigInt(CHAIN), name: 'test' }),
      getFeeData: async () => ({ maxFeePerGas: 200n, maxPriorityFeePerGas: 10n, gasPrice: 200n }),
      estimateGas: async () => 60_000n,
      getTransactionCount: async () => pendingNonce,
      broadcastTransaction: async (raw: string) => {
        const { Transaction } = await import('ethers')
        const parsed = Transaction.from(raw)
        broadcasts.push(parsed.nonce)
        return { hash: parsed.hash, nonce: parsed.nonce } as never
      },
    }
    const wallet = new Wallet('0x' + '22'.repeat(32), provider as never)
    const chain: SubmitChainDeps = {
      getRelayer: (() => wallet) as never,
      withRelayerSendLock: async (_chainId, fn) => fn(),
    }

    const rowA = await openOutboundRecord({ chainId: CHAIN, submitter: 'sweep', to: TO, data: DATA })
    const rowB = await openOutboundRecord({ chainId: CHAIN, submitter: 'sweep', to: TO, data: DATA })

    const sentA = await submitRecorded(
      { chainId: CHAIN, recordId: rowA.id, to: TO, data: DATA },
      undefined,
      chain,
    )
    expect(sentA.nonce).toBe(5)

    // B's replica still believes 5; when the stamp collides, the retry
    // re-reads — and by then the view has advanced.
    const staleReads: number[] = []
    provider.getTransactionCount = async () => {
      staleReads.push(pendingNonce)
      const value = pendingNonce
      pendingNonce = 6
      return value
    }
    const sentB = await submitRecorded(
      { chainId: CHAIN, recordId: rowB.id, to: TO, data: DATA },
      undefined,
      chain,
    )
    expect(sentB.nonce).toBe(6)
    expect(broadcasts).toEqual([5, 6])
    // The collision really happened: B read twice — once stale, once fresh.
    expect(staleReads).toEqual([5, 6])

    const rows = await rowsFor(CHAIN)
    expect(rows.map((r) => [r.nonce, r.status]).sort()).toEqual([
      ['5', 'broadcast'],
      ['6', 'broadcast'],
    ])
  })

  it('FENCE (#1559): a claimant whose row was re-adopted gets OutboundFencedError and never broadcasts', async () => {
    const slow = await openOutboundRecord({ chainId: CHAIN, submitter: 'sweep', to: TO, data: DATA })
    // Someone else (a re-adopter) already stamped the row.
    await markOutboundTxBroadcast(slow.id!, { txHash: TX, nonce: 40n })

    let broadcastCalls = 0
    const provider = {
      getNetwork: async () => ({ chainId: BigInt(CHAIN), name: 'test' }),
      getFeeData: async () => ({ maxFeePerGas: 200n, maxPriorityFeePerGas: 10n, gasPrice: 200n }),
      estimateGas: async () => 60_000n,
      getTransactionCount: async () => 41,
      broadcastTransaction: async () => {
        broadcastCalls += 1
        return {} as never
      },
    }
    const wallet = new Wallet('0x' + '33'.repeat(32), provider as never)
    const chain: SubmitChainDeps = {
      getRelayer: (() => wallet) as never,
      withRelayerSendLock: async (_chainId, fn) => fn(),
    }

    await expect(
      submitRecorded({ chainId: CHAIN, recordId: slow.id, to: TO, data: DATA }, undefined, chain),
    ).rejects.toThrow(OutboundFencedError)
    // Whoever stamps, sends. The fenced loser sent NOTHING.
    expect(broadcastCalls).toBe(0)
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

  // ── #3263: a payload that reverts in gas estimation never becomes an orphan ──
  function revertingChain(estimateGas: () => Promise<bigint>) {
    let broadcastCalls = 0
    const provider = {
      getNetwork: async () => ({ chainId: BigInt(CHAIN), name: 'test' }),
      getFeeData: async () => ({ maxFeePerGas: 200n, maxPriorityFeePerGas: 10n, gasPrice: 200n }),
      estimateGas,
      getTransactionCount: async () => 3,
      broadcastTransaction: async () => {
        broadcastCalls += 1
        return {} as never
      },
    }
    const wallet = new Wallet('0x' + '44'.repeat(32), provider as never)
    const chain: SubmitChainDeps = {
      getRelayer: (() => wallet) as never,
      withRelayerSendLock: async (_chainId, fn) => fn(),
    }
    return { chain, broadcasts: () => broadcastCalls }
  }

  it('#3263: a DETERMINISTIC revert in gas estimation closes the record failed — it can never become a queued orphan', async () => {
    // The production shape (dev logs, 2026-09-24): EAS revoke of a missing UID.
    const { chain, broadcasts } = revertingChain(async () => {
      throw makeError('execution reverted (unknown custom error)', 'CALL_EXCEPTION', {
        action: 'estimateGas', data: '0xc5723b51', reason: null, transaction: { to: TO, data: DATA }, invocation: null, revert: null,
      })
    })
    const record = await openOutboundRecord({ chainId: CHAIN, submitter: 'passport_revoke', to: TO, data: DATA })
    await expect(
      submitRecorded({ chainId: CHAIN, recordId: record.id, to: TO, data: DATA }, undefined, chain),
    ).rejects.toMatchObject({ code: 'CALL_EXCEPTION' })
    const [row] = await rowsFor(CHAIN)
    expect(row.status).toBe('failed')
    expect(row.error).toBe('pre-broadcast reverted in estimateGas (revert data 0xc5723b51)')
    expect(broadcasts()).toBe(0)
  })

  it('#3263: a TRANSIENT populate failure leaves the record queued for the orphan path — and still propagates', async () => {
    const { chain } = revertingChain(async () => {
      throw makeError('could not coalesce error', 'UNKNOWN_ERROR', {
        error: { code: 30, message: 'Request timeout on the free plan, please upgrade to paid plan' },
      })
    })
    const record = await openOutboundRecord({ chainId: CHAIN, submitter: 'sweep', to: TO, data: DATA })
    await expect(
      submitRecorded({ chainId: CHAIN, recordId: record.id, to: TO, data: DATA }, undefined, chain),
    ).rejects.toMatchObject({ code: 'UNKNOWN_ERROR' })
    expect((await rowsFor(CHAIN))[0].status).toBe('queued')
  })

  it('#3263 review: the close carries the nonce only when it was EXPLICIT — never the pending nonce just read', async () => {
    const revert = () => {
      throw makeError('execution reverted', 'CALL_EXCEPTION', {
        action: 'estimateGas', data: '0xc5723b51', reason: null, transaction: { to: TO, data: DATA }, invocation: null, revert: null,
      })
    }
    const { chain } = revertingChain(async () => revert())
    const implicit = await openOutboundRecord({ chainId: CHAIN, submitter: 'passport_revoke', to: TO, data: DATA })
    await expect(submitRecorded({ chainId: CHAIN, recordId: implicit.id, to: TO, data: DATA }, undefined, chain)).rejects.toThrow()
    const explicit = await openOutboundRecord({ chainId: CHAIN, submitter: 'lane_cancel', to: TO, data: DATA })
    await expect(
      submitRecorded({ chainId: CHAIN, recordId: explicit.id, to: TO, data: DATA, nonce: 12 }, undefined, chain),
    ).rejects.toThrow()
    const rows = await rowsFor(CHAIN)
    expect(rows.find((r) => r.id === implicit.id)).toMatchObject({ status: 'failed', nonce: null })
    expect(rows.find((r) => r.id === explicit.id)).toMatchObject({ status: 'failed', nonce: '12' })
  })

  it('#3263: a CALL_EXCEPTION with NO revert data is not treated as deterministic', async () => {
    const { chain } = revertingChain(async () => {
      throw makeError('missing revert data', 'CALL_EXCEPTION', {
        action: 'estimateGas', data: null, reason: null, transaction: { to: TO, data: DATA }, invocation: null, revert: null,
      })
    })
    const record = await openOutboundRecord({ chainId: CHAIN, submitter: 'sweep', to: TO, data: DATA })
    await expect(
      submitRecorded({ chainId: CHAIN, recordId: record.id, to: TO, data: DATA }, undefined, chain),
    ).rejects.toMatchObject({ code: 'CALL_EXCEPTION' })
    expect((await rowsFor(CHAIN))[0].status).toBe('queued')
  })

  // ── #2769: a provider that refuses the `pending` block tag ────────────────
  // dRPC's Base plans answer `eth_getTransactionCount(addr, "pending")` with
  // this body when no flashblocks-capable upstream is available, while
  // serving `latest` normally. The shape below is the one ethers raised on
  // dev (qa-dev runs 36137615672 / 36142150551 / 36146010581).
  function pendingRefusal() {
    return makeError('could not coalesce error', 'UNKNOWN_ERROR', {
      error: {
        code: 1,
        message:
          'no available upstreams to process a request. Cause - upstream-80 - No label `flashblocks` with values [true]',
      },
      payload: { method: 'eth_getTransactionCount', params: ['0x0', 'pending'] },
    })
  }

  function refusingChain(latest: number, onPending: () => never = () => { throw pendingRefusal() }) {
    const broadcasts: number[] = []
    const tags: string[] = []
    const provider = {
      getNetwork: async () => ({ chainId: BigInt(CHAIN), name: 'test' }),
      getFeeData: async () => ({ maxFeePerGas: 200n, maxPriorityFeePerGas: 10n, gasPrice: 200n }),
      estimateGas: async () => 60_000n,
      getTransactionCount: async (_address: string, tag: string) => {
        tags.push(tag)
        if (tag === 'pending') onPending()
        return latest
      },
      broadcastTransaction: async (raw: string) => {
        const { Transaction } = await import('ethers')
        const parsed = Transaction.from(raw)
        broadcasts.push(parsed.nonce)
        return { hash: parsed.hash, nonce: parsed.nonce } as never
      },
    }
    const wallet = new Wallet('0x' + '55'.repeat(32), provider as never)
    const chain: SubmitChainDeps = {
      getRelayer: (() => wallet) as never,
      withRelayerSendLock: async (_chainId, fn) => fn(),
    }
    return { chain, broadcasts, tags }
  }

  it('#2769: the dRPC refusal body is recognised; a timeout or rate limit is not', () => {
    expect(isPendingTagRefusal(pendingRefusal())).toBe(true)
    expect(isPendingTagRefusal(makeError('request timeout', 'TIMEOUT', { operation: 'getTransactionCount', reason: 'timeout' }))).toBe(false)
    expect(isPendingTagRefusal(new Error('429 Too Many Requests'))).toBe(false)
    expect(isPendingTagRefusal(null)).toBe(false)
  })

  it('#2769: a refused `pending` read takes one past our highest LIVE broadcast when the node lags it', async () => {
    // Our own send at nonce 7 is stamped and in flight; the chain has mined
    // only up to 5. `latest` alone would re-use 5 and collide.
    const inFlight = await openOutboundRecord({ chainId: CHAIN, submitter: 'sweep', to: TO, data: DATA })
    await markOutboundTxBroadcast(inFlight.id!, { txHash: TX, nonce: 7n })
    const { chain, broadcasts, tags } = refusingChain(5)

    const record = await openOutboundRecord({ chainId: CHAIN, submitter: 'hybrid_deploy', to: TO, data: DATA })
    const sent = await submitRecorded({ chainId: CHAIN, recordId: record.id, to: TO, data: DATA }, undefined, chain)

    expect(sent.nonce).toBe(8)
    expect(broadcasts).toEqual([8])
    expect(tags).toEqual(['pending', 'latest'])
    const stamped = (await rowsFor(CHAIN)).find((r) => r.id === record.id)
    expect([stamped?.nonce, stamped?.status]).toEqual(['8', 'broadcast'])
  })

  it('#2769: a refused `pending` read takes the chain count when the ledger is behind it or empty', async () => {
    // A MINED row is not live: it must not hold the nonce back or forward.
    const old = await openOutboundRecord({ chainId: CHAIN, submitter: 'sweep', to: TO, data: DATA })
    await markOutboundTxBroadcast(old.id!, { txHash: TX, nonce: 30n })
    await db.query(`UPDATE outbound_txs SET status = 'mined' WHERE id = $1`, [old.id])
    const { chain, broadcasts } = refusingChain(12)

    const record = await openOutboundRecord({ chainId: CHAIN, submitter: 'sweep', to: TO, data: DATA })
    const sent = await submitRecorded({ chainId: CHAIN, recordId: record.id, to: TO, data: DATA }, undefined, chain)

    expect(sent.nonce).toBe(12)
    expect(broadcasts).toEqual([12])
  })

  it('#2769: any OTHER error on the `pending` read propagates, and nothing is broadcast', async () => {
    const { chain, broadcasts, tags } = refusingChain(12, () => {
      throw makeError('request timeout', 'TIMEOUT', { operation: 'getTransactionCount', reason: 'timeout' })
    })
    const record = await openOutboundRecord({ chainId: CHAIN, submitter: 'sweep', to: TO, data: DATA })

    await expect(
      submitRecorded({ chainId: CHAIN, recordId: record.id, to: TO, data: DATA }, undefined, chain),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(tags).toEqual(['pending'])
    expect(broadcasts).toEqual([])
    expect((await rowsFor(CHAIN))[0].status).toBe('queued')
  })
})
