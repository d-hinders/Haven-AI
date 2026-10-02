/**
 * The bump worker's stuck-lane CONSTANTS (#1558, #3514), lifted into their
 * own zero-import module so `GET /ops/health` can compose the stuck-lane
 * predicate from the SAME definitions the worker and
 * `cancelStuckOutboundLane` read — one set, three importers — WITHOUT the
 * ops console importing the worker itself. The ops invariant-1 walk
 * (`__tests__/ops.invariants.test.ts`) forbids the ops graph from reaching
 * `infra/outbound-*`, so anything ops reads must live where the worker does
 * not own the file. `outbound-bump-worker.ts` and `outbound-lane-cancel.ts`
 * re-export these unchanged; their behaviour is untouched.
 */

/** Broadcast rows untouched for this long are scanned against the chain. */
export const STALE_BROADCAST_SECONDS = 180
/** Queued rows this old were abandoned by a dead submitter — see the worker header. */
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
