import { api } from '@/lib/api'
import { base64UrlEncode, createPasskey } from '@/lib/passkey'
import { displayName } from '@/lib/user'
import type { User } from '@/context/AuthContext'

/**
 * Provision a brand-new passkey and enrol it as a Safe-compatible signer,
 * returning its on-chain signer address. The address can then be added as a
 * Safe owner via the normal approver-change flow — adding a passkey approver
 * is the same `addOwnerWithThreshold` call as an EOA, just with the passkey
 * signer's address.
 *
 * Mirrors the onboarding enrolment path (PasskeyEnrollFlow): WebAuthn create →
 * `POST /passkeys` (enrol) → signer address. No Safe is deployed here; the
 * passkey signer contract is materialised on first use by the relay path.
 */
export async function provisionPasskeyApprover(args: {
  user: User
  chainId: number
}): Promise<{ signerAddress: string }> {
  const created = await createPasskey({
    userId: randomUserId(),
    userName: args.user.email,
    userDisplayName: displayName(args.user),
  })

  const enrolled = await api.enrollPasskey({
    credential_id: created.credentialId,
    public_key_x: created.publicKey.x,
    public_key_y: created.publicKey.y,
    chain_id: args.chainId,
    raw_attestation_object: base64UrlEncode(created.rawAttestationObject),
  })

  return { signerAddress: enrolled.signer_address }
}

function randomUserId(): Uint8Array {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytes
}
