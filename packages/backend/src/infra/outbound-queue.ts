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
 * Revisited 2026-09-24, after #1557/#1559 made the queue the only lane: KEPT
 * fail-open at every site, by owner decision. A failed open leaves the send
 * unstamped (nonce guarded only by the in-process lock) and unrecorded (the
 * bump worker cannot see it if it sticks), but it puts no funds at risk: a
 * collision only fails a broadcast, a sweep's payload is signature-bound and
 * its EIP-3009 nonce cannot pay twice, and the relayer itself holds only gas.
 * The decision assumes a single backend replica. Revisit
 * before running more than one (`docs/operations/backend-scaling.md`
 * § Multi-replica CORRECTNESS).
 */

import {
  Transaction,
  TransactionResponse,
  type Provider,
  type TransactionResponseParams,
} from 'ethers'
import {
  enqueueOutboundTx,
  markOutboundTxBroadcast,
  markOutboundTxFailed,
  markOutboundTxMined,
  listLiveBroadcastNoncesFrom,
} from './repositories/outbound-txs.js'
import { getFallbackBroadcastProvider, getRelayer, withRelayerSendLock } from './relayer.js'
import { describeRevert, isDeterministicRevert } from './deterministic-revert.js'

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
  /** Optional so existing fakes need not grow it; the default is the real read. */
  listLiveBroadcastNoncesFrom?: typeof listLiveBroadcastNoncesFrom
}

const defaultRepo: OutboundQueueRepo = {
  enqueueOutboundTx,
  markOutboundTxBroadcast,
  markOutboundTxMined,
  markOutboundTxFailed,
  listLiveBroadcastNoncesFrom,
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
  /** Optional so existing fakes need not grow it; the default is the real send. */
  sendRawViaFallback?: typeof sendRawViaFallback
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
 * `withRelayerSendLock` still wraps the window: it is the in-process belt,
 * no longer the only line of defence — except when an inline submitter's
 * open failed open (the null-`recordId` path below), where it is the only
 * one — and for the bump worker's orphan re-send, which also reads a fresh
 * nonce unstamped. Its same-nonce replacements re-use an explicit nonce under
 * its leader lock.
 *
 * A null `recordId` (the open failed open, or the bump worker stamping its
 * own rows) skips the stamp-first fence and degrades to the pre-#1559
 * lock-only behaviour — availability over the record, per the header policy.
 *
 * A throw BEFORE the stamp (gas estimation, lane-attempt exhaustion) leaves
 * the row `queued`: the orphan path owns it after its age gate — same
 * resolution the pre-#1559 pre-broadcast-throw had, now with a durable row.
 * Except (#3263) a DETERMINISTIC revert in gas estimation: that payload can
 * never be sent as it stands, so the record is closed `failed` before the
 * error propagates, instead of becoming an orphan re-sent every lease. Any
 * later success goes through the submitter's own retry, on a fresh record.
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
      const nonce =
        params.nonce ??
        (await readNextRelayerNonce(
          params.chainId,
          relayer,
          repo.listLiveBroadcastNoncesFrom ?? listLiveBroadcastNoncesFrom,
        ))
      let populated
      try {
        populated = await relayer.populateTransaction({
          to: params.to,
          data: params.data,
          value: params.valueAtomic ?? 0n,
          nonce,
          ...(params.maxFeePerGas !== undefined ? { maxFeePerGas: params.maxFeePerGas } : {}),
          ...(params.maxPriorityFeePerGas !== undefined
            ? { maxPriorityFeePerGas: params.maxPriorityFeePerGas }
            : {}),
        })
      } catch (err) {
        // #3263: the payload reverted in gas estimation — nothing was signed
        // or broadcast, and nothing ever will be for this record. Close it
        // `failed` so it cannot become a `queued` orphan the bump worker
        // re-sends forever; the submitter's own retry opens a fresh record.
        // A transient populate failure leaves the record as it was.
        if (params.recordId && isDeterministicRevert(err)) {
          try {
            // The nonce only when it was EXPLICIT (a same-nonce lane cancel or
            // replacement), so the lane cap still counts that attempt; never
            // the pending nonce just read, which would charge this failure to
            // whatever transaction later lands at that nonce.
            await repo.markOutboundTxFailed(
              params.recordId,
              `pre-broadcast ${describeRevert(err)}`,
              undefined,
              params.nonce !== undefined ? BigInt(params.nonce) : undefined,
            )
          } catch (markErr) {
            warn('mark pre-broadcast revert failed', markErr)
          }
        }
        throw err
      }
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
      return broadcastSigned(params.chainId, provider, raw, chain.sendRawViaFallback ?? sendRawViaFallback)
    }
    throw new Error(
      `outbound-queue: could not win a nonce lane on chain ${params.chainId} after ${MAX_LANE_ATTEMPTS} attempts`,
    )
  })
}

/**
 * The next nonce for a fresh relayer send (#2769).
 *
 * Normally the node's `pending` count: it includes this relayer's
 * transactions still in the mempool, so back-to-back sends take N, N+1, …
 *
 * Some providers refuse the `pending` block tag outright. dRPC's Base plans
 * route it only to flashblocks-capable upstreams and answer "no available
 * upstreams … No label `flashblocks`" when there are none, while serving
 * `latest` normally. Every relayer send without an explicit nonce died at
 * this read on dev from 2026-09-25: account deploys at first budget activation
 * and at a fresh agent's first erc7710 authorize, sweeps, passport
 * attestations and revokes, and the bump worker's orphan re-sends. Lane
 * cancels and same-nonce replacements pass an explicit nonce and never get
 * here.
 *
 * On THAT refusal only, the nonce is derived without the node's mempool view:
 * start at the chain's `latest` count (same provider, so #1533's single nonce
 * view holds) and step over every nonce this relayer holds a CONTIGUOUS live
 * broadcast at in `outbound_txs`. Every send through {@link submitRecorded}
 * with a record id is stamped there BEFORE it is broadcast, so the walk steps
 * over our own in-flight sends the node will not report. It never jumps a
 * hole: a stale row far above the count (the table has no from-address, so an
 * earlier key's dropped send looks like ours) cannot push every later send
 * into a gap nothing fills.
 *
 * The ledger read is deliberately FAIL-CLOSED, unlike {@link openOutboundRecord}:
 * without it, `latest` alone would re-use the nonce of our own in-flight send.
 * A database error propagates before anything is signed.
 *
 * Residuals. The ledger cannot see a live nonce held by an unstamped send (a
 * failed-open record; the bump worker's orphan re-send, stamped only after
 * this returns), nor during two transient handoffs (a lane cancel stamping
 * after the attest it cancels left `broadcast`; the bump worker between
 * marking a row replaced and stamping its successor). A fresh send can then
 * take that nonce and either be rejected, or — with fees at least 10% higher
 * on both fields — silently REPLACE our own unrecorded transaction. A live
 * row whose transaction was DROPPED at N = `latest` is stepped over, so later
 * sends take N+1, N+2 … and stall behind the hole until the bump worker
 * re-sends N (rebroadcast-safe submitters) or an operator clears it (a
 * `passport_attest`, or a lane past its bump cap;
 * `modules/passport/attestation.ts` describes that stall). None of these can
 * misdirect funds: a nonce orders the relayer's own transactions, it does not
 * choose what they do. Any other error from the `pending` read propagates
 * unchanged: a dead endpoint is not papered over here.
 */
export async function readNextRelayerNonce(
  chainId: number,
  relayer: { getNonce(blockTag?: string): Promise<number> },
  readLedger: (chainId: number, from: bigint) => Promise<bigint[]> = listLiveBroadcastNoncesFrom,
): Promise<number> {
  try {
    return await relayer.getNonce('pending')
  } catch (err) {
    if (!isPendingTagRefusal(err)) throw err
    const latest = await relayer.getNonce('latest')
    let next = BigInt(latest)
    for (const live of await readLedger(chainId, next)) {
      if (live === next) next += 1n
      else if (live > next) break
    }
    console.warn(
      `outbound-queue: the RPC refused the 'pending' block tag on chain ${chainId}; ` +
        `nonce ${next} derived from latest ${latest} and the live-broadcast ledger (#2769)`,
    )
    return Number(next)
  }
}

/**
 * Broadcast the signed bytes (#2769). Normally through the relayer's own
 * provider. dRPC's Base plans also refuse `eth_sendRawTransaction` with the
 * same "No label `flashblocks`" body they give the `pending` read. On THAT
 * refusal only, the identical raw transaction is sent through the chain's
 * configured second provider (`RPC_URL_BASE_FALLBACK` /
 * `RPC_URL_BASE_SEPOLIA_FALLBACK`, the same one the viem transport fails over
 * to) — never the public node. The bytes are already signed and stamped: the
 * hash is fixed, both providers forward to the same sequencer, and a second
 * copy of the same transaction is a no-op, so this changes WHICH gateway
 * carries the broadcast, never WHAT it is. The returned response is built on
 * the PRIMARY provider, so `wait()` and every later read stay on the single
 * nonce view (#1533). Any other broadcast error propagates unchanged, and so
 * does the refusal when no second provider is configured.
 */
export async function broadcastSigned(
  chainId: number,
  provider: Provider,
  raw: string,
  sendFallback: (chainId: number, raw: string) => Promise<string> = sendRawViaFallback,
): Promise<TransactionResponse> {
  try {
    return await provider.broadcastTransaction(raw)
  } catch (err) {
    if (!isPendingTagRefusal(err)) throw err
    const tx = Transaction.from(raw)
    const hash = await sendFallback(chainId, raw)
    if (hash.toLowerCase() !== tx.hash?.toLowerCase()) {
      throw new Error(
        `outbound-queue: the fallback provider returned hash ${hash}; the signed transaction is ${tx.hash}`,
      )
    }
    console.warn(
      `outbound-queue: the RPC refused eth_sendRawTransaction on chain ${chainId}; ` +
        `broadcast ${hash} through the fallback provider (#2769)`,
    )
    // Mirrors ethers' own broadcastTransaction: wrap the signed transaction on
    // the primary provider, replaceable from the current block.
    const blockNumber = await provider.getBlockNumber()
    return new TransactionResponse(tx as unknown as TransactionResponseParams, provider).replaceableTransaction(
      blockNumber,
    )
  }
}

/**
 * `eth_sendRawTransaction` through the chain's configured second provider
 * (`getFallbackBroadcastProvider` in `relayer.ts`). Its URL carries a provider
 * API key, so it is never logged or put into an error message.
 */
export async function sendRawViaFallback(chainId: number, raw: string): Promise<string> {
  const fallback = getFallbackBroadcastProvider(chainId)
  if (!fallback) {
    throw new Error(
      `outbound-queue: the RPC refused the broadcast on chain ${chainId} and no fallback provider is configured`,
    )
  }
  return String(await fallback.send('eth_sendRawTransaction', [raw]))
}

/**
 * True only for a provider refusing the `pending` block tag itself — never
 * for a timeout, a rate limit or a dead endpoint. Matches dRPC's refusal text
 * wherever ethers put it (the top-level message quotes the RPC error body).
 * A provider that words the refusal differently fails closed: the error
 * propagates, as it did before this fallback existed.
 */
export function isPendingTagRefusal(err: unknown): boolean {
  const e = err as { message?: unknown; error?: { message?: unknown } } | null
  const text = [e?.message, e?.error?.message].filter((m) => typeof m === 'string').join(' ')
  return /No label `flashblocks`/.test(text)
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
