/**
 * L0 Agent Passport — the on-chain anchor (#972, epic #970).
 *
 * The ONLY module that submits an attestation. Kept small on purpose: it is the
 * one place the relayer key is used for something other than paying gas on a
 * user-authorised transaction, so it should be auditable at a glance.
 *
 * ## Non-custody
 *
 * Haven signs as ISSUER. That is governance metadata, not spend authority:
 *
 * - the transaction targets the pinned EAS contract and nothing else,
 * - it carries `value: 0` and encodes no transfer,
 * - no user key, delegation, or allowance is involved.
 *
 * The relayer's role is unchanged — it still cannot move user funds. A test
 * asserts the target is the pinned EAS address and the value is zero, so a
 * future edit that pointed this at a token contract would fail loudly.
 */

import { AbiCoder, Contract, Interface } from 'ethers'
import { getRelayer } from '../../infra/relayer.js'
import { openOutboundRecord, submitRecorded } from '../../infra/outbound-queue.js'
import { findOutboundTxByHash } from '../../infra/repositories/outbound-txs.js'
import { getEasDeployment, getPassportSchemaUid } from './schema.js'
import type { Anchor, AnchorResult, PassportClaim } from './issuance.js'
import type { Revoker } from './revocation.js'

/** Field order MUST match PASSPORT_SCHEMA — the encoding is positional. */
const SCHEMA_TYPES = [
  'address', // agentEoa
  'address', // smartAccount
  'address', // treasury
  'uint8', //  assuranceLevel
  'string', // policyUri
  'uint64', // issuedAt
  'uint64', // expiresAt
] as const

const EAS_ABI = [
  'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data)) external payable returns (bytes32)',
  'function revoke((bytes32 schema,(bytes32 uid,uint256 value) data)) external payable',
  // For receipt recovery (#1043): the UID of an attestation whose result was
  // lost after broadcast is re-read from this event, never re-minted.
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
]

const ZERO_BYTES32 = '0x' + '00'.repeat(32)

/**
 * How long to wait for the attestation to confirm before handing it off
 * (#1556, disposition fixed by #1735).
 *
 * Bracketed, not round. The anchoring claim's stale window is 600 s
 * (`claimForAnchoring`), and a wait that outlived it would let the retry
 * sweep reclaim the passport while this call is still in flight — so the
 * deadline must sit comfortably below it. 120 s is also many multiples of a
 * single EAS `attest()` on 2 s Base blocks, so a healthy anchor never
 * reaches it.
 *
 * The hybrid deploy's `HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS` is the same number
 * from an independent derivation (#1722 bracketed it against the bump
 * worker's 180 s stale threshold). Coincidence, not a shared constant — do
 * not couple them.
 */
export const PASSPORT_ANCHOR_CONFIRM_TIMEOUT_MS = 120_000

/**
 * The attestation was broadcast but not confirmed within
 * {@link PASSPORT_ANCHOR_CONFIRM_TIMEOUT_MS} (#1735).
 *
 * Deliberately distinct from a revert: nothing failed, the transaction may
 * still mine, and its durable outbound record is intentionally left in
 * `broadcast`. `issuePassport` records this as a retryable failure on the
 * passport row, where the next sweep tick reaches #1043's receipt recovery
 * with the tx hash `onBroadcast` already persisted.
 */
export class PassportAnchorUnconfirmedError extends Error {
  constructor(
    readonly txHash: string,
    timeoutMs: number,
  ) {
    super(
      `passport attestation not confirmed within ${timeoutMs}ms (tx ${txHash}) — ` +
        'the transaction may still mine; its outbound record is left broadcast for receipt recovery (#1043)',
    )
    this.name = 'PassportAnchorUnconfirmedError'
  }
}

/** ethers v6 rejects a timed-out `wait()` with `code: 'TIMEOUT'`. */
function isWaitTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'TIMEOUT'
}

/** ABI-encode the claim in schema order. Exported for the encoding test. */
export function encodeClaim(claim: PassportClaim): string {
  return AbiCoder.defaultAbiCoder().encode([...SCHEMA_TYPES], [
    claim.agentEoa,
    claim.smartAccount,
    claim.treasury,
    claim.assuranceLevel,
    claim.policyUri,
    claim.issuedAt,
    claim.expiresAt,
  ])
}

/**
 * The ONE place the attest request object is built (#1556 review): the
 * outbound record's stored calldata and the transaction actually broadcast
 * both derive from this, so they cannot drift apart.
 */
export function buildAttestRequest(chainId: number, claim: PassportClaim) {
  return {
    schema: getPassportSchemaUid(chainId),
    data: {
      // The agent EOA is the attestation subject — what a merchant looks up.
      recipient: claim.agentEoa,
      expirationTime: BigInt(claim.expiresAt),
      // Revocable: live revocation is the core L0 claim (#973).
      revocable: true,
      refUID: ZERO_BYTES32,
      data: encodeClaim(claim),
      value: 0n,
    },
  }
}

/** Build the calldata without sending — the shape a test can assert on. */
export function buildAttestCall(chainId: number, claim: PassportClaim): { to: string; data: string; value: bigint } {
  const { eas } = getEasDeployment(chainId)
  const data = new Interface(EAS_ABI).encodeFunctionData('attest', [buildAttestRequest(chainId, claim)])
  return { to: eas, data, value: 0n }
}

/**
 * Submit the attestation with the gas-only relayer and return its UID.
 *
 * The UID is read back from the call's return value via `staticCall` before
 * sending, rather than parsed out of a receipt log: log ordering is not a
 * contract, and an anchored passport without its UID is unverifiable (the
 * migration makes that state unrepresentable, so we must not produce it).
 */
export const anchorOnChain: Anchor = async (
  chainId: number,
  claim: PassportClaim,
  onBroadcast?: (txHash: string) => Promise<void>,
): Promise<AnchorResult> => {
  const { eas } = getEasDeployment(chainId)
  const relayer = getRelayer(chainId)
  const contract = new Contract(eas, EAS_ABI, relayer)

  const request = buildAttestRequest(chainId, claim)

  // Predict the UID; this also reverts here (costing nothing) if the schema or
  // the payload is wrong, instead of burning gas on a failing transaction.
  const attestationUid: string = await contract.attest.staticCall(request)

  // #1556: durable record OPENED BEFORE the broadcast — a crash between here
  // and the send leaves a queued row the bump worker can adopt, instead of a
  // transaction only this process's memory knew about. `buildAttestCall` is
  // the one encoding home, so the record carries the exact calldata a bump
  // would re-broadcast.
  const record = await openOutboundRecord({
    chainId,
    submitter: 'passport_attest',
    to: eas,
    data: buildAttestCall(chainId, claim).data,
  })

  // #1559: sign → stamp → broadcast through the outbound pipeline. The stamp
  // (inside submitRecorded, under the relayer send lock) is both the durable
  // record and the fence — see outbound-queue.ts. The receipt wait below
  // stays outside the exclusive window so anchors and payments still confirm
  // in parallel (#1546).
  const tx = await submitRecorded({
    chainId,
    recordId: record.id,
    to: eas,
    data: buildAttestCall(chainId, claim).data,
  })
  // Persist the hash BEFORE waiting (#1043): if the wait times out or the
  // process dies here, the retry recovers this attestation from its receipt
  // instead of minting a second one.
  await onBroadcast?.(tx.hash)
  // Bounded: see PASSPORT_ANCHOR_CONFIRM_TIMEOUT_MS. ethers v6 THROWS out of
  // wait() on a mined-and-reverted tx (#1556 review: the post-wait status
  // check alone was dead code for exactly the failure mode it named) — the
  // catch is where a revert actually closes the record. Since #1735 it also
  // catches the deadline (`code: 'TIMEOUT'`), which is NOT a revert.
  let receipt
  let waitError: unknown
  try {
    receipt = await tx.wait(1, PASSPORT_ANCHOR_CONFIRM_TIMEOUT_MS)
  } catch (err) {
    waitError = err
  }
  // NO RECEIPT IS NOT A REVERT (#1735). A wait timeout cancels nothing — the
  // transaction stays in the mempool and may still mine — and #690 records
  // that a lagging RPC can hand back a null receipt for a tx that confirmed.
  //
  // So the record is left `broadcast`, which is the only state that is TRUE
  // here and the only one the bump worker's chain-first unmined scan will
  // ever reconcile: it closes the row `mined` or `failed` from the receipt
  // once the chain answers. Closing it `failed` now would assert a revert
  // that did not happen, drop the row out of that scan, and leave the
  // database permanently disagreeing with the chain.
  //
  // This is NOT the deploy's hand-off (#1722). `passport_attest` must never
  // be RE-BROADCAST — a second attestation is a second real, revocable
  // credential — and it must never be REPLACED either, even at the same
  // nonce: a replacement mints a new tx hash, while #1043's recovery is keyed
  // off the hash `onBroadcast` persisted above. The bump worker declines both
  // for non-rebroadcast-safe submitters and alerts instead (#1735).
  //
  // The retry owner is #1043: `issuePassport` marks the passport row failed
  // (retryable), and the next sweep tick re-reads THIS tx's receipt rather
  // than minting a second attestation.
  //
  // That owner USED to have a limit here (#1745, found by #1735's review):
  // the sweep re-minted whenever the receipt read returned null, and null
  // means "pending OR dropped" — so a merely fee-stuck attest was duplicated
  // ~180 s after this broadcast. It no longer is. The re-mint now needs
  // positive evidence that this transaction can never mine, and the only
  // thing that counts is its nonce being consumed by something else; see
  // `classifyAnchorTxLiveness` below. Leaving the record `broadcast` is what
  // makes that evidence available at all — the nonce this branch stamped is
  // the fact the probe reads.
  if (!receipt && (!waitError || isWaitTimeout(waitError))) {
    throw new PassportAnchorUnconfirmedError(tx.hash, PASSPORT_ANCHOR_CONFIRM_TIMEOUT_MS)
  }
  if (waitError || !receipt || receipt.status !== 1) {
    await record.failed(`passport attestation reverted (tx ${tx.hash})`)
    if (waitError) throw waitError
    throw new Error(`passport attestation reverted (tx ${tx.hash})`)
  }
  await record.mined()
  return { attestationUid, txHash: tx.hash }
}

/**
 * Recover a broadcast-but-unrecorded attestation from its receipt (#1043).
 *
 * Returns the result when the tx is mined and successful, null when the tx is
 * unknown or still pending (caller decides whether to re-anchor), and THROWS
 * on a mined-but-reverted tx so the caller records the failure message.
 */
export async function recoverAnchorFromReceipt(
  chainId: number,
  txHash: string,
): Promise<AnchorResult | null> {
  const { eas } = getEasDeployment(chainId)
  const receipt = await getRelayer(chainId).provider?.getTransactionReceipt(txHash)
  if (!receipt) return null
  if (receipt.status !== 1) {
    throw new Error(`prior passport attestation reverted (tx ${txHash})`)
  }
  const iface = new Interface(EAS_ABI)
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== eas.toLowerCase()) continue
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data })
      if (parsed?.name === 'Attested') {
        return { attestationUid: parsed.args.uid as string, txHash }
      }
    } catch {
      continue // not an EAS_ABI event — other logs in the same tx are fine
    }
  }
  // Mined, successful, but no Attested event from EAS — not our attestation.
  throw new Error(`tx ${txHash} succeeded but contains no EAS Attested event`)
}

/**
 * Can the attestation at `txHash` still mine? (#1745)
 *
 * ## The question this answers, and the one it refuses to answer
 *
 * `recoverAnchorFromReceipt` returns null for a pending transaction and for a
 * dropped one alike, and `issuePassport` used to read that null as "dropped"
 * and mint a second attestation. A null receipt is not evidence of death — it
 * is the ABSENCE of evidence, and the two readings have wildly asymmetric
 * costs: reading a dropped tx as live stalls one issuance, loudly and
 * recoverably; reading a live tx as dropped mints a second real, revocable
 * credential, silently and permanently.
 *
 * So this probe never declares death from silence. It declares death from ONE
 * positive fact: **the transaction's nonce slot has been consumed by something
 * else, deep enough that the consumption will not be undone.** A transaction
 * can only ever mine into its own nonce, and a nonce can only be used once, so
 * a consumed slot makes the old transaction unmineable rather than merely
 * late.
 *
 * The qualifier is load-bearing and the first version of this comment did not
 * have it. Nonce consumption is only as durable as the block that did the
 * consuming: read at the chain head, a since-orphaned block can momentarily
 * show the slot taken, and acting on that would re-mint while the original is
 * still live in the mempool — after which the reorg restores the slot, the
 * original mines, and BOTH mine. That is the exact duplicate this probe
 * exists to prevent, so the nonce is read as of a finalized (or failing that,
 * a deeply buried) block rather than the head. See `nonceReadBlock`.
 *
 * What this deliberately does NOT decide is the time question: how long an
 * unmined attest whose nonce is still open may sit before Haven declares it
 * dead on its own. That is #1743's owner call ("when is an attest dead"), and
 * it is not derivable from the code. Until it is answered, an attest holding
 * its own nonce is `live` for as long as it holds it.
 *
 * ## What ends the stall — an operator, not Haven
 *
 * It is tempting to argue that a dropped transaction stops reserving its
 * nonce, so the relayer's next broadcast takes the slot and issuance recovers
 * by itself. **That is wrong in both of the cases that matter**, and an
 * on-call engineer reading only this file should not come away believing it:
 *
 * - FEE-STUCK: the transaction is still in the mempool, so
 *   `getNonce('pending')` counts it and later submissions take N+1, N+2 …
 *   None of them can mine until N clears. The slot is held, correctly, and
 *   nothing burns it.
 * - DROPPED: `getNonce('pending')` does fall back to N, but the stuck
 *   transaction still holds a `broadcast` row at that nonce, and migration
 *   061's partial UNIQUE `(chain_id, nonce) WHERE status = 'broadcast'`
 *   refuses the stamp — `submitRecorded` re-reads the same nonce and throws
 *   `could not win a nonce lane`.
 *
 * And the blast radius is wider than this passport: `getRelayer(chainId)`
 * returns ONE wallet per chain, shared by every submitter, so a stuck
 * `passport_attest` stalls every money-path relayer transaction on that chain
 * — sweeps, hybrid deploys, revokes, other passports — until an operator
 * intervenes. #1735 chose that trade deliberately (a blocked lane is loud and
 * recoverable; a duplicate credential is silent and permanent).
 *
 * What ends it is the same-nonce cancel in
 * `docs/operations/delegation-rail-vendor-ops.md` §3. This probe's
 * contribution is that the cancel is now SUFFICIENT ON ITS OWN: once it is
 * final, the burned nonce is exactly the evidence below, and the next sweep
 * tick anchors correctly with no further operator action and no duplicate to
 * hunt for first. While it waits, the passport row keeps failing retryably
 * and alarms through `ISSUANCE_ATTENTION_ATTEMPTS`.
 *
 * ## Ordering of the reads
 *
 * The mempool read comes first and can only ever say `live`, so it costs
 * nothing to be wrong about: a node that has never heard of the transaction
 * simply falls through to the nonce test. The receipt re-read comes LAST,
 * after the burn is observed, because it is the one guard against a
 * load-balanced RPC fleet answering the two reads from nodes at different
 * heights — a node that says "nonce consumed" while holding our receipt
 * contradicts itself, and we believe the receipt.
 */
/**
 * How far back the nonce is read when the node cannot name a finalized block.
 *
 * A fallback, not the preferred path. Base and Base Sepolia are OP-stack and
 * expose `finalized`, which is the honest answer; this exists so a provider
 * that does not understand the tag degrades to something conservative rather
 * than to reading the head. At 2 s blocks this is ~10 minutes of burial,
 * comfortably past any ordinary reorg, and the latency costs nothing here —
 * the caller is a passport anchor that has already been stuck for minutes.
 */
export const ANCHOR_NONCE_READ_DEPTH_BLOCKS = 300

/**
 * A block old enough that a nonce consumed as of it will stay consumed.
 *
 * Returns null when no such vantage point exists (a chain shorter than the
 * fallback depth), which the caller reads as "no evidence" — never as death.
 *
 * The `finalized` result is sanity-checked against the head rather than
 * trusted: a node that does not implement the tag may echo the latest block
 * back, and silently reading the head is precisely the reorg exposure this
 * function exists to remove.
 */
async function nonceReadBlock(provider: {
  getBlockNumber: () => Promise<number>
  getBlock: (tag: string) => Promise<{ number: number } | null>
}): Promise<number | null> {
  const head = await provider.getBlockNumber()
  try {
    const finalized = await provider.getBlock('finalized')
    if (finalized && finalized.number < head) return finalized.number
  } catch {
    // Tag unsupported — fall through to the depth fallback.
  }
  const buried = head - ANCHOR_NONCE_READ_DEPTH_BLOCKS
  return buried > 0 ? buried : null
}

export type AnchorTxLiveness = 'live' | 'dead'

export async function classifyAnchorTxLiveness(
  chainId: number,
  txHash: string,
): Promise<AnchorTxLiveness> {
  const relayer = getRelayer(chainId)
  const provider = relayer.provider
  // No provider means no evidence, and no evidence means no re-mint.
  if (!provider) return 'live'

  // 1. Does any node still hold it? A known transaction — pending in the
  //    mempool, or mined with a receipt this caller has not seen yet (#690's
  //    lagging RPC) — is not dropped, and settles the question on its own.
  const known = await provider.getTransaction(txHash)
  if (known) return 'live'

  // 2. Unknown to this node. That is still not death: mempools are per-node
  //    and eviction is local. The durable record (#1556) is what survives it,
  //    and the nonce it stamped at broadcast is the fact we need.
  const record = await findOutboundTxByHash(chainId, txHash)
  if (!record || record.nonce === null) return 'live'
  // A replaced row means another transaction at the SAME nonce carries this
  // payload forward; re-minting at a fresh nonce would duplicate it rather
  // than replace it. (`passport_attest` is withheld from replacement by
  // #1735, so this is defence for a hand-run bump, not a live path.)
  if (record.status === 'replaced' || record.status === 'mined') return 'live'

  // 3. Has the slot been consumed by something else, durably? Read as of a
  //    finalized/buried block, never the head — see `nonceReadBlock`. The
  //    count is of MINED transactions only; `pending` would include the stuck
  //    transaction itself and could never answer this.
  const readBlock = await nonceReadBlock(provider)
  if (readBlock === null) return 'live' // no settled vantage point = no evidence
  const minedNonce = await provider.getTransactionCount(relayer.address, readBlock)
  if (BigInt(minedNonce) <= BigInt(record.nonce)) return 'live'

  // 4. The slot is burned. One last receipt read: if this provider both
  //    reports the nonce consumed AND now hands back our receipt, the
  //    consumer was our own transaction and it MINED. Believe the receipt.
  const confirming = await provider.getTransactionReceipt(txHash)
  if (confirming) return 'live'

  return 'dead'
}


/**
 * How long a revoke waits for its own receipt before handing the transaction
 * off to the bump worker (#1742).
 *
 * Bracketed by the two things that actually constrain it, not picked round:
 *
 * - FLOOR — what a healthy revoke takes. This is ONE confirmation of a single
 *   EAS `revoke` call on 2 s Base / Base Sepolia blocks, broadcast with the
 *   relayer's doubled fee headroom: one to a few blocks. 120 s is ~60 blocks
 *   of slack, so a healthy revoke never reaches the deadline and no ordinary
 *   caller sees a behaviour change.
 * - CEILING — where the transaction stops being this caller's problem. TWO
 *   independent owners can take it over, and the deadline must sit under
 *   both:
 *     - `STALE_BROADCAST_SECONDS` (180 s, `infra/outbound-bump-worker.ts`) is
 *       the age at which the bump worker's unmined scan adopts a `broadcast`
 *       row and begins fee-replacing it;
 *     - the revocation LEASE (300 s, `claimRevocation`'s `leaseSeconds` in
 *       `infra/repositories/agent-passports.ts`) is when another caller may
 *       reclaim the revocation and submit its own attempt.
 *   Waiting past either would leave this caller waiting on a transaction
 *   someone else already owns. 120 s is under both. A test asserts the 180 s
 *   inequality — the TIGHTER of the two, so it is the one that actually
 *   binds, and the only one exported as a constant rather than a default
 *   parameter a test could only duplicate as a literal.
 *
 * It matches `anchorOnChain`'s 120 s next door, which is the right kind of
 * coincidence: both are one confirmation of one EAS call on the same chains,
 * bounded above by the same worker. The anchor's ceiling is argued from its
 * 600 s claim window instead, so these are two derivations that agree, not
 * one constant copied twice.
 */
export const PASSPORT_REVOKE_CONFIRM_TIMEOUT_MS = 120_000

/**
 * The revoke was broadcast but not confirmed within
 * {@link PASSPORT_REVOKE_CONFIRM_TIMEOUT_MS} (#1742).
 *
 * Deliberately distinct from a revert: nothing failed, the transaction may
 * still mine, and its durable outbound record is intentionally left in
 * `broadcast` for the bump worker (#1558) to adopt. `reconcileRevocation`
 * catches this like any other revoke error and schedules a backoff retry, so
 * the anchor keeps converging on the DB's authoritative `revoked` standing —
 * which is exactly the behaviour `revocation.ts` was built for ("a failed
 * revoke RETRIES with backoff until the two agree").
 */
export class PassportRevokeUnconfirmedError extends Error {
  constructor(
    readonly txHash: string,
    timeoutMs: number,
  ) {
    super(
      `passport revocation not confirmed within ${timeoutMs}ms (tx ${txHash}) — ` +
        'the transaction may still mine; its outbound record is left for the bump worker',
    )
    this.name = 'PassportRevokeUnconfirmedError'
  }
}

// `isWaitTimeout` is defined once at the top of this file. #1742 introduced a
// second copy here because #1735 had not landed yet; #1735 landed first, so
// this one is gone and both halves share the anchor's definition. #1757 tracks
// hoisting it out of this module entirely — it exists a third time, unexported,
// in `rails/hybrid-provisioning.ts`.

/** The one revoke request object — record and broadcast share it (#1556). */
export function buildRevokeRequest(chainId: number, attestationUid: string) {
  return { schema: getPassportSchemaUid(chainId), data: { uid: attestationUid, value: 0n } }
}

/** Build the revoke calldata without sending — the shape a test can assert on. */
export function buildRevokeCall(
  chainId: number,
  attestationUid: string,
): { to: string; data: string; value: bigint } {
  const { eas } = getEasDeployment(chainId)
  const data = new Interface(EAS_ABI).encodeFunctionData('revoke', [buildRevokeRequest(chainId, attestationUid)])
  return { to: eas, data, value: 0n }
}

/**
 * Revoke the attestation on-chain with the gas-only relayer (#973).
 *
 * Same non-custody shape as `anchorOnChain`: targets the pinned EAS contract,
 * `value: 0`, no user key. Revoking is governance metadata being withdrawn —
 * it moves nothing and can only ever reduce an agent's standing.
 *
 * Note this is the ANCHOR catching up, not the revocation itself: the agent was
 * already revoked in the DB, which is authoritative (see `revocation.ts`).
 */
export const revokeOnChain: Revoker = async (chainId: number, attestationUid: string) => {
  const { eas } = getEasDeployment(chainId)
  // #1556: same durable-record shape as `anchorOnChain`, opened pre-broadcast.
  const record = await openOutboundRecord({
    chainId,
    submitter: 'passport_revoke',
    to: eas,
    data: buildRevokeCall(chainId, attestationUid).data,
  })
  // #1559: same sign → stamp → broadcast pipeline as `anchorOnChain`; the
  // receipt wait stays outside the exclusive window (#1546).
  const tx = await submitRecorded({
    chainId,
    recordId: record.id,
    to: eas,
    data: buildRevokeCall(chainId, attestationUid).data,
  })
  let receipt
  let waitError: unknown
  try {
    // #1742: BOUNDED. Called bare, `wait()` waits forever in ethers v6 — and
    // this runs inside the passport sweep, which is sequential under ONE
    // leader lock (`index.ts` runPassportSweep → runIfLeader). So a single
    // never-mining revoke used to park every revocation queued behind it, the
    // `alarm` phase that reports stuck revocations, and a pooled Postgres
    // connection, all indefinitely. The alarm being downstream of the stall is
    // the sharp end: the one signal that would surface "agents revoked in
    // Haven still hold a live attestation on-chain" was silenced by the very
    // condition it exists to report.
    receipt = await tx.wait(1, PASSPORT_REVOKE_CONFIRM_TIMEOUT_MS)
  } catch (err) {
    // ethers v6 throws out of wait() on a mined-and-reverted tx, so this catch
    // is where a real revert closes the record. Since #1742 it also catches
    // the deadline (`code: 'TIMEOUT'`), which is NOT a revert — see below.
    waitError = err
  }
  // NO RECEIPT IS NOT A REVERT (#1742). A wait timeout cancels nothing — the
  // transaction stays in the mempool and may still mine — and #690 records
  // that a lagging RPC can hand back a null receipt for a tx that confirmed.
  // Both mean "not observed", so the record is left in `broadcast`: the state
  // the bump worker's unmined scan adopts and fee-replaces at the SAME nonce.
  // That hand-off is safe here in both of the worker's paths — `passport_revoke`
  // is on `REBROADCAST_SAFE_SUBMITTERS` (a second revoke of the same UID
  // reverts, moving nothing), and the stale-broadcast scan is same-nonce so it
  // cannot duplicate the effect anyway. Marking it failed instead would drop
  // the transaction out of that scan and leave it with no owner at all.
  //
  // The caller is `reconcileRevocation`, which catches this like any other
  // error and schedules a backoff retry — so the anchor keeps converging on
  // the DB's authoritative `revoked` standing, which is the whole design of
  // `revocation.ts` ("no terminal failed revocation state"). Timing out is
  // therefore the SAFE direction: it re-queues the revoke instead of hanging
  // the queue that carries it.
  if (!receipt && (!waitError || isWaitTimeout(waitError))) {
    throw new PassportRevokeUnconfirmedError(tx.hash, PASSPORT_REVOKE_CONFIRM_TIMEOUT_MS)
  }
  if (waitError) {
    await record.failed(`passport revocation reverted (tx ${tx.hash})`)
    throw waitError
  }
  // `!receipt` is unreachable here — the two branches above have taken every
  // path that reaches this point with no receipt — but it is kept because the
  // compiler cannot prove that, and an unchecked `receipt.status` would be a
  // narrowing bug the moment a branch above is edited. Same defensive shape
  // `anchorOnChain` uses next door.
  if (!receipt || receipt.status !== 1) {
    await record.failed(`passport revocation reverted (tx ${tx.hash})`)
    throw new Error(`passport revocation reverted (tx ${tx.hash})`)
  }
  await record.mined()
  return { txHash: tx.hash }
}
