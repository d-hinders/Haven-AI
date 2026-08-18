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

import {
  enqueueOutboundTx,
  markOutboundTxBroadcast,
  markOutboundTxFailed,
  markOutboundTxMined,
} from './repositories/outbound-txs.js'

export interface OutboundBroadcastStamp {
  hash: string
  nonce: number | bigint
  maxFeePerGas?: bigint | null
  maxPriorityFeePerGas?: bigint | null
}

export interface OutboundRecord {
  /** Null when the open itself failed open — every later call is then a no-op. */
  id: string | null
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
