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
import { getRelayer } from '../relayer.js'
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

/** Build the calldata without sending — the shape a test can assert on. */
export function buildAttestCall(chainId: number, claim: PassportClaim): { to: string; data: string; value: bigint } {
  const { eas } = getEasDeployment(chainId)
  const schemaUid = getPassportSchemaUid(chainId)
  const data = new Interface(EAS_ABI).encodeFunctionData('attest', [
    {
      schema: schemaUid,
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
    },
  ])
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

  const request = {
    schema: getPassportSchemaUid(chainId),
    data: {
      recipient: claim.agentEoa,
      expirationTime: BigInt(claim.expiresAt),
      revocable: true,
      refUID: ZERO_BYTES32,
      data: encodeClaim(claim),
      value: 0n,
    },
  }

  // Predict the UID; this also reverts here (costing nothing) if the schema or
  // the payload is wrong, instead of burning gas on a failing transaction.
  const attestationUid: string = await contract.attest.staticCall(request)

  const tx = await contract.attest(request)
  // Persist the hash BEFORE waiting (#1043): if the wait times out or the
  // process dies here, the retry recovers this attestation from its receipt
  // instead of minting a second one.
  await onBroadcast?.(tx.hash)
  // Bounded: the anchoring claim's stale window is 600s — an unbounded wait
  // could outlive it and let another worker reclaim mid-flight. 120s < 600s.
  const receipt = await tx.wait(1, 120_000)
  if (!receipt || receipt.status !== 1) {
    throw new Error(`passport attestation reverted (tx ${tx.hash})`)
  }
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


/** Build the revoke calldata without sending — the shape a test can assert on. */
export function buildRevokeCall(
  chainId: number,
  attestationUid: string,
): { to: string; data: string; value: bigint } {
  const { eas } = getEasDeployment(chainId)
  const data = new Interface(EAS_ABI).encodeFunctionData('revoke', [
    { schema: getPassportSchemaUid(chainId), data: { uid: attestationUid, value: 0n } },
  ])
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
  const contract = new Contract(eas, EAS_ABI, getRelayer(chainId))
  const request = {
    schema: getPassportSchemaUid(chainId),
    data: { uid: attestationUid, value: 0n },
  }
  const tx = await contract.revoke(request)
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) {
    throw new Error(`passport revocation reverted (tx ${tx.hash})`)
  }
  return { txHash: tx.hash }
}
