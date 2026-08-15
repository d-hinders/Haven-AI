import { ethers } from 'ethers'
import { HavenSigningError } from './types.js'

/**
 * Sign a hash using raw ECDSA (no Ethereum message prefix).
 *
 * This matches what Safe's AllowanceModule `checkSignature` expects —
 * a direct ecrecover over the hash, NOT the "\x19Ethereum Signed Message" variant.
 *
 * Uses ethers.SigningKey.sign() instead of wallet.signMessage() to avoid the prefix.
 */
export function signHash(privateKey: string, hash: string): string {
  try {
    const signingKey = new ethers.SigningKey(privateKey)
    const sig = signingKey.sign(hash)
    return sig.serialized // 0x + r(32) + s(32) + v(1)
  } catch (err) {
    throw new HavenSigningError(
      `Failed to sign hash: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Sign a delegation-rail payment (#829).
 *
 * The delegate SMART ACCOUNT validates an EIP-712 signature over the packed
 * UserOperation — signing the bare 4337 hash would be rejected on-chain. The
 * backend sends the exact typed data in `sign_data.typed_data`; we sign it
 * verbatim and never reconstruct it (a second source of truth could drift
 * from the account's own rules).
 */
export interface Eip712TypedData {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

/**
 * Sign backend-supplied EIP-712 typed data VERBATIM.
 *
 * One implementation for every typed-data scheme on purpose: the
 * `EIP712Domain` removal below is the kind of subtlety that rots when it is
 * copied. Today the backend's payloads do NOT carry `EIP712Domain` in `types`
 * (checked against a real `buildSettlementDelegation` payload — see
 * `__fixtures__/settlement-delegation-payload.json`), so the delete is
 * defensive rather than load-bearing; ethers derives the domain itself and
 * throws if it also finds it in `types`.
 *
 * `label` only shapes the error message. Nothing about the signature depends
 * on which caller asked.
 *
 * A consequence worth stating before someone refactors this (#1452 review):
 * because the two wrappers below differ ONLY in that label, calling the wrong
 * one for a given scheme produces a byte-identical signature and no test can
 * see it. That is safe today — both sign backend-supplied typed data verbatim
 * — but it stops being safe the moment either wrapper does anything the other
 * does not. If you add per-scheme behaviour, split the implementations rather
 * than branching inside this one.
 */
async function signTypedDataVerbatim(
  privateKey: string,
  typedData: Eip712TypedData,
  label: string,
): Promise<string> {
  try {
    const wallet = new ethers.Wallet(privateKey)
    const types = { ...typedData.types }
    delete (types as Record<string, unknown>).EIP712Domain
    return await wallet.signTypedData(
      typedData.domain as never,
      types as never,
      typedData.message as never,
    )
  } catch (err) {
    throw new HavenSigningError(
      `Failed to sign ${label}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function signUserOpTypedDataForDelegation(
  privateKey: string,
  typedData: Eip712TypedData,
): Promise<string> {
  return signTypedDataVerbatim(privateKey, typedData, 'delegation UserOperation')
}

/**
 * Sign the erc7710 x402 SETTLEMENT CHILD delegation (#1452, epic #1450).
 *
 * A different object from the UserOperation above, and a materially different
 * authority: this signature is what lets a merchant's facilitator redeem the
 * `[child, budget]` chain and pull the exact amount from the treasury. The
 * child's caveats — exact amount, payee pin, expiry, redeemer pin — are what
 * bound it, and they are enforced ON-CHAIN. Signing it verbatim is therefore
 * not a style preference: a reconstructed payload that differed from what the
 * DelegationManager will hash is the #829 failure, and it fails at redemption
 * rather than here.
 */
export async function signSettlementDelegationTypedData(
  privateKey: string,
  typedData: Eip712TypedData,
): Promise<string> {
  return signTypedDataVerbatim(privateKey, typedData, 'x402 settlement delegation')
}

/**
 * Derive the Ethereum address from a private key.
 */
export function addressFromKey(privateKey: string): string {
  try {
    return new ethers.Wallet(privateKey).address
  } catch (err) {
    throw new HavenSigningError(
      `Invalid private key: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Verify that a signature over a hash recovers to the expected address.
 */
export function verifySignature(hash: string, signature: string, expectedAddress: string): boolean {
  try {
    const recovered = ethers.recoverAddress(hash, signature)
    return recovered.toLowerCase() === expectedAddress.toLowerCase()
  } catch {
    return false
  }
}
