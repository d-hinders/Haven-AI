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
  // KNOWN LIMIT of that owner, named rather than implied (#1745, found by
  // #1735's review): the sweep re-mints when the receipt read returns null,
  // and null means "pending OR dropped" — it presumes dropped, ~180 s after
  // this broadcast. So a fee-stuck attest can still be duplicated by the
  // PASSPORT-level retry. That race predates #1735 and is untouched by it;
  // what #1735 removed is the second, independent route into the same state
  // (the bump worker replacing this row out from under the stored hash).
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
  try {
    receipt = await tx.wait()
  } catch (err) {
    await record.failed(`passport revocation reverted (tx ${tx.hash})`)
    throw err
  }
  if (!receipt || receipt.status !== 1) {
    await record.failed(`passport revocation reverted (tx ${tx.hash})`)
    throw new Error(`passport revocation reverted (tx ${tx.hash})`)
  }
  await record.mined()
  return { txHash: tx.hash }
}
