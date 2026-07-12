'use client'

/**
 * Passkey (WebAuthn) signing for delegation-rail accounts (#887, epic #836).
 *
 * The account's WebAuthn signer signs through the SAME kit code path the #884
 * spike proved live: `toMetaMaskSmartAccount` with `{ webAuthnAccount, keyId }`
 * wraps the assertion into exactly the encoding the Hybrid validates —
 * delegations via EIP-1271 → P256, account ops in validateUserOp. No bespoke
 * signature assembly here; the browser's native `navigator.credentials.get`
 * is the authenticator (viem's default getFn).
 *
 * The kit deployParams MUST match what provisioning derived the address from
 * (#885's stored signer set) — a mismatch means signing as a different
 * account, which the callers guard by comparing addresses.
 *
 * Heavy deps (the kit) load lazily so this stays out of the main bundle.
 */

import { createPublicClient, http, zeroAddress, type Address, type Hex } from 'viem'
import { base, baseSepolia, gnosis } from 'viem/chains'
import { base64UrlEncode } from './passkey'

export interface AccountSigners {
  account_address: string
  chain_id: number
  owner_address: string | null
  passkeys: Array<{ key_id: string; x: string; y: string }>
}

/** Delegation fields as the backend's signing payload carries them. */
export interface DelegationMessage {
  delegate: string
  delegator: string
  authority: string
  caveats: Array<{ enforcer: string; terms: string; args: string }>
  salt: string
}

const VIEM_CHAINS = { 8453: base, 84532: baseSepolia, 100: gnosis } as const
const RPC_URLS: Record<number, string> = {
  8453: 'https://mainnet.base.org',
  84532: 'https://sepolia.base.org',
  100: 'https://rpc.gnosischain.com',
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** `0x`-hex salt for the kit regardless of how JSON transported it. */
function normalizeSalt(salt: string): Hex {
  if (salt.startsWith('0x')) return salt as Hex
  return `0x${BigInt(salt).toString(16)}` as Hex
}

async function buildAccount(signers: AccountSigners) {
  const chain = VIEM_CHAINS[signers.chain_id as keyof typeof VIEM_CHAINS]
  const rpc = RPC_URLS[signers.chain_id]
  if (!chain || !rpc) throw new Error(`Unsupported chain ${signers.chain_id}`)
  if (signers.passkeys.length === 0) throw new Error('Account has no passkey to sign with')

  const [{ Implementation, toMetaMaskSmartAccount }, { toWebAuthnAccount }] = await Promise.all([
    import('@metamask/smart-accounts-kit'),
    import('viem/account-abstraction'),
  ])

  // key_id is the hex of the raw WebAuthn credential id (#885 storage);
  // navigator wants the base64url form for allowCredentials lookup.
  const signWith = signers.passkeys[0]
  const credential = {
    id: base64UrlEncode(hexToBytes(signWith.key_id)),
    publicKey: `0x04${signWith.x.slice(2).padStart(64, '0')}${signWith.y.slice(2).padStart(64, '0')}` as Hex,
  }
  const webAuthnAccount = toWebAuthnAccount({ credential })

  const client = createPublicClient({ chain, transport: http(rpc) })
  const account = await toMetaMaskSmartAccount({
    client: client as never,
    implementation: Implementation.Hybrid,
    deployParams: [
      (signers.owner_address ?? zeroAddress) as Address,
      signers.passkeys.map((p) => p.key_id),
      signers.passkeys.map((p) => BigInt(p.x)),
      signers.passkeys.map((p) => BigInt(p.y)),
    ],
    deploySalt: '0x',
    signer: { webAuthnAccount, keyId: signWith.key_id as Hex },
  })

  if (account.address.toLowerCase() !== signers.account_address.toLowerCase()) {
    // Signing as a different account would produce signatures the chain
    // rejects — refuse loudly instead.
    throw new Error('Account derivation mismatch — the stored signer set does not match this account')
  }
  return account
}

/** ONE passkey ceremony: sign a budget delegation (grant, #828 build payload). */
export async function signDelegationWithPasskey(
  signers: AccountSigners,
  message: DelegationMessage,
): Promise<Hex> {
  const account = await buildAccount(signers)
  return account.signDelegation({
    delegation: {
      delegate: message.delegate as Address,
      delegator: message.delegator as Address,
      authority: message.authority as Hex,
      caveats: message.caveats.map((c) => ({
        enforcer: c.enforcer as Address,
        terms: c.terms as Hex,
        args: c.args as Hex,
      })),
      salt: normalizeSalt(message.salt),
    },
  })
}

/** ONE passkey ceremony: sign a prepared treasury UserOperation (revoke). */
export async function signUserOpWithPasskey(
  signers: AccountSigners,
  userOperation: Record<string, unknown>,
): Promise<Hex> {
  const account = await buildAccount(signers)
  // The route serializes bigints as "<n>n" strings — revive before signing.
  const revived = JSON.parse(JSON.stringify(userOperation), (_k, v) =>
    typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  )
  return account.signUserOperation(revived)
}
