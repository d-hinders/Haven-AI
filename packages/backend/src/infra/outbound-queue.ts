/**
 * Call-site glue for the outbound-tx record (#1556, epic #1554).
 *
 * A submitter opens a record BEFORE broadcasting, stamps it on broadcast, and
 * closes it from the receipt. The record is what survives a process death:
 * a crash between open and broadcast leaves a `queued` row the bump worker
 * (#1558) can adopt; a crash after broadcast leaves a `broadcast` row its
 * unmined scan will find.
 *
 * FAIL-OPEN here, BY POLICY, while the repository stays fail-closed. On this
 * slice the queue is a RECORD — observability and crash recovery — not yet
 * the authority for submission (that transition is #1559, when nonce
 * allocation moves into the claim and the in-process lock retires). Letting
 * a database hiccup block a passport anchor or an account activation would
 * trade a gap in the record for an outage, the same wrong direction
 * `relayer-spend-guard` documents. The repository throwing and THIS layer
 * choosing is the layering: policy at the call site, authority in the data
 * layer.
 *
 * NOTE for #1557/#1559: when the sweep (money-path) and then the dispatcher
 * land, revisit this policy per site — a queue that has become the only lane
 * must not fail open.
 */

import { Transaction, type TransactionResponse } from 'ethers'
import {
  enqueueOutboundTx,
  markOutboundTxBroadcast,
  markOutboundTxFailed,
  markOutboundTxMined,
} from './repositories/outbound-txs.js'
import { getRelayer, withRelayerSendLock } from './relayer.js'

export interface OutboundBroadcastStamp {
  hash: string
  nonce: number | bigint
  maxFeePerGas?: bigint | null
  maxPriorityFeePerGas?: bigint | null
}

export interface OutboundRecord {
  /** Null when the open itself failed open — every later call is then a no-op. */
  id: string | null
  /**
   * VESTIGIAL since #1559 for production sites: the stamp now happens inside
   * {@link submitRecorded} (stamp-before-broadcast is the fence). Do NOT wire
   * a new submitter through this — go through `submitRecorded`.
   */
  broadcast(stamp: OutboundBroadcastStamp): Promise<void>
  mined(): Promise<void>
  failed(reason: string): Promise<void>
}

/** The repository surface this module needs — injectable so the fail-open
 *  branches are testable without faking Postgres failures. */
export interface OutboundQueueRepo {
  enqueueOutboundTx: typeof enqueueOutboundTx
  markOutboundTxBroadcast: typeof markOutboundTxBroadcast
  markOutboundTxMined: typeof markOutboundTxMined
  markOutboundTxFailed: typeof markOutboundTxFailed
}

const defaultRepo: OutboundQueueRepo = {
  enqueueOutboundTx,
  markOutboundTxBroadcast,
  markOutboundTxMined,
  markOutboundTxFailed,
}

function warn(action: string, err: unknown): void {
  console.warn(
    `outbound-queue: could not ${action} (${err instanceof Error ? err.message : String(err)}) — continuing`,
  )
}

/**
 * The stamp was refused: the row is no longer `queued`, meaning the lease
 * expired and someone else (the bump worker, another replica) already owns
 * this submission. The caller MUST NOT broadcast — the guarded stamp is the
 * fencing token (#1559): whoever stamps, sends; everyone else aborts.
 */
export class OutboundFencedError extends Error {
  constructor(recordId: string) {
    super(
      `outbound record ${recordId} is no longer queued — re-adopted or already handled; ` +
        'refusing to broadcast a second transaction for it',
    )
    this.name = 'OutboundFencedError'
  }
}

/** Chain-side surface of {@link submitRecorded}, injectable for tests. */
export interface SubmitChainDeps {
  getRelayer: typeof getRelayer
  withRelayerSendLock: typeof withRelayerSendLock
}

const defaultChainDeps: SubmitChainDeps = { getRelayer, withRelayerSendLock }

/**
 * Sign → STAMP → broadcast (#1559): the nonce is allocated and durably
 * recorded BEFORE the transaction reaches the mempool.
 *
 * Signing locally makes the hash known pre-send, so the stamp can happen
 * first, and the stamp is where all three of the epic's remaining races die:
 *
 * - CROSS-REPLICA double allocation: the partial UNIQUE (chain_id, nonce)
 *   WHERE status='broadcast' index arbitrates. Two replicas reading the same
 *   pending nonce both sign; ONE stamps; the other hits the constraint,
 *   re-reads the nonce and re-signs. Postgres, not an in-process map, is the
 *   serialisation point.
 * - SLOW-CLAIMANT double broadcast (#1555 review): the stamp is guarded on
 *   `status='queued'`. A claimant that stalls past its lease and loses its
 *   row gets null back and throws {@link OutboundFencedError} — it never
 *   broadcasts. Whoever stamps, sends.
 * - CRASH between broadcast and stamp (#1558 review): cannot exist — the
 *   stamp PRECEDES the broadcast. The worst crash now leaves a stamped row
 *   whose tx never reached the mempool, which the bump worker's
 *   receipt-check→re-broadcast path self-heals from the stored calldata.
 *
 * `withRelayerSendLock` still wraps the window: it is the in-process belt
 * (cheap, and the Safe-bound legacy sites still rely on the same lane until
 * #1440), no longer the only line of defence.
 *
 * A null `recordId` (the open failed open, or the bump worker stamping its
 * own rows) skips the stamp-first fence and degrades to the pre-#1559
 * lock-only behaviour — availability over the record, per the header policy.
 *
 * A throw BEFORE the stamp (gas estimation, lane-attempt exhaustion) leaves
 * the row `queued`: the orphan path owns it after its age gate — same
 * resolution the pre-#1559 pre-broadcast-throw had, now with a durable row.
 */
export async function submitRecorded(
  params: {
    chainId: number
    recordId: string | null
    to: string
    data: string
    valueAtomic?: bigint
    /** Explicit nonce = a same-nonce replacement (bump worker). */
    nonce?: number
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
  },
  repo: OutboundQueueRepo = defaultRepo,
  chain: SubmitChainDeps = defaultChainDeps,
): Promise<TransactionResponse> {
  const relayer = chain.getRelayer(params.chainId)
  const provider = relayer.provider
  if (!provider) {
    throw new Error(`outbound-queue: relayer has no provider for chain ${params.chainId}`)
  }
  return chain.withRelayerSendLock(params.chainId, async () => {
    const MAX_LANE_ATTEMPTS = 3
    for (let attempt = 0; attempt < MAX_LANE_ATTEMPTS; attempt++) {
      const nonce = params.nonce ?? (await relayer.getNonce('pending'))
      const populated = await relayer.populateTransaction({
        to: params.to,
        data: params.data,
        value: params.valueAtomic ?? 0n,
        nonce,
        ...(params.maxFeePerGas !== undefined ? { maxFeePerGas: params.maxFeePerGas } : {}),
        ...(params.maxPriorityFeePerGas !== undefined
          ? { maxPriorityFeePerGas: params.maxPriorityFeePerGas }
          : {}),
      })
      const raw = await relayer.signTransaction(populated)
      const hash = Transaction.from(raw).hash
      if (!hash) throw new Error('outbound-queue: signed transaction has no hash')

      if (params.recordId) {
        let stamped
        try {
          stamped = await repo.markOutboundTxBroadcast(params.recordId, {
            txHash: hash,
            nonce: BigInt(nonce),
            maxFeePerGas: toBigIntOrUndefined(populated.maxFeePerGas),
            maxPriorityFeePerGas: toBigIntOrUndefined(populated.maxPriorityFeePerGas),
          })
        } catch (err) {
          if (isUniqueViolation(err) && params.nonce === undefined) {
            // Another replica took this nonce lane between our read and our
            // stamp. Re-read and re-sign — the index did its job.
            continue
          }
          throw err
        }
        if (!stamped) throw new OutboundFencedError(params.recordId)
      }
      return provider.broadcastTransaction(raw)
    }
    throw new Error(
      `outbound-queue: could not win a nonce lane on chain ${params.chainId} after ${MAX_LANE_ATTEMPTS} attempts`,
    )
  })
}

function toBigIntOrUndefined(value: unknown): bigint | undefined {
  if (value === null || value === undefined) return undefined
  return BigInt(value as string | number | bigint)
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505'
}

export async function openOutboundRecord(
  params: {
    chainId: number
    submitter: string
    to: string
    /** FULL calldata (0x-hex) — what a bump re-broadcasts verbatim. */
    data: string
    valueAtomic?: bigint
  },
  repo: OutboundQueueRepo = defaultRepo,
): Promise<OutboundRecord> {
  let id: string | null = null
  try {
    const row = await repo.enqueueOutboundTx({
      chainId: params.chainId,
      submitter: params.submitter,
      toAddress: params.to,
      data: params.data,
      valueAtomic: params.valueAtomic,
    })
    id = row.id
  } catch (err) {
    warn(`enqueue ${params.submitter} tx`, err)
  }

  return {
    id,
    async broadcast(stamp) {
      if (!id) return
      try {
        await repo.markOutboundTxBroadcast(id, {
          txHash: stamp.hash,
          nonce: BigInt(stamp.nonce),
          maxFeePerGas: stamp.maxFeePerGas ?? undefined,
          maxPriorityFeePerGas: stamp.maxPriorityFeePerGas ?? undefined,
        })
      } catch (err) {
        warn(`stamp broadcast ${stamp.hash}`, err)
      }
    },
    async mined() {
      if (!id) return
      try {
        await repo.markOutboundTxMined(id)
      } catch (err) {
        warn('mark mined', err)
      }
    },
    async failed(reason) {
      if (!id) return
      try {
        await repo.markOutboundTxFailed(id, reason)
      } catch (err) {
        warn('mark failed', err)
      }
    },
  }
}
