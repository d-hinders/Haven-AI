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
import { confirmAnchorUid, repairAnchoredUid } from '../../infra/repositories/agent-passports.js'
import {
  findOutboundEvidenceTxHash,
  findOutboundTxByHash,
  findOutboundTxById,
} from '../../infra/repositories/outbound-txs.js'
import { getEasDeployment, getPassportSchemaUid } from './schema.js'
import { settledReadBlock } from '../../infra/chain/settled-read-block.js'
// The anchor seam's contract types live in their own leaf (#3294): this
// module implements the seam, issuance.ts owns its setters, and neither
// imports the other (no-circular is absolute — the #3294 repair's value
// import would otherwise close a cycle through these very types).
import type { Anchor, AnchorResult, PassportClaim, RecoveredAnchor } from './anchor-contract.js'
import type { RevocationAnchorProbe, RevocationAnchorReading, Revoker } from './revocation.js'

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
  // For revocation convergence (#1758): `revocationTime` is the chain's own
  // answer to "is this attestation revoked", independent of which transaction
  // did it and of whether Haven ever saw that transaction's receipt.
  'function getAttestation(bytes32 uid) external view returns ' +
    '((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,' +
    'bytes32 refUID,address recipient,address attester,bool revocable,bytes data))',
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
 * Read the attestation UID the chain actually emitted, out of a receipt's
 * `Attested` log (#3294).
 *
 * This is THE reader for "what UID did this mint produce". It deliberately
 * answers only from the log — the same source `recoverAnchorFromReceipt` has
 * always used — because the alternative is what #3294 shipped as: a
 * `staticCall` prediction taken BEFORE the broadcast, which bakes in the
 * pre-send block's inputs and therefore names a UID the chain never attested.
 * A prediction is a revert check, never a record.
 *
 * Returns null unless a log is PROVEN ours. Each guard removes one way a
 * foreign event could be mistaken for the anchor:
 *
 * - the log must come from the pinned EAS contract address;
 * - it must decode as `Attested`;
 * - its `schemaUID` must equal the pinned passport schema for this chain — an
 *   attestation under any other schema is somebody else's credential, even
 *   inside a receipt we hold;
 * - when `from` is given (the broadcast transaction's sender), the event's
 *   attester must match it. On the direct-mint path EAS sets attester to
 *   `msg.sender`, so a mismatch means the log does not describe this mint.
 *
 * A receipt with no such log returns null — ABSENCE OF EVIDENCE. Callers must
 * never fall back to a prediction on null; see `anchorOnChain`.
 */
export function readMinedAttestationUid(
  chainId: number,
  receipt: { logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }> },
  opts: { from?: string } = {},
): string | null {
  const { eas } = getEasDeployment(chainId)
  const schemaUid = getPassportSchemaUid(chainId)
  const iface = new Interface(EAS_ABI)
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== eas.toLowerCase()) continue
    let parsed
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data })
      if (parsed?.name !== 'Attested') continue
      // ethers v6 decodes lazily: a malformed topic (e.g. an address topic
      // without the zero high bytes real chain data always carries) surfaces
      // as a DEFERRED error on first arg access, not at parseLog. Read every
      // field inside this guard — an unreadable log is ABSENCE OF EVIDENCE
      // (#3294), never a crash past the caller's record close or a partial
      // answer. The #3342 fixture keeps its attester topic left-padded to
      // 32 bytes so THIS guard, not the ABI decoder, refuses foreign logs.
      const eventSchema = String(parsed.args.schemaUID ?? '').toLowerCase()
      if (eventSchema !== schemaUid.toLowerCase()) continue
      if (opts.from) {
        const attester = String(parsed.args.attester ?? '').toLowerCase()
        if (attester !== opts.from.toLowerCase()) continue
      }
      return parsed.args.uid as string
    } catch {
      continue // not an EAS_ABI event — other logs in the same tx are fine
    }
  }
  return null
}

/**
 * Submit the attestation with the gas-only relayer and return the UID the
 * MINED transaction emitted (#3294).
 *
 * The UID is read back from the receipt's `Attested` log — the chain's own
 * answer — rather than taken from the pre-send `staticCall` prediction: EAS
 * derives the UID from inputs that include the block the transaction lands
 * in, so a prediction made at the pre-send block is not the UID the mint
 * emits. Recording the prediction left every anchored row pointing at a UID
 * that never existed, which made revocation impossible (`NotFound()` on EAS)
 * while the agent's REAL attestation stayed live.
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

  // Pre-send revert check ONLY (#3294). This costs nothing and catches a wrong
  // schema or payload before gas is spent. Its return value is a prediction
  // made at the pre-send block — EAS derives the UID from inputs that include
  // the landing block — and is NEVER recorded; the UID below comes from the
  // receipt's own `Attested` log.
  await contract.attest.staticCall(request)

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
  // `classifyAnchorTxLiveness` below. Keeping the stamped nonce on the record
  // is what makes that evidence available at all — the probe reads it from a
  // `broadcast` row, and equally from one the bump worker later closed
  // `failed` as consumed (#3293: `markFailed` keeps the row's nonce).
  if (!receipt && (!waitError || isWaitTimeout(waitError))) {
    throw new PassportAnchorUnconfirmedError(tx.hash, PASSPORT_ANCHOR_CONFIRM_TIMEOUT_MS)
  }
  if (waitError || !receipt || receipt.status !== 1) {
    await record.failed(`passport attestation reverted (tx ${tx.hash})`)
    if (waitError) throw waitError
    throw new Error(`passport attestation reverted (tx ${tx.hash})`)
  }
  // The ONLY source of the recorded UID (#3294): the mined receipt's own
  // `Attested` log, proven ours by `readMinedAttestationUid`. The broadcaster
  // is the relayer, so requiring the event's attester to match it is a
  // no-op-shaped guard that still refuses a same-schema log attested by
  // someone else in the same receipt. There is deliberately NO fallback to
  // the staticCall prediction (criterion 2) and no second read: a receipt
  // without a provable log follows the existing failed path below, where the
  // #1043 retry re-reads THIS tx's receipt instead of minting a second
  // attestation. The record closes ONCE, after the outcome is known: mined
  // only when the mint produced a provable UID, failed otherwise — the same
  // disposition a mined-and-reverted tx gets, for the same reason (the
  // submission did not produce a usable anchor).
  const minedUid = readMinedAttestationUid(chainId, receipt, { from: relayer.address })
  if (!minedUid) {
    await record.failed(
      `passport attestation mined (tx ${tx.hash}) but carried no readable Attested log — not recording a predicted UID`,
    )
    throw new Error(
      `passport attestation mined (tx ${tx.hash}) but carried no readable Attested log — not recording a predicted UID`,
    )
  }
  await record.mined()
  return { attestationUid: minedUid, txHash: tx.hash }
}

/**
 * The outcome of the proven-ours anchor read (`readProvenAnchorUid`, #3342).
 *
 * Tagged rather than nullable so a caller cannot conflate "the chain has no
 * answer yet" (`no-receipt`, `no-candidate` — retryable silence) with "the
 * chain answered and the evidence failed the invariant" (`refused` — a
 * finding, reported per row). `reverted` and `tx-body-unavailable` keep the
 * #1847 throw semantics of the recovery path; the repair maps every tag to
 * its own reported reason instead of ever guessing.
 */
export type ProvenAnchorRead =
  | { kind: 'no-receipt' }
  | { kind: 'reverted' }
  | { kind: 'no-candidate' }
  | { kind: 'tx-body-unavailable' }
  | { kind: 'refused'; reason: string }
  | { kind: 'ours'; uid: string }

/**
 * Read the attestation UID an anchor transaction emitted, PROVEN ours
 * (#3342) — the one reader for the repair and the #1043 recovery, and the
 * same guards `readMinedAttestationUid` applies on the mint path.
 *
 * The repair and the recovery used to take the FIRST `Attested` log from the
 * EAS address and check neither schema nor attester; a foreign log (a row
 * whose `tx_hash` is corrupted, points at someone else's tx, or a chain_id
 * mismatch) was then written into `agent_passports` verbatim. The invariant
 * (#3294/#3342): a UID is written to `agent_passports` only from an
 * `Attested` log with the PINNED schema, attested by the mined tx's OWN
 * `from`, in a transaction whose `to` is the pinned EAS contract.
 *
 * - The attester check is against the MINED TRANSACTION's sender, not the
 *   current relayer address: EAS sets attester to `msg.sender`, and the
 *   relayer is env-configured and rotatable — checking the current address
 *   would make every row minted before a key rotation permanently
 *   unrepairable.
 * - The candidate scan (pinned schema, under the EAS address) decides WHETHER
 *   a transaction fetch is spent at all: `no-candidate` answers without one,
 *   the same absence-of-evidence the mint path answers with. A receipt with
 *   logs from other contracts in the same tx is fine.
 *
 * Returns the outcome tagged (`ProvenAnchorRead`); `refused` names the failed
 * guard. ABSENCE of evidence is never evidence of a UID — callers write only
 * on `ours`.
 */
export async function readProvenAnchorUid(chainId: number, txHash: string): Promise<ProvenAnchorRead> {
  const receipt = await getRelayer(chainId).provider?.getTransactionReceipt(txHash)
  if (!receipt) return { kind: 'no-receipt' }
  if (receipt.status !== 1) return { kind: 'reverted' }

  const candidate = readMinedAttestationUid(chainId, receipt)
  if (!candidate) return { kind: 'no-candidate' }

  const tx = await getRelayer(chainId).provider?.getTransaction(txHash)
  if (!tx) {
    return { kind: 'tx-body-unavailable' }
  }
  const { eas } = getEasDeployment(chainId)
  // ethers v6 types `tx.to` as `string | null` — no addressable indirection.
  // A null `to` is a contract CREATE, which cannot be an EAS attest.
  if (!tx.to || tx.to.toLowerCase() !== eas.toLowerCase()) {
    return {
      kind: 'refused',
      reason: `tx ${txHash} did not target the EAS contract — its Attested log is not ours`,
    }
  }
  if (!tx.from) {
    return {
      kind: 'refused',
      reason: `tx ${txHash} carries no sender — its Attested log cannot be proven ours`,
    }
  }
  const uid = readMinedAttestationUid(chainId, receipt, { from: tx.from })
  if (!uid || uid.toLowerCase() !== candidate.toLowerCase()) {
    return {
      kind: 'refused',
      reason: `tx ${txHash}'s Attested log fails the proven-ours invariant (attester is not the tx's own sender)`,
    }
  }
  return { kind: 'ours', uid }
}

/**
 * Repair an ALREADY-anchored row whose UID is the #3294 staticCall prediction
 * (or is otherwise missing) from its recorded anchor tx hash.
 *
 * Anchored before this fix, a row points at a UID that never existed: EAS
 * reverts every revoke of it `NotFound()` while the agent's real attestation
 * stays live — the exact state found on dev, where one agent's revocation had
 * been retried 590 times against a phantom UID. The repair re-derives the real
 * UID from the receipt's `Attested` log through `readProvenAnchorUid` — since
 * #3342 the SAME proven-ours reader (pinned schema, attester = the mined tx's
 * own `from`, tx `to` = EAS) the mint path records from and the #1043
 * recovery answers from — and updates the row ONLY on positive evidence:
 *
 * - no tx_hash, or a receipt that cannot be read, or no proven log → the row
 *   is LEFT UNCHANGED and reported (`repaired: false`), never guessed;
 * - the derived UID equals the stored one → nothing to write; the match is
 *   recorded durably (`confirmAnchorUid`) so the row leaves the sweep queue
 *   (#3342) instead of costing a receipt read every tick forever;
 * - the row moved under us (revocation confirmed, re-anchor reset, a new
 *   anchor) → the compare-and-set refuses and the repair self-heals on a later
 *   sweep, because the underlying tx is durable evidence that does not rot.
 *
 * Idempotent by construction: repaired (and confirmed) rows no longer match
 * the selector. Callers pace it (see `retireAttestationOnChain`) so a burst of
 * repairs shares the one relayer lane rather than stampeding it — each
 * repair-triggered revoke is an ordinary, backoff-scheduled revoke.
 */
export async function repairAnchorUidFromReceipt(
  chainId: number,
  agentId: string,
  row: { attestation_uid: string | null; tx_hash: string | null },
): Promise<{ repaired: boolean; outcome: 'repaired' | 'confirmed' | 'unrepairable'; uid: string | null; reason: string }> {
  const txHash = row.tx_hash
  if (!txHash)
    return {
      repaired: false,
      outcome: 'unrepairable',
      uid: null,
      reason: 'row has no anchor tx_hash — cannot re-derive its UID',
    }
  let read: ProvenAnchorRead
  try {
    read = await readProvenAnchorUid(chainId, txHash)
  } catch (err) {
    return {
      repaired: false,
      outcome: 'unrepairable',
      uid: null,
      reason: `anchor receipt for ${txHash} unreadable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (read.kind === 'no-receipt' || read.kind === 'no-candidate') {
    return {
      repaired: false,
      outcome: 'unrepairable',
      uid: null,
      reason: `no Attested log yet for anchor tx ${txHash}`,
    }
  }
  if (read.kind === 'reverted') {
    return {
      repaired: false,
      outcome: 'unrepairable',
      uid: null,
      reason: `anchor receipt for ${txHash} unreadable: prior passport attestation reverted`,
    }
  }
  if (read.kind === 'tx-body-unavailable') {
    return {
      repaired: false,
      outcome: 'unrepairable',
      uid: null,
      reason: `anchor receipt for ${txHash} unreadable: tx body unavailable — attribution deferred (#1847)`,
    }
  }
  if (read.kind === 'refused') {
    // The invariant refused this log: not provably ours, so not writable.
    // Named per row (#3342) — the sweep reports it with the agent_id.
    return { repaired: false, outcome: 'unrepairable', uid: null, reason: read.reason }
  }
  const uid = read.uid
  if (row.attestation_uid && row.attestation_uid.toLowerCase() === uid.toLowerCase()) {
    // Already right. Record the confirmation so the row leaves the repair
    // queue — the pre-#3342 code returned here WITHOUT writing anything, and
    // the writeless outcome is exactly what re-queued the same oldest rows
    // every tick. The guard (anchored, same tx, not already confirmed) can
    // refuse: a row that moved mid-read is re-checked on a later pass, and
    // its non-confirmation is REPORTED, never folded into healthy.
    const confirmed = await confirmAnchorUid(agentId, txHash)
    if (!confirmed) {
      return {
        repaired: false,
        outcome: 'unrepairable',
        uid,
        reason: 'row changed since it was read — confirmation deferred to the next pass',
      }
    }
    return {
      repaired: false,
      outcome: 'confirmed',
      uid,
      reason: 'stored UID already matches the anchor receipt',
    }
  }
  const applied = await repairAnchoredUid(agentId, row.attestation_uid, uid, txHash)
  if (!applied) {
    return {
      repaired: false,
      outcome: 'unrepairable',
      uid,
      reason: 'row changed since it was read — repair deferred to the next pass',
    }
  }
  return {
    repaired: true,
    outcome: 'repaired',
    uid,
    reason: `UID re-derived from anchor tx ${txHash}`,
  }
}

/**
 * Recover a broadcast-but-unrecorded attestation from its receipt (#1043).
 *
 * Returns the result when the tx is mined and successful, null when the tx is
 * unknown or still pending (caller decides whether to re-anchor), and THROWS
 * on a mined-but-reverted tx so the caller records the failure message.
 *
 * #3342: the UID is read through `readProvenAnchorUid` — the SAME
 * proven-ours reader the mint path records from and the repair re-derives
 * from: the log must carry the pinned schema, be attested by the mined tx's
 * own `from`, and sit in a transaction whose `to` is the pinned EAS contract.
 * The pre-#3342 reader here took the FIRST `Attested` log from the EAS
 * address and checked nothing, so a foreign log placed before ours was
 * returned — and would have been recorded — as the recovered UID.
 *
 * The result carries `attested` — the addresses decoded from the mined
 * transaction's OWN calldata (#1847). Recovery can cross a re-key: this
 * broadcast was built from the facts of its day, and issuance's fresh claim
 * may name a different key by the time the receipt is read. The caller must
 * record what is actually on-chain, or `STALE_ANCHOR_PREDICATE` goes blind on
 * exactly the attestation that names a retired delegate. Decoding from the
 * calldata rather than a `getAttestation` read costs no extra contract call
 * and cannot disagree with the transaction that minted the uid; a fee bump
 * re-broadcasts the same bytes (`REBROADCAST_SAFE` payloads and the #1745
 * probe's same-calldata walk both rely on that), so the decode holds for a
 * bumped hash too. If the transaction body cannot be fetched or decoded, this
 * THROWS — a retryable failure — rather than let the caller attribute the
 * anchor from facts the chain does not hold. A receipt that carries only a
 * log the invariant REFUSES also throws: the evidence exists but is not
 * provably ours, which is a finding to surface, not silence to re-mint over.
 */
export async function recoverAnchorFromReceipt(
  chainId: number,
  txHash: string,
): Promise<RecoveredAnchor | null> {
  const read = await readProvenAnchorUid(chainId, txHash)
  if (read.kind === 'no-receipt') return null
  if (read.kind === 'reverted') {
    throw new Error(`prior passport attestation reverted (tx ${txHash})`)
  }
  if (read.kind === 'no-candidate') {
    // Mined, successful, but no Attested event from EAS — not our attestation.
    throw new Error(`tx ${txHash} succeeded but contains no EAS Attested event`)
  }
  if (read.kind === 'tx-body-unavailable') {
    throw new Error(
      `tx ${txHash} mined but its body is unavailable — cannot attribute the recovered attestation (#1847)`,
    )
  }
  if (read.kind === 'refused') {
    throw new Error(`tx ${txHash} carries no provably-ours Attested log: ${read.reason}`)
  }

  const provider = getRelayer(chainId).provider
  const tx = await provider?.getTransaction(txHash)
  if (!tx) {
    throw new Error(
      `tx ${txHash} mined but its body is unavailable — cannot attribute the recovered attestation (#1847)`,
    )
  }
  const iface = new Interface(EAS_ABI)
  const call = iface.decodeFunctionData('attest', tx.data)
  const claimBytes = call[0].data.data as string
  const decoded = AbiCoder.defaultAbiCoder().decode([...SCHEMA_TYPES], claimBytes)
  return {
    attestationUid: read.uid,
    txHash,
    attested: { agentEoa: decoded[0] as string, smartAccount: decoded[1] as string },
  }
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
 * a deeply buried) block rather than the head. See `settledReadBlock`.
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
 *   `could not win a nonce lane`. On a provider that REFUSES the `pending`
 *   tag (#2769) the shape differs: the ledger walk steps over the live row at
 *   N, so later sends stamp and broadcast at N+1, N+2 … and then never
 *   confirm (a deploy 502s at its confirmation timeout, a sweep reports "not
 *   confirmed"). After the bump worker's age gate those gap-blocked rows are
 *   bumped to their cap and raise INCIDENTs at N+1 and above — the nonce to
 *   clear is still N, the lowest live one, not the ones alarming.
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
// `settledReadBlock` and its depth moved to `infra/chain/settled-read-block.ts`
// (#3293) so the outbound bump worker reads nonces from the same settled
// vantage point as the two passport probes. Re-exported for existing callers.
export { SETTLED_CHAIN_READ_DEPTH_BLOCKS } from '../../infra/chain/settled-read-block.js'

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
  if (record.status === 'mined') return 'live'
  // A replaced row USUALLY means another transaction at the SAME nonce
  // carries this payload forward — a fee bump — and re-minting at a fresh
  // nonce would duplicate it rather than replace it. But since #1743 there is
  // a second kind of replacement: the operator LANE CANCEL, a 0-value
  // self-send that deliberately does NOT carry the payload and exists so the
  // burned nonce becomes exactly the death evidence below. Walking the link
  // and comparing calldata is what tells them apart — a replacement whose
  // payload differs carried nothing forward, so the nonce evidence (step 3)
  // stays the arbiter. An unwalkable link is treated as a payload-carrying
  // bump: `live`, the conservative reading, because guessing death is the
  // one mistake this probe exists to never make.
  if (record.status === 'replaced') {
    const replacement = record.replaced_by ? await findOutboundTxById(record.replaced_by) : null
    if (!replacement || replacement.data === record.data) return 'live'
    // A cancel-style replacement: fall through to the nonce evidence. Note
    // the receipt re-read in step 4 still protects the race where the ATTEST
    // mined despite the cancel — the consumed nonce plus our own receipt
    // reads `live`, and #1043's recovery closes on the original anchor.
  }

  // 3. Has the slot been consumed by something else, durably? Read as of a
  //    finalized/buried block, never the head — see `settledReadBlock`. The
  //    count is of MINED transactions only; `pending` would include the stuck
  //    transaction itself and could never answer this.
  const readBlock = await settledReadBlock(provider)
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

/**
 * The `outbound_txs.submitter` every passport revoke is recorded under.
 *
 * A constant rather than a literal because #1758's convergence path looks the
 * transaction back UP by this value: writer and reader drifting apart would
 * not fail — it would silently return no evidence, and the row that could have
 * converged would go back to alarming forever.
 */
export const PASSPORT_REVOKE_SUBMITTER = 'passport_revoke'

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
    submitter: PASSPORT_REVOKE_SUBMITTER,
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

/**
 * Is this attestation already revoked on-chain? (#1758)
 *
 * ## The question, and why it is this one
 *
 * #1742 bounded the revoke's wait, which means the transaction can now mine
 * AFTER the caller stopped watching — ordinary Base congestion is enough. When
 * it does, nothing re-observes it: the bump worker closes the `outbound_txs`
 * row and has no business reaching into `agent_passports`, and the only path
 * that can set `revocation_status = 'confirmed'` is a FRESH `revokeOnChain`
 * seeing `receipt.status === 1` — which can never happen again, because EAS
 * reverts every later revoke of a revoked UID with `AlreadyRevoked`. So the
 * row stayed `pending` permanently, the stuck-revoke alarm fired forever for
 * an agent whose credential was already dead, and the relayer burned gas on a
 * doomed transaction roughly hourly.
 *
 * The obvious fix is to decode that `AlreadyRevoked` revert and treat it as
 * success. This deliberately does NOT do that, for #1745's reason: a revert is
 * a claim about one transaction, and reading a failure as a success is the
 * kind of inference that goes wrong quietly. The revoked BIT is the fact
 * itself — it does not care which transaction set it, whether Haven ever saw
 * that transaction's receipt, or whether an operator revoked the attestation
 * by hand. And reading it costs no gas at all, so the doomed broadcast stops
 * happening rather than being reinterpreted after the fact.
 *
 * ## Read as of a SETTLED block, never the head
 *
 * `revocationTime` at the chain head can be undone by a reorg. Acting on that
 * would write `confirmed` — which is terminal, `listStuckRevocations` never
 * looks at those rows again — for an attestation that is still live and
 * merchant-readable after the reorg. That is the one direction that actually
 * hurts: it silences the alarm for a live credential. So the read takes the
 * same vantage point as #1745's nonce read, `settledReadBlock`, with the same
 * sanity check that a node claiming `finalized` is not just echoing the head.
 *
 * ## Three answers, and only one of them concludes anything
 *
 * - `revoked` — positive evidence, as of a settled block. The caller may
 *   converge.
 * - `live` — the attestation exists and its `revocationTime` is 0. The revoke
 *   has not landed; submit one, exactly as before.
 * - `unknown` — no provider, no settled vantage point, or the UID is not
 *   visible as of that block (a young attestation legitimately is not).
 *   ABSENCE OF EVIDENCE. It reads identically to `live` at the call site: the
 *   caller submits a revoke, which is what it would have done anyway. Nothing
 *   is ever concluded from a failed read.
 *
 * ## The evidence pointer
 *
 * Migration 049 refuses `revocation_status = 'confirmed'` without a
 * `revocation_tx_hash`, so "the chain says revoked" is not on its own a
 * representable conclusion — the row also needs the transaction that did it.
 * That comes from the durable outbound record (#1556) carrying this revoke's
 * exact calldata, preferring a `mined` row (proven status-1) over a
 * `broadcast` one. It is read HERE rather than in `revocation.ts` so that
 * module stays chain-free and relayer-free, which is what makes its state
 * machine testable without ethers.
 *
 * A `revoked` reading with no pointer is possible — an attestation revoked by
 * something Haven has no record of — and is returned honestly as
 * `txHash: null`. The caller must not invent one; see `reconcileRevocation`.
 */
export const readRevocationAnchor: RevocationAnchorProbe = async (
  chainId: number,
  attestationUid: string,
): Promise<RevocationAnchorReading> => {
  const unknown: RevocationAnchorReading = { state: 'unknown', txHash: null }
  const { eas } = getEasDeployment(chainId)
  const provider = getRelayer(chainId).provider
  // No provider means no evidence, and no evidence concludes nothing.
  if (!provider) return unknown

  const readBlock = await settledReadBlock(provider)
  if (readBlock === null) return unknown

  const attestation = await new Contract(eas, EAS_ABI, provider).getAttestation(attestationUid, {
    blockTag: readBlock,
  })
  // The struct must be the one we ASKED about. EAS returns a zeroed struct for
  // a UID it does not know, and as of a settled block that is the ordinary
  // state of an attestation minted minutes ago — "not visible yet", never "not
  // revoked". Comparing the echoed UID rather than testing for zero bytes also
  // refuses anything else a provider or shim might hand back, which is the
  // cheaper guard to hold: `revocationTime` from the wrong attestation is
  // indistinguishable from the right one's (review nit, #1758).
  const uid = String(attestation?.uid ?? '').toLowerCase()
  if (uid !== attestationUid.toLowerCase()) return unknown

  if (BigInt(attestation.revocationTime ?? 0) === 0n) return { state: 'live', txHash: null }

  return {
    state: 'revoked',
    txHash: await findOutboundEvidenceTxHash(
      chainId,
      PASSPORT_REVOKE_SUBMITTER,
      buildRevokeCall(chainId, attestationUid).data,
    ),
  }
}
