/**
 * Operator-triggered same-nonce lane cancel (#1743, Option A).
 *
 * The one recovery for the one wedge the bump worker deliberately refuses to
 * touch (#1735): a stuck `passport_attest` holds the relayer nonce lane, the
 * worker alerts and walks away, and until now the runbook's answer was a
 * HAND-RUN 0-value self-send — no `outbound_txs` record, a typo'd nonce or
 * wrong chain away from a new incident, and invisible to every guard built on
 * the durable record. This module encodes that exact runbook step
 * (`docs/operations/delegation-rail-vendor-ops.md` §3 step 2) through the
 * outbound pipeline instead.
 *
 * ## No timer, anywhere
 *
 * The trigger is an OPERATOR, by owner decision (#1743): the system never
 * decides on its own that an attest is dead. What the operator triggers is
 * fail-closed by construction — the cancel shares the stuck transaction's
 * nonce, and consensus guarantees at most one transaction per nonce mines —
 * so a too-eager trigger costs fees and latency, never correctness:
 *
 * - ATTEST LANDS LATE (the cancel loses): the attest's hash is unchanged (a
 *   cancel re-keys nothing), so #1043's `recoverAnchorFromReceipt` still
 *   finds the UID and the passport closes on the ORIGINAL anchor; the
 *   liveness probe's receipt re-read says `live` even while the nonce reads
 *   consumed. The chain's nonce moved past N, so later submitters stamp at
 *   N+1… and the lane flows. The cancel row itself can never mine: the bump
 *   worker's ticks re-attempt it (`lane_cancel` is rebroadcast-safe), each
 *   attempt fails "nonce too low" and is closed `failed` at the nonce, and
 *   after `MAX_BUMPS_PER_NONCE` the lane raises the worker's incident alert
 *   — the bounded, loud residual of a lost race, and the operator's cue to
 *   confirm on the explorer that the attest mined. No re-mint, no duplicate.
 * - CANCEL WINS: the nonce is durably burned, which is precisely the ONE
 *   positive fact `classifyAnchorTxLiveness` (#1745) accepts as death — the
 *   next sweep tick re-mints exactly once through `claimForAnchoring`
 *   (#1042 blocks a second live binding). The worker's chain-first scan
 *   closes the cancel row `mined`.
 * - NEITHER MINED YET: issuance keeps refusing retryably ("may still mine"),
 *   and migration 061's partial UNIQUE keeps the lane held by the cancel row.
 *
 * Nothing here re-implements that machinery — the worker, the probe and the
 * sweep resolve both outcomes exactly as they already do; this module's whole
 * job is to put a correctly-constructed cancel into their world.
 *
 * ## Ordering (061-compatible, and stricter than the worker's own)
 *
 * enqueue cancel → `markReplaced` the attest (THE CLAIM: only one trigger can
 * flip `broadcast` → `replaced`, so a concurrent second trigger loses here,
 * BEFORE anything reaches the chain — never a second cancel at different fees
 * racing the first) → `submitRecorded` with the cancel's own record id, which
 * stamps the cancel at the stuck nonce (allowed only because the attest just
 * left `broadcast`) and only then broadcasts. A crash between stamp and
 * broadcast leaves a `broadcast` cancel row whose calldata the worker
 * re-broadcasts verbatim — self-healing, unlike the worker's own
 * broadcast-then-mark residual.
 *
 * A send that THROWS resolves by where it threw (review finding): after the
 * stamp, the cancel row is left `broadcast` — the worker re-broadcasts the
 * stored calldata until a receipt closes it (an RPC error can mask an
 * accepted send; `failed` would hide the row from every scan and wedge the
 * lane silently). Before the stamp, nothing was sent: in one transaction the
 * cancel attempt is closed `failed` at the nonce and the claim is ROLLED
 * BACK so the attest re-enters `broadcast` — the wedge alert resumes and the
 * trigger can be re-run. Atomic on review finding: as two writes, a process
 * crash between them reproduced the silent wedge through a narrower door.
 *
 * A crash between the claim and the stamp leaves the attest `replaced` and
 * the cancel `queued`: the lane is DB-free, and whichever transaction next
 * takes nonce N on-chain (the orphan path re-broadcasts the cancel at a
 * fresh nonce — harmless self-send — while any other submitter may stamp N)
 * burns the slot just as the cancel would have; the probe still arbitrates
 * from the nonce evidence. Degraded, never duplicated.
 *
 * ## Lane-attempt accounting
 *
 * The claim flips the attest to `replaced` at nonce N and a failed cancel
 * broadcast is closed `failed` at nonce N — both are exactly what
 * `countLaneAttemptsAtNonce` counts, so cancels burden the same incident cap
 * the worker alerts on. The trigger itself is NOT gated on the cap: the cap's
 * escalation target is the operator, and this is the operator acting.
 */

import { STALE_BROADCAST_SECONDS, REBROADCAST_SAFE_SUBMITTERS, bumpedFees, type BumpDeps } from './outbound-bump-worker.js'
import { submitRecorded, type SubmitChainDeps } from './outbound-queue.js'
import type { OutboundTxRow } from './repositories/outbound-txs.js'

/**
 * The cancel's submitter tag. A 0-value relayer self-send is the canonical
 * REBROADCAST-SAFE payload — broadcasting it twice moves nothing, its hash
 * keys no recovery — so the tag is listed in
 * {@link REBROADCAST_SAFE_SUBMITTERS} and a fee-stuck cancel self-heals
 * through the ordinary bump path instead of becoming a second wedge.
 */
export const LANE_CANCEL_SUBMITTER = 'lane_cancel'

export type LaneCancelOutcome =
  /** The cancel is stamped and broadcast at the stuck nonce. */
  | { outcome: 'cancel_broadcast'; cancelRowId: string; txHash: string; nonce: string }
  /**
   * The cancel row is durably stamped at the stuck nonce, but the send call
   * itself threw — an AMBIGUOUS failure (an RPC timeout can lose the response
   * to a broadcast the node accepted). The row is deliberately left
   * `broadcast`: the bump worker's unmined scan owns it from here
   * (`lane_cancel` is rebroadcast-safe, so the stored calldata is re-sent
   * with bumped fees until a receipt closes it). Loud and self-healing —
   * never marked `failed`, which no scan would ever revisit (review finding:
   * that would wedge the lane SILENTLY, worse than the pre-#1743 baseline).
   */
  | { outcome: 'cancel_stamped_send_unconfirmed'; cancelRowId: string; nonce: string; detail: string }
  /** Chain-first: the "stuck" attest actually mined — closed, no cancel needed. */
  | { outcome: 'closed_mined'; rowId: string }
  /** Chain-first: it mined and reverted — closed, the lane is already free. */
  | { outcome: 'closed_reverted'; rowId: string }
  /** Fail-closed refusal; nothing was broadcast. */
  | { outcome: 'refused'; code: LaneCancelRefusal; detail: string }

export type LaneCancelRefusal =
  | 'not_found'
  | 'automated_recovery_owns_it'
  | 'not_broadcast'
  | 'not_stamped'
  | 'too_young'
  | 'fees_unavailable'
  | 'lost_claim'
  | 'broadcast_failed'

/** Chain + repo surface, injectable exactly where the outbound tests stub. */
export interface LaneCancelDeps {
  getRow(id: string): Promise<OutboundTxRow | null>
  getReceiptStatus: BumpDeps['getReceiptStatus']
  currentFees: BumpDeps['currentFees']
  enqueue: BumpDeps['enqueue']
  markMined: BumpDeps['markMined']
  markFailed: BumpDeps['markFailed']
  markReplaced: BumpDeps['markReplaced']
  /**
   * Pre-stamp failure close: mark the cancel attempt failed at the nonce AND
   * roll the claim back, ATOMICALLY (review finding — two independent writes
   * left a crash window that reproduced the silent wedge). Throws when the
   * lane moved on (061 refuses the restore inside the transaction, aborting
   * both writes).
   */
  failCancelAndRestore(params: {
    cancelId: string
    error: string
    nonce: bigint
    stuckRowId: string
    preClaimUpdatedAt: Date
  }): Promise<{ restored: boolean }>
  relayerAddress(chainId: number): string
  /** Passed through to {@link submitRecorded} — the stamp+broadcast seam. */
  chain: SubmitChainDeps
}

const refuse = (code: LaneCancelRefusal, detail: string): LaneCancelOutcome => ({
  outcome: 'refused',
  code,
  detail,
})

/**
 * Cancel the stuck outbound row's nonce lane. Fail-closed: every path that is
 * not "this row is a stale, stamped, still-unmined broadcast from a submitter
 * whose recovery the worker refuses to own" is a refusal or a chain-first
 * close, and nothing reaches the chain on any of them.
 */
export async function cancelStuckOutboundLane(
  recordId: string,
  deps: LaneCancelDeps,
): Promise<LaneCancelOutcome> {
  const row = await deps.getRow(recordId)
  if (!row) return refuse('not_found', `no outbound_txs row ${recordId}`)

  // A rebroadcast-safe submitter's stuck row is the bump worker's to replace
  // (and a lane_cancel row is itself one of those) — cancelling it is the
  // wrong tool even when the lane cap has tripped: bump, don't burn.
  if (REBROADCAST_SAFE_SUBMITTERS.has(row.submitter)) {
    return refuse(
      'automated_recovery_owns_it',
      `submitter '${row.submitter}' is rebroadcast-safe — the bump worker fee-replaces it; a cancel would burn a retryable payload`,
    )
  }

  // Idempotency lives here: after a successful trigger the attest row is
  // `replaced`, so a second trigger refuses. `queued` is not a wedge (the
  // orphan path or its own submitter owns it); `mined`/`failed` are resolved.
  if (row.status !== 'broadcast') {
    return refuse(
      'not_broadcast',
      `row is '${row.status}', not 'broadcast' — ${
        row.status === 'replaced'
          ? `a cancel/replacement is already in flight (replaced_by ${row.replaced_by})`
          : 'there is no live broadcast holding the lane'
      }`,
    )
  }
  if (row.nonce === null || !row.tx_hash) {
    return refuse('not_stamped', 'broadcast row carries no nonce/hash stamp — nothing to cancel at')
  }

  // The slow-vs-stuck gate, same threshold as the worker's scan: a young
  // broadcast is ordinary block-inclusion latency, and a cancel here would
  // burn a real attestation that was about to land. Mirrors the wedge suite's
  // positive control.
  const ageSeconds = (Date.now() - row.updated_at.getTime()) / 1000
  if (ageSeconds < STALE_BROADCAST_SECONDS) {
    return refuse(
      'too_young',
      `broadcast is ${Math.floor(ageSeconds)}s old, under the ${STALE_BROADCAST_SECONDS}s stale threshold — a live/slow tx, not a stuck one`,
    )
  }

  // Chain first, like the worker's tick: a mined "stuck" row needs closing,
  // not cancelling.
  const status = await deps.getReceiptStatus(row.chain_id, row.tx_hash)
  if (status === 1) {
    await deps.markMined(row.id)
    return { outcome: 'closed_mined', rowId: row.id }
  }
  if (status === 0) {
    await deps.markFailed(row.id, `mined and reverted (${row.tx_hash})`)
    return { outcome: 'closed_reverted', rowId: row.id }
  }

  const current = await deps.currentFees(row.chain_id)
  if (!current) return refuse('fees_unavailable', 'could not read current fees — refusing to guess a replacement fee')
  const fees = bumpedFees(
    {
      maxFeePerGas: row.max_fee_per_gas != null ? BigInt(row.max_fee_per_gas) : undefined,
      maxPriorityFeePerGas:
        row.max_priority_fee_per_gas != null ? BigInt(row.max_priority_fee_per_gas) : undefined,
    },
    current,
  )

  const nonce = BigInt(row.nonce)
  const self = deps.relayerAddress(row.chain_id)
  const cancel = await deps.enqueue({
    chainId: row.chain_id,
    submitter: LANE_CANCEL_SUBMITTER,
    toAddress: self,
    data: '0x',
    valueAtomic: 0n,
  })

  // THE CLAIM — whoever flips the attest out of `broadcast` owns the cancel;
  // everyone else stops here, before anything is signed or sent.
  const claimed = await deps.markReplaced(row.id, cancel.id)
  if (!claimed) {
    await deps.markFailed(cancel.id, 'lost the lane-cancel claim — the stuck row moved concurrently')
    return refuse('lost_claim', 'the stuck row left broadcast concurrently (another trigger or the worker) — nothing sent')
  }

  try {
    // Stamp-before-broadcast through the shared pipeline (#1559): the cancel
    // is stamped at the stuck nonce — 061 admits it because the attest just
    // left `broadcast` — and only then hits the mempool.
    const sent = await submitRecorded(
      {
        chainId: row.chain_id,
        recordId: cancel.id,
        to: self,
        data: '0x',
        valueAtomic: 0n,
        nonce: Number(nonce),
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      },
      undefined,
      deps.chain,
    )
    return { outcome: 'cancel_broadcast', cancelRowId: cancel.id, txHash: sent.hash, nonce: nonce.toString() }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // WHERE the throw happened decides what the cancel row may become
    // (review finding — the first version marked it failed unconditionally):
    //
    // - Throw BEFORE the stamp committed (fee/populate/sign error, or the
    //   stamp itself refused): the row is still `queued`, nothing can be in
    //   the mempool, and closing it `failed` AT the nonce is both true and
    //   what the lane's incident cap counts.
    // - Throw AFTER the stamp (the broadcast call errored): AMBIGUOUS — an
    //   RPC timeout can lose the response to a send the node accepted. A
    //   `failed` row leaves every scan's sight, and if the attest is still
    //   fee-stuck the lane would then be wedged with no alert and every
    //   re-trigger refused (`not_broadcast` — the attest is `replaced`):
    //   silent, unrecoverable, worse than the pre-#1743 baseline. So the
    //   stamped row is left `broadcast`, which is the one state the worker's
    //   unmined scan reconciles: re-broadcast with bumped fees
    //   (rebroadcast-safe) until a receipt closes it.
    const after = await deps.getRow(cancel.id)
    if (after?.status === 'broadcast') {
      return {
        outcome: 'cancel_stamped_send_unconfirmed',
        cancelRowId: cancel.id,
        nonce: nonce.toString(),
        detail,
      }
    }
    // Pre-stamp throw: nothing was signed into the lane, so the claim is no
    // longer true — and left standing it would MUTE the wedge (a `replaced`
    // attest never alerts) while refusing every re-trigger (`not_broadcast`).
    // Close the cancel attempt `failed` AT the nonce (the lane cap counts
    // it) and roll the claim back IN ONE TRANSACTION (review finding: as two
    // writes, a crash between them re-created the silent wedge) so the
    // attest re-enters `broadcast`: the worker's alert resumes on its next
    // tick and the trigger may simply be re-run. The restore can lose to 061
    // if some other transaction stamped the nonce meanwhile (dropped-attest
    // shape) — the transaction aborts as a whole, the lane genuinely moved
    // on, the slot will burn, and the liveness probe arbitrates from there;
    // the queued cancel degrades to the orphan-path residual.
    let restored = false
    try {
      restored = (
        await deps.failCancelAndRestore({
          cancelId: cancel.id,
          error: `lane cancel broadcast failed: ${detail}`,
          nonce,
          stuckRowId: row.id,
          preClaimUpdatedAt: row.updated_at,
        })
      ).restored
    } catch {
      restored = false
    }
    return refuse(
      'broadcast_failed',
      `${detail}${
        restored
          ? ' — nothing was sent; the claim was rolled back, the wedge alert resumes, and the trigger may be re-run'
          : ' — nothing was sent; the lane moved on concurrently, the stuck row stays replaced and the liveness probe arbitrates'
      }`,
    )
  }
}

/** Wire to the real repositories, relayer and chain. */
export async function productionLaneCancelDeps(): Promise<LaneCancelDeps> {
  const repo = await import('./repositories/outbound-txs.js')
  const { getRelayer, withRelayerSendLock } = await import('./relayer.js')
  return {
    getRow: repo.findOutboundTxById,
    enqueue: repo.enqueueOutboundTx,
    markMined: repo.markOutboundTxMined,
    markFailed: (id, reason, nonce) => repo.markOutboundTxFailed(id, reason, undefined, nonce),
    markReplaced: repo.markOutboundTxReplaced,
    failCancelAndRestore: repo.failCancelAttemptAndRestoreLane,
    relayerAddress: (chainId) => getRelayer(chainId).address,
    chain: { getRelayer, withRelayerSendLock },
    async getReceiptStatus(chainId, txHash) {
      const receipt = await getRelayer(chainId).provider?.getTransactionReceipt(txHash)
      if (!receipt) return null
      return receipt.status === 1 ? 1 : 0
    },
    async currentFees(chainId) {
      const feeData = await getRelayer(chainId).provider?.getFeeData()
      if (feeData?.maxFeePerGas == null || feeData.maxPriorityFeePerGas == null) return null
      return { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
    },
  }
}
