/**
 * Headless WebAuthn authenticator for pilot scripts (#884/#891, epic #836).
 *
 * Emulates navigator.credentials.get with a local P256 key: builds
 * authenticatorData + clientDataJSON and DER-signs their digest, exactly as a
 * platform authenticator would. viem's toWebAuthnAccount accepts the getFn
 * override, so the entire passkey story is scriptable — no browser, no device.
 *
 * TESTNET PILOT USE ONLY: keys are throwaway, generated per run.
 */
import { createHash } from 'node:crypto'
import { createPublicClient, toHex, zeroAddress, type Hex } from 'viem'
import { toWebAuthnAccount } from 'viem/account-abstraction'
import { p256 } from '@noble/curves/p256'
import {
  Implementation,
  toMetaMaskSmartAccount,
  type MetaMaskSmartAccount,
} from '@metamask/smart-accounts-kit'

export interface LocalPasskey {
  keyId: Hex
  x: bigint
  y: bigint
  credential: { id: string; publicKey: Hex }
  getFn: (options?: CredentialRequestOptions) => Promise<Credential | null>
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

export function makeLocalPasskey(label: string): LocalPasskey {
  const priv = p256.utils.randomPrivateKey()
  const pubPoint = p256.ProjectivePoint.fromPrivateKey(priv)
  const x = pubPoint.x
  const y = pubPoint.y
  const publicKey = ('0x04' +
    x.toString(16).padStart(64, '0') +
    y.toString(16).padStart(64, '0')) as Hex
  const idBytes = sha256(new TextEncoder().encode(`haven-pilot-${label}-${toHex(priv).slice(2, 10)}`))
  const id = Buffer.from(idBytes).toString('base64url')
  const rpIdHash = sha256(new TextEncoder().encode('haven.pilot.local'))

  const getFn = async (options?: CredentialRequestOptions): Promise<Credential | null> => {
    const challenge = new Uint8Array(
      (options?.publicKey?.challenge as ArrayBuffer) ?? new ArrayBuffer(0),
    )
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: Buffer.from(challenge).toString('base64url'),
        origin: 'https://haven.pilot.local',
        crossOrigin: false,
      }),
    )
    const authenticatorData = new Uint8Array(37)
    authenticatorData.set(rpIdHash, 0)
    authenticatorData[32] = 0x05 // user present + verified
    const digest = sha256(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]))
    const signature = p256.sign(digest, priv).toDERRawBytes()
    return {
      id,
      rawId: idBytes.buffer,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        authenticatorData: authenticatorData.buffer,
        clientDataJSON: clientDataJSON.buffer,
        signature: signature.buffer,
        userHandle: null,
      },
      getClientExtensionResults: () => ({}),
    } as unknown as Credential
  }

  return { keyId: toHex(idBytes), x, y, credential: { id, publicKey }, getFn }
}

/**
 * The kit account for a passkey set, signing with ONE of them. deployParams
 * must be EXACTLY the set the address was derived from at provisioning.
 */
export async function buildPasskeyAccount(
  publicClient: ReturnType<typeof createPublicClient>,
  deploySet: LocalPasskey[],
  signWith: LocalPasskey,
): Promise<MetaMaskSmartAccount> {
  const webAuthnAccount = toWebAuthnAccount({
    credential: signWith.credential,
    getFn: signWith.getFn,
    rpId: 'haven.pilot.local',
  })
  return toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    deployParams: [
      zeroAddress,
      deploySet.map((p) => p.keyId),
      deploySet.map((p) => p.x),
      deploySet.map((p) => p.y),
    ],
    deploySalt: '0x',
    signer: { webAuthnAccount, keyId: signWith.keyId },
  })
}
