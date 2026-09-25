/**
 * The bump/replacement worker (#1558, epic #1554) — closes the gap
 * `relayer.ts:39` has named since #814: a base-fee spike after broadcast
 * leaves a tx stuck in the mempool "with no bump path (yet)", and the stuck
 * tx blocks the relayer's whole nonce lane.
 *
 * One leader-locked tick per interval, per served chain:
 *
 *  1. BROADCAST rows past the stale threshold: ask the chain first. Mined
 *     successfully → close mined; mined-and-reverted → close failed; truly
 *     unmined → re-broadcast the SAME nonce and calldata with bumped fees,
 *     recorded as a replacement row (`replaced`/`replaced_by`) — never a
 *     silent in-place rewrite. The replacement step is gated on
 *     {@link REBROADCAST_SAFE_SUBMITTERS} (#1735): a same-nonce replacement
 *     is safe on-chain for anyone, but it mints a NEW tx hash, and a
 *     submitter whose recovery is keyed off the hash it recorded (the
 *     passport anchor, #1043) would then never find its own transaction. The
 *     chain-first closes still apply to those rows — only the bump is
 *     withheld, and the stuck lane is alerted instead.
 *  2. ORPHANED QUEUED rows (a submitter died between enqueue and broadcast):
 *     re-broadcast — but only for submitters whose payload is idempotent
 *     on-chain (see {@link REBROADCAST_SAFE_SUBMITTERS}); a passport attest
 *     is NOT (a second broadcast mints a second attestation), so it is
 *     alerted instead — its own #1043 receipt-recovery owns that retry.
 *     An orphan whose re-broadcast REVERTS with revert data is closed
 *     `failed` (#3263) rather than released to the claim lease: re-sending
 *     it unchanged every two minutes cannot succeed and only burns the
 *     relayer node's quota. A transient failure keeps the lease-and-retry.
 *     RESIDUAL RISK (review, owned by #1559): a crash BETWEEN broadcast and
 *     stamp leaves a queued-looking row whose tx is actually in flight — the
 *     orphan resend then takes a fresh nonce and, if the invisible original
 *     is fee-stuck, cannot replace it (no broadcast row exists to bump).
 *     #1559's claim-time nonce allocation removes that window: the nonce is
 *     stamped before any broadcast can happen.
 *  3. A nonce lane that has burned {@link MAX_BUMPS_PER_NONCE} replacements
 *     is an INCIDENT, not a retry: alert loudly and stop bumping it — UNLESS
 *     the chain shows the slot was consumed by another transaction (#3293):
 *     the relayer's mined nonce as of a SETTLED block is past the row's
 *     nonce, no node knows the row's hash, and a last receipt read finds
 *     nothing. That row can never mine, so it is closed `failed` before any
 *     bump or alert, whatever its submitter. Short of all three, today's
 *     path.
 *
 * Every chain interaction and repository call arrives via {@link BumpDeps}
 * so the decision logic is testable without a chain; the production deps are
 * {@link productionBumpDeps}. Broadcasts go through `withRelayerSendLock`
 * like every other submitter — this worker is one more tenant of the lane,
 * not a bypass of it (#1546).
 */

import type { OutboundTxRow } from './repositories/outbound-txs.js'
import { describeRevert, isDeterministicRevert } from './deterministic-revert.js'

/** Broadcast rows untouched for this long are scanned against the chain. */
export const STALE_BROADCAST_SECONDS = 180
/** Queued rows this old were abandoned by a dead submitter — see header. */
export const ORPHAN_QUEUED_SECONDS = 600
/** Replacements per (chain, nonce) before the lane is an incident. */
export const MAX_BUMPS_PER_NONCE = 3

/**
 * Submitters whose stored payload is safe to broadcast twice: the sweep's
 * EIP-3009 authorization nonce is single-use on-chain (a duplicate reverts,
 * moving nothing); a hybrid CREATE2 factory deploy of an existing account
 * reverts/no-ops; a second passport revoke of the same UID reverts. The
 * attest mints a NEW attestation each time — never listed here.
 *
 * Membership gates BOTH paths (#1735). For the orphan path it means what it
 * says: may this payload be broadcast a second time. For the stale-broadcast
 * path it carries a second, weaker meaning — may this worker take OWNERSHIP
 * of the submission at all — because a replacement changes the tx hash the
 * submitter recorded. The two happen to need the same list, so it is one
 * list; if a submitter ever wants one and not the other, split it rather
 * than widening this.
 */
export const REBROADCAST_SAFE_SUBMITTERS: ReadonlySet<string> = new Set([
  'sweep',
  'hybrid_deploy',
  'passport_revoke',
  // #1743: the operator lane cancel's 0-value relayer self-send. The
  // canonical rebroadcast-safe payload — a duplicate broadcast moves nothing
  // and its hash keys no recovery — so a fee-stuck cancel is fee-replaced by
  // this worker instead of becoming a second wedge, and a cancel that LOST
  // its race (the attest mined at the shared nonce) is closed `failed` here:
  // on its first stale tick once that mining is settled (#3293, consumed
  // nonce), or before then when a bump attempt gets "nonce too low".
  'lane_cancel',
])

export interface BumpFees {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/**
 * Replacement fees: at least 12.5% over the stuck tx (nodes require ≥10% on
 * BOTH fields to accept a same-nonce replacement; 1/8 clears that with
 * integer math and margin), and never below the chain's current estimate —
 * bumping to yesterday's price would stick again immediately.
 */
export function bumpedFees(previous: Partial<BumpFees>, current: BumpFees): BumpFees {
  const bump = (old: bigint | undefined, now: bigint): bigint => {
    const floor = old !== undefined ? old + old / 8n + 1n : 0n
    return now > floor ? now : floor
  }
  return {
    maxFeePerGas: bump(previous.maxFeePerGas, current.maxFeePerGas),
    maxPriorityFeePerGas: bump(previous.maxPriorityFeePerGas, current.maxPriorityFeePerGas),
  }
}

export interface BumpDeps {
  listUnmined(chainId: number, olderThanSeconds: number): Promise<OutboundTxRow[]>
  claimOrphan(chainId: number, olderThanSeconds: number): Promise<OutboundTxRow | null>
  enqueue(params: {
    chainId: number
    submitter: string
    toAddress: string
    data: string
    valueAtomic?: bigint
  }): Promise<OutboundTxRow>
  markBroadcast(
    id: string,
    params: { txHash: string; nonce: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint },
  ): Promise<OutboundTxRow | null>
  markMined(id: string): Promise<OutboundTxRow | null>
  markFailed(id: string, reason: string, nonce?: bigint): Promise<OutboundTxRow | null>
  markReplaced(id: string, replacedById: string): Promise<OutboundTxRow | null>
  /** Successful AND failed replacement attempts on the lane — the cap's base. */
  countLaneAttempts(chainId: number, nonce: bigint): Promise<number>
  /** null = unknown to the chain (unmined or dropped). */
  getReceiptStatus(chainId: number, txHash: string): Promise<0 | 1 | null>
  /**
   * #3293: does any node this provider reaches still know the transaction
   * (pending in a mempool, or mined)? A known transaction is never closed as
   * consumed — including one sent by an earlier relayer key.
   */
  isTxKnown(chainId: number, txHash: string): Promise<boolean>
  /**
   * #3293: the relayer's MINED nonce as of a settled block
   * (`infra/chain/settled-read-block.ts`) — never the head, which can race the
   * row's own mining and be un-shown by a reorg. null = no settled vantage
   * point, which is no evidence.
   */
  settledMinedNonce(chainId: number): Promise<bigint | null>
  currentFees(chainId: number): Promise<BumpFees | null>
  /** Broadcast under the relayer send lock. `nonce` set = same-nonce replacement. */
  sendRaw(
    chainId: number,
    tx: { to: string; data: string; value: bigint; nonce?: number } & Partial<BumpFees>,
  ): Promise<{ hash: string; nonce: number }>
}

export interface BumpLogger {
  info(obj: unknown, msg: string): void
  warn(obj: unknown, msg: string): void
  error(obj: unknown, msg: string): void
}

export interface BumpTickResult {
  closedMined: number
  closedFailed: number
  bumped: number
  rebroadcastOrphans: number
  /** #3263: orphans closed `failed` because their payload reverts deterministically. */
  failedOrphans: number
  alerted: number
}

/** One tick for one chain. Never throws — a failed row logs and moves on. */
export async function runOutboundBumpTick(
  chainId: number,
  deps: BumpDeps,
  log: BumpLogger,
): Promise<BumpTickResult> {
  const result: BumpTickResult = {
    closedMined: 0,
    closedFailed: 0,
    bumped: 0,
    rebroadcastOrphans: 0,
    failedOrphans: 0,
    alerted: 0,
  }

  // ── Stale broadcast rows: chain first, bump only what is truly unmined ────
  // #3293: the settled mined nonce, read at most ONCE per tick and only when a
  // row needs it (the relayer provider is primary-only, #3255). `undefined` =
  // not read yet; `null` = no evidence (no settled block, or the read threw).
  let settledNonce: bigint | null | undefined
  const readSettledNonce = async (): Promise<bigint | null> => {
    if (settledNonce === undefined) {
      try {
        settledNonce = await deps.settledMinedNonce(chainId)
      } catch (err) {
        log.warn({ err, chainId }, 'outbound-bump: settled nonce read failed — no consumed-nonce evidence this tick')
        settledNonce = null
      }
    }
    return settledNonce
  }
  let stale: OutboundTxRow[] = []
  try {
    stale = await deps.listUnmined(chainId, STALE_BROADCAST_SECONDS)
  } catch (err) {
    log.warn({ err, chainId }, 'outbound-bump: unmined scan failed')
  }
  for (const row of stale) {
    try {
      if (!row.tx_hash || row.nonce == null) continue
      const status = await deps.getReceiptStatus(chainId, row.tx_hash)
      if (status === 1) {
        await deps.markMined(row.id)
        result.closedMined += 1
        continue
      }
      if (status === 0) {
        await deps.markFailed(row.id, `mined and reverted (${row.tx_hash})`)
        result.closedFailed += 1
        continue
      }

      // #3293: a null receipt is not yet "truly unmined". If the relayer's
      // nonce as of a SETTLED block is already past this row's nonce, no node
      // knows the transaction, and a last receipt read still finds nothing,
      // then another transaction consumed the slot and this one can never
      // mine — close it instead of bumping it or raising a lane INCIDENT that
      // no operator can act on (the same evidence chain
      // `classifyAnchorTxLiveness` uses, steps 1, 3 and 4). Placed BEFORE the
      // non-idempotent gate: a consumed-nonce attest is just as dead, and
      // #1043 recovery reads `failed` like `broadcast` (straight to its nonce
      // evidence). Anything short of all three is no evidence: today's path.
      const settled = await readSettledNonce()
      if (settled !== null && settled > BigInt(row.nonce)) {
        let known = true
        let recheck: 0 | 1 | null = null
        try {
          known = await deps.isTxKnown(chainId, row.tx_hash)
          if (!known) recheck = await deps.getReceiptStatus(chainId, row.tx_hash)
        } catch (err) {
          log.warn({ err, chainId, id: row.id }, 'outbound-bump: consumed-nonce evidence read failed — treating as no evidence')
          known = true
        }
        if (!known && recheck === 1) {
          await deps.markMined(row.id)
          result.closedMined += 1
          continue
        }
        if (!known && recheck === 0) {
          await deps.markFailed(row.id, `mined and reverted (${row.tx_hash})`)
          result.closedFailed += 1
          continue
        }
        if (!known && recheck === null) {
          await deps.markFailed(
            row.id,
            `dropped: nonce ${row.nonce} consumed on-chain by another transaction ` +
              `(settled mined nonce ${settled}); ${row.tx_hash} is unknown to the node and can never mine`,
          )
          result.closedFailed += 1
          log.warn(
            { chainId, id: row.id, submitter: row.submitter, nonce: row.nonce, settledNonce: String(settled), txHash: row.tx_hash },
            'outbound-bump: stale broadcast whose nonce was consumed by another transaction — closed failed, not bumped',
          )
          continue
        }
      }

      // Truly unmined, and we are about to spend gas on it. A REPLACEMENT is
      // safe on-chain for any submitter — same nonce, so at most one of the
      // two can ever mine — but it is not safe for every submitter's RECOVERY
      // (#1735). A replacement carries a new tx hash, and a submitter whose
      // retry path is keyed off the hash it recorded (the passport anchor's
      // #1043 receipt recovery) can no longer find its own transaction: it
      // reads null forever and re-mints for real, which for `passport_attest`
      // means a second live, revocable credential.
      //
      // Same set, same reason as the orphan path below — a payload we may not
      // duplicate is also a payload whose owner we may not take. The
      // chain-first closes ABOVE still apply to these rows, which is the
      // point: `broadcast` remains a reconcilable state for them, just not a
      // bumpable one.
      //
      // ACCEPTED COST, stated plainly because it is an outage shape: not
      // bumping leaves the nonce lane blocked, and this worker exists to
      // unblock exactly that. Every later relayer transaction on the chain
      // queues behind the stuck attest until an operator acts. That is the
      // deliberate trade — a blocked lane is loud, bounded and recoverable by
      // a human, while a duplicate attestation is silent, permanent, and the
      // precise failure #1042/#1043 were built to prevent. The clean fix is a
      // same-nonce CANCEL (a 0-value self-send) that unblocks the lane AND
      // definitively kills the attest, making a fresh anchor correct; that is
      // a new mechanism and an owner decision, deliberately not taken here
      // (#1735).
      if (!REBROADCAST_SAFE_SUBMITTERS.has(row.submitter)) {
        log.error(
          { chainId, id: row.id, submitter: row.submitter, txHash: row.tx_hash, nonce: row.nonce },
          'outbound-bump: stuck broadcast from a non-idempotent submitter — NOT replacing it (its own recovery owns the retry); ' +
            'the relayer nonce lane stays blocked until an operator intervenes',
        )
        result.alerted += 1
        continue
      }

      const nonce = BigInt(row.nonce)
      const priorBumps = await deps.countLaneAttempts(chainId, nonce)
      if (priorBumps >= MAX_BUMPS_PER_NONCE) {
        // The lane survived N replacements without mining: alert, don't spend
        // more gas on it — an operator (or a deliberate cancel tx) owns it now.
        log.error(
          { chainId, nonce: row.nonce, txHash: row.tx_hash, priorBumps },
          `outbound-bump: nonce lane stuck after ${priorBumps} replacements — INCIDENT, not retrying`,
        )
        result.alerted += 1
        continue
      }

      const current = await deps.currentFees(chainId)
      if (!current) continue
      const fees = bumpedFees(
        {
          maxFeePerGas: row.max_fee_per_gas != null ? BigInt(row.max_fee_per_gas) : undefined,
          maxPriorityFeePerGas:
            row.max_priority_fee_per_gas != null ? BigInt(row.max_priority_fee_per_gas) : undefined,
        },
        current,
      )
      // Replacement row FIRST, then broadcast, then link — so a crash
      // mid-sequence leaves either a harmless queued row or a stamped one,
      // never an untracked broadcast.
      const replacement = await deps.enqueue({
        chainId,
        submitter: row.submitter,
        toAddress: row.to_address,
        data: row.data,
        valueAtomic: BigInt(row.value_atomic),
      })
      let sent: { hash: string; nonce: number }
      try {
        sent = await deps.sendRaw(chainId, {
          to: row.to_address,
          data: row.data,
          value: BigInt(row.value_atomic),
          nonce: Number(nonce),
          ...fees,
        })
      } catch (err) {
        // Review finding: a throwing bump broadcast must not leave a dangling
        // queued row, and must COUNT toward the lane cap (the failed row
        // carries the nonce it tried to replace) — otherwise a lane whose
        // bumps keep throwing retries forever and the incident alert never
        // fires. "nonce too low" here usually means the original mined after
        // our receipt read; the next tick's chain-first check closes it.
        await deps.markFailed(
          replacement.id,
          `bump broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
          nonce,
        )
        throw err
      }
      // ORDER MATTERS (#1559 review, reproduced on real Postgres): the
      // original must leave 'broadcast' BEFORE the replacement is stamped at
      // the same nonce, or the partial UNIQUE live-nonce index — correctly —
      // rejects the stamp and every bump fails forever. A crash between the
      // two marks leaves the replacement as a queued orphan whose tx is in
      // flight: the documented residual the orphan path + cap bound.
      await deps.markReplaced(row.id, replacement.id)
      await deps.markBroadcast(replacement.id, {
        txHash: sent.hash,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      })
      result.bumped += 1
      log.info(
        { chainId, nonce: row.nonce, from: row.tx_hash, to: sent.hash },
        'outbound-bump: replaced a stuck broadcast with bumped fees',
      )
    } catch (err) {
      log.warn({ err, chainId, id: row.id }, 'outbound-bump: bump failed for row')
    }
  }

  // ── Orphaned queued rows: a submitter died between enqueue and broadcast ──
  for (;;) {
    let orphan: OutboundTxRow | null = null
    try {
      orphan = await deps.claimOrphan(chainId, ORPHAN_QUEUED_SECONDS)
    } catch (err) {
      log.warn({ err, chainId }, 'outbound-bump: orphan claim failed')
      break
    }
    if (!orphan) break
    if (!REBROADCAST_SAFE_SUBMITTERS.has(orphan.submitter)) {
      // Non-idempotent payload: broadcasting it blind could duplicate a
      // side effect (a second attestation). Alert; the submitter's own
      // recovery path (#1043 for attest) owns the retry decision.
      log.error(
        { chainId, id: orphan.id, submitter: orphan.submitter },
        'outbound-bump: orphaned row from a non-idempotent submitter — needs its own recovery, not a blind re-broadcast',
      )
      result.alerted += 1
      continue
    }
    try {
      const sent = await deps.sendRaw(chainId, {
        to: orphan.to_address,
        data: orphan.data,
        value: BigInt(orphan.value_atomic),
      })
      await deps.markBroadcast(orphan.id, { txHash: sent.hash, nonce: BigInt(sent.nonce) })
      result.rebroadcastOrphans += 1
      log.info(
        { chainId, id: orphan.id, submitter: orphan.submitter, txHash: sent.hash },
        'outbound-bump: re-broadcast an orphaned queued tx',
      )
    } catch (err) {
      // #3263: a payload that REVERTS will revert on every later claim too —
      // close it instead of re-sending it every lease forever (388 such
      // orphans were burning the dev relayer's RPC quota). A transient
      // failure (timeout, rate limit, 5xx) keeps the lease-and-retry path.
      if (isDeterministicRevert(err)) {
        try {
          await deps.markFailed(orphan.id, `orphan re-broadcast ${describeRevert(err)}`)
          result.failedOrphans += 1
          log.warn(
            { chainId, id: orphan.id, submitter: orphan.submitter, reason: describeRevert(err) },
            'outbound-bump: orphan payload reverts — closed failed, not retried',
          )
        } catch (markErr) {
          log.warn({ err: markErr, chainId, id: orphan.id }, 'outbound-bump: could not close a reverting orphan')
        }
        continue
      }
      log.warn({ err, chainId, id: orphan.id }, 'outbound-bump: orphan re-broadcast failed')
    }
  }

  return result
}

/** Wire the worker to the real repositories, relayer and chain. */
export async function productionBumpDeps(): Promise<BumpDeps> {
  const repo = await import('./repositories/outbound-txs.js')
  const { getRelayer } = await import('./relayer.js')
  return {
    listUnmined: repo.listUnminedOutboundTxs,
    claimOrphan: repo.claimOrphanedOutboundTx,
    enqueue: repo.enqueueOutboundTx,
    markBroadcast: repo.markOutboundTxBroadcast,
    markMined: repo.markOutboundTxMined,
    markFailed: (id, reason, nonce) => repo.markOutboundTxFailed(id, reason, undefined, nonce),
    markReplaced: repo.markOutboundTxReplaced,
    countLaneAttempts: repo.countLaneAttemptsAtNonce,

    async getReceiptStatus(chainId, txHash) {
      const receipt = await getRelayer(chainId).provider?.getTransactionReceipt(txHash)
      if (!receipt) return null
      return receipt.status === 1 ? 1 : 0
    },

    async isTxKnown(chainId, txHash) {
      const provider = getRelayer(chainId).provider
      // No provider = no evidence = treat as known (never close on silence).
      if (!provider) return true
      return (await provider.getTransaction(txHash)) !== null
    },

    async settledMinedNonce(chainId) {
      const relayer = getRelayer(chainId)
      const provider = relayer.provider
      if (!provider) return null
      const { settledReadBlock } = await import('./chain/settled-read-block.js')
      const block = await settledReadBlock(provider)
      if (block === null) return null
      return BigInt(await provider.getTransactionCount(relayer.address, block))
    },

    async currentFees(chainId) {
      // Deliberately NOT the 2x headroom initial broadcasts use
      // (getRelayerFeeOverrides): the bump floor already guarantees +12.5%
      // per attempt, and doubling on every bump compounds. If replacements
      // observably re-stick, revisit alongside the #1558 follow-up the issue
      // notes for the initial-headroom guess.
      const feeData = await getRelayer(chainId).provider?.getFeeData()
      if (feeData?.maxFeePerGas == null || feeData.maxPriorityFeePerGas == null) return null
      return { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
    },

    async sendRaw(chainId, tx) {
      // Through the shared sign→broadcast pipeline (#1559) with recordId null:
      // the worker stamps its own rows (replacement bookkeeping differs from
      // the inline sites'), and its serialisation is the leader lock + the
      // in-process belt inside submitRecorded.
      const { submitRecorded } = await import('./outbound-queue.js')
      const sent = await submitRecorded({
        chainId,
        recordId: null,
        to: tx.to,
        data: tx.data,
        valueAtomic: tx.value,
        ...(tx.nonce !== undefined ? { nonce: tx.nonce } : {}),
        ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas } : {}),
        ...(tx.maxPriorityFeePerGas !== undefined
          ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas }
          : {}),
      })
      return { hash: sent.hash, nonce: sent.nonce }
    },
  }
}
