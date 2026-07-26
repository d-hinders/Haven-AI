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
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) {
    throw new Error(`passport attestation reverted (tx ${tx.hash})`)
  }
  return { attestationUid, txHash: tx.hash }
}
