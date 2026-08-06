/**
 * Shared signing dispatch for Hybrid ACCOUNT ops (#901 absorption — second
 * occurrence: signer changes (#888/#1081) and owner send (#1083) both sign a
 * backend-prepared op with whichever signer this device holds).
 *
 * The server declares the scheme (`signature_scheme`, chosen by the device
 * via the #1086 contract); the client obeys VERBATIM: WebAuthn signs the
 * UserOperation through the kit, an EOA signs the exact EIP-712 typed data.
 * Haven never signs.
 */

import type { AccountSigners } from '@/lib/delegationPasskeySigner'
import type { HavenUserSigner } from '@/lib/signer'

export interface PreparedAccountOp {
  signature_scheme: 'eip712_userop' | 'webauthn_userop'
  signing_payload?: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  }
  user_op_hash?: string
  user_operation: Record<string, unknown>
}

export async function signPreparedAccountOp(
  prep: PreparedAccountOp,
  signers: AccountSigners | null,
  signer: HavenUserSigner | null,
): Promise<string> {
  if (prep.signature_scheme === 'webauthn_userop') {
    if (!signers) throw new Error('signers not loaded')
    const { signUserOpWithPasskey } = await import('@/lib/delegationPasskeySigner')
    return signUserOpWithPasskey(signers, prep.user_operation)
  }
  if (!signer || signer.type !== 'eoa' || !prep.signing_payload) {
    throw new Error('Connect your account owner wallet')
  }
  const types = { ...prep.signing_payload.types }
  delete (types as Record<string, unknown>).EIP712Domain
  return signer.walletClient.signTypedData({
    account: signer.address,
    domain: prep.signing_payload.domain,
    types,
    primaryType: prep.signing_payload.primaryType,
    message: prep.signing_payload.message,
  } as never)
}
