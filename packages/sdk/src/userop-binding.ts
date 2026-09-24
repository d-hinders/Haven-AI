import { encodeAbiParameters, getAddress, isAddress, keccak256, type Hex } from 'viem'
import { HavenError } from './types.js'

/**
 * #3271: the integrity check every client runs before signing a direct
 * delegation-rail payment's typed data.
 *
 * A direct payment (`POST /payments`, surfaced as `haven_send` / `haven_pay`)
 * is signed as the HybridDeleGator's EIP-712 `PackedUserOperation`, and Haven
 * returns two things for it: that typed data, and `payload_hash` — the
 * ERC-4337 v0.7 UserOperation hash of the same operation. Nothing used to tie
 * the two together at signing time. The typed data is multi-KB and reaches the
 * signer through a language model when it is relayed by hand, so one corrupted
 * character produced a valid-looking signature over the wrong digest, and the
 * first sign of it was `AA24 signature error` from the bundler (#3271,
 * reproduced on dev 2026-09-24).
 *
 * This recomputes the v0.7 hash from the typed data's own message and domain
 * and refuses unless it equals `payload_hash`, and it pins the parts of the
 * typed data the hash does NOT cover (domain name/version/verifyingContract,
 * the field list, the EntryPoint). It is a CORRUPTION check: the caller supplies
 * both values, so it proves they describe the same operation, never that Haven
 * prepared it. Provenance is the byte-free sign context (`payment_id`); what the
 * signer will sign at all is #3272.
 *
 * Pure viem, no ethers: `@haven_ai/sdk/edge` re-exports it for the edge signer,
 * and `edge-imports.test.ts` pins that graph.
 */

/** Version of the direct-payment sign context (`GET /payments/:id/sign-context`). */
export const DIRECT_SIGN_CONTEXT_VERSION = 1

/** The ERC-4337 v0.7 EntryPoint — the only one the delegation rail submits to. */
export const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

/**
 * The HybridDeleGator EIP-712 domain constants and the `PackedUserOperation`
 * field list, vendored from `@metamask/smart-accounts-kit`
 * (`contracts.HybridDeleGator.constants`, `SIGNABLE_USER_OP_TYPED_DATA`) so the
 * published packages need no runtime dependency on the kit. Pinned equal to the
 * kit's values by `userop-binding.test.ts`.
 */
export const HYBRID_DELEGATOR_DOMAIN_NAME = 'HybridDeleGator'
export const HYBRID_DELEGATOR_DOMAIN_VERSION = '1'
export const PACKED_USER_OPERATION_FIELDS: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'sender', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'initCode', type: 'bytes' },
  { name: 'callData', type: 'bytes' },
  { name: 'accountGasLimits', type: 'bytes32' },
  { name: 'preVerificationGas', type: 'uint256' },
  { name: 'gasFees', type: 'bytes32' },
  { name: 'paymasterAndData', type: 'bytes' },
  { name: 'entryPoint', type: 'address' },
]

/** Refusal raised when direct-payment typed data does not match its `payload_hash`. */
export class HavenUserOpBindingError extends HavenError {
  constructor(message: string) {
    super(message, 'USEROP_BINDING_MISMATCH')
    this.name = 'HavenUserOpBindingError'
  }
}

/** True when the typed data is a `PackedUserOperation` (the direct-payment shape). */
export function isPackedUserOperationTypedData(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { primaryType?: unknown }).primaryType === 'PackedUserOperation'
  )
}

const HEX = /^0x[0-9a-fA-F]*$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/

function refuse(detail: string): never {
  throw new HavenUserOpBindingError(
    `Refusing to sign: this direct-payment typed data does not match its payload_hash (${detail}). ` +
      'The payload was altered between the Haven result and this call — sign by payment_id so the ' +
      'signer fetches the exact bytes, or pass typed_data_b64 from the result unchanged.',
  )
}

function hexField(message: Record<string, unknown>, key: string, pattern: RegExp): Hex {
  const value = message[key]
  if (typeof value !== 'string' || !pattern.test(value)) refuse(`message.${key} is not well-formed`)
  return value as Hex
}

function uintField(message: Record<string, unknown>, key: string): bigint {
  const value = message[key]
  try {
    if (typeof value === 'bigint') return value
    if ((typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) || typeof value === 'number') {
      const n = BigInt(value)
      if (n >= 0n) return n
    }
  } catch {
    // fall through to the refusal
  }
  return refuse(`message.${key} is not an unsigned integer`)
}

function addressField(value: unknown, where: string): `0x${string}` {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) refuse(`${where} is not an address`)
  return getAddress(value as string)
}

/**
 * Compute the ERC-4337 v0.7 UserOperation hash from a HybridDeleGator
 * `PackedUserOperation` typed-data object — the value Haven returns as
 * `payload_hash` for a direct payment (`getUserOperationHash`, entryPoint 0.7).
 */
export function packedUserOperationHash(typedData: unknown): Hex {
  if (!isPackedUserOperationTypedData(typedData)) refuse('primaryType is not PackedUserOperation')
  const td = typedData as { domain?: Record<string, unknown>; message?: Record<string, unknown> }
  const message = td.message
  if (!message || typeof message !== 'object') refuse('message is missing')
  const chainId = uintField({ chainId: td.domain?.chainId }, 'chainId')
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        addressField(message.sender, 'message.sender'),
        uintField(message, 'nonce'),
        keccak256(hexField(message, 'initCode', HEX)),
        keccak256(hexField(message, 'callData', HEX)),
        hexField(message, 'accountGasLimits', BYTES32),
        uintField(message, 'preVerificationGas'),
        hexField(message, 'gasFees', BYTES32),
        keccak256(hexField(message, 'paymasterAndData', HEX)),
      ],
    ),
  )
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
      [inner, addressField(message.entryPoint, 'message.entryPoint'), chainId],
    ),
  )
}

/**
 * Refuse (throw `HavenUserOpBindingError`) unless this `PackedUserOperation`
 * typed data is the operation `payloadHash` names, in the HybridDeleGator
 * domain of its own sender, against the v0.7 EntryPoint. Returns the
 * recomputed hash.
 */
export function assertUserOpTypedDataBinding(typedData: unknown, payloadHash: string): Hex {
  if (typeof payloadHash !== 'string' || !BYTES32.test(payloadHash)) refuse('payload_hash is not a 32-byte hex string')
  if (!isPackedUserOperationTypedData(typedData)) refuse('primaryType is not PackedUserOperation')
  const td = typedData as {
    domain?: Record<string, unknown>
    types?: Record<string, unknown>
    message?: Record<string, unknown>
  }
  const domain = td.domain ?? {}
  const message = td.message ?? {}
  if (domain.name !== HYBRID_DELEGATOR_DOMAIN_NAME) refuse('domain.name is not HybridDeleGator')
  if (domain.version !== HYBRID_DELEGATOR_DOMAIN_VERSION) refuse('domain.version is not 1')
  if (addressField(domain.verifyingContract, 'domain.verifyingContract') !== addressField(message.sender, 'message.sender')) {
    refuse('domain.verifyingContract is not message.sender')
  }
  if (addressField(message.entryPoint, 'message.entryPoint') !== getAddress(ENTRY_POINT_V07)) {
    refuse('message.entryPoint is not the v0.7 EntryPoint')
  }
  const fields = (td.types ?? {}).PackedUserOperation
  if (
    !Array.isArray(fields) ||
    fields.length !== PACKED_USER_OPERATION_FIELDS.length ||
    fields.some(
      (f, i) =>
        !f ||
        (f as { name?: unknown }).name !== PACKED_USER_OPERATION_FIELDS[i].name ||
        (f as { type?: unknown }).type !== PACKED_USER_OPERATION_FIELDS[i].type,
    )
  ) {
    refuse('types.PackedUserOperation is not the HybridDeleGator field list')
  }
  const extraTypes = Object.keys(td.types ?? {}).filter((k) => k !== 'PackedUserOperation' && k !== 'EIP712Domain')
  if (extraTypes.length > 0) refuse(`unexpected types: ${extraTypes.join(', ')}`)
  const recomputed = packedUserOperationHash(typedData)
  if (recomputed.toLowerCase() !== payloadHash.toLowerCase()) refuse('recomputed UserOperation hash differs')
  return recomputed
}
