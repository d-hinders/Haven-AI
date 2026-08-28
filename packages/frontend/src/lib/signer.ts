'use client'

import { ETH_ADDRESS_RE } from '@haven_ai/core'
import { useMemo, useSyncExternalStore } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { Address, WalletClient } from 'viem'

export const PASSKEY_SCHEMA_VERSION = 1

export type HavenUserSigner = EoaSigner | PasskeySigner | DelegatorPasskeySigner

/**
 * A Hybrid DeleGator account's signer set, resolvable on this device (#1079).
 *
 * EXPLICITLY a third variant rather than a widened PasskeySigner: a Hybrid
 * passkey cannot sign a Safe transaction, and the compiler must force every
 * call site to decide rather than fail late on a money path. Signing on this
 * rail stays in `delegationPasskeySigner` — this variant makes the GATES
 * honest; it never routes through `signSafeTx`.
 */
export interface DelegatorPasskeySigner {
  type: 'delegator_passkey'
  accountAddress: Address
  chainId: number
  signers: HybridAccountSigners
}

/**
 * Mirror of GET /accounts/hybrid/:address/signers (and the agent-scoped twin).
 * `created_at` (#1679) is optional here — this shape is also parsed back from
 * localStorage, where blobs stored before the field existed have none.
 */
export interface HybridAccountSigners {
  account_address: string
  chain_id: number
  owner_address: string | null
  passkeys: Array<{ key_id: string; x: `0x${string}`; y: `0x${string}`; created_at?: string | null }>
}

export interface EoaSigner {
  type: 'eoa'
  address: Address
  walletClient: WalletClient
}

export interface PasskeySigner {
  type: 'passkey'
  address: Address
  credentialId: string
  publicKey?: { x: `0x${string}`; y: `0x${string}` }
  chainId: number
}

export interface StoredPasskeySigner {
  schemaVersion: 1
  address: Address
  credentialId: string
  publicKey?: { x: `0x${string}`; y: `0x${string}` }
  chainId: number
  safeAddress: Address
  createdAt: number
}

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/

export function passkeyStorageKey(safeAddress: Address, chainId: number): string {
  return `haven_passkey_${safeAddress.toLowerCase()}_${chainId}`
}

function passkeyDeviceKey(credentialId: string): string {
  return `haven_passkey_device_${credentialId}`
}

function dispatchStorageChange(key: string, oldValue: string | null, newValue: string | null): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue }))
}

export function rememberPasskeyCredentialOnDevice(credentialId: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(passkeyDeviceKey(credentialId), '1')
}

export function hasPasskeyCredentialOnDevice(credentialId: string): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(passkeyDeviceKey(credentialId)) === '1'
}

/**
 * hex `key_id` (hybrid_account_passkeys storage form, #885) → base64url
 * credential id (what navigator.credentials and the on-device markers use).
 * The one identifier that bridges the two disjoint credential tables — the
 * same conversion `delegationPasskeySigner` performs before signing.
 */
export function credentialIdFromKeyId(keyId: string): string {
  const clean = keyId.startsWith('0x') ? keyId.slice(2) : keyId
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function hybridSignersStorageKey(accountAddress: string, chainId: number): string {
  return `haven_hybrid_signers_${accountAddress.toLowerCase()}_${chainId}`
}

export function setStoredHybridSigners(signers: HybridAccountSigners): void {
  if (typeof window === 'undefined') return
  const key = hybridSignersStorageKey(signers.account_address, signers.chain_id)
  const newValue = JSON.stringify(signers)
  const oldValue = window.localStorage.getItem(key)
  window.localStorage.setItem(key, newValue)
  dispatchStorageChange(key, oldValue, newValue)
}

export function getStoredHybridSigners(args: {
  safeAddress?: Address
  chainId?: number
}): HybridAccountSigners | null {
  if (typeof window === 'undefined' || !args.safeAddress || args.chainId === undefined) return null
  const raw = window.localStorage.getItem(hybridSignersStorageKey(args.safeAddress, args.chainId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as HybridAccountSigners
    return Array.isArray(parsed?.passkeys) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The device-marker rule, in ONE place (#1933).
 *
 * Structural in the passkey element so the spec-derived wire type
 * (`ApiSchema<'HybridAccountSigners'>`, whose `x`/`y` are plain `string`) and
 * this module's stored shape both satisfy it — a second copy of this rule was
 * exactly the defect #1933 removed, and a nominal parameter type would have
 * forced one back.
 */
export interface HybridPasskeyLike {
  key_id: string
}

/** A passkey from this signer set whose credential is enrolled on THIS device. */
export function hybridPasskeyOnDevice<P extends HybridPasskeyLike>(signers: {
  passkeys: readonly P[]
}): P | null {
  for (const passkey of signers.passkeys) {
    if (hasPasskeyCredentialOnDevice(credentialIdFromKeyId(passkey.key_id))) return passkey
  }
  return null
}

/**
 * WHICH CREDENTIAL SIGNS. The single selector both signing paths use (#1933).
 *
 * Device marker first (#1079): if this device holds the BACKUP rather than the
 * first-enrolled key, `passkeys[0]` would build the wrong `allowCredentials`
 * and signing fails — defeating the recovery flow.
 *
 * **The `passkeys[0]` fallback is LOAD-BEARING, not vestigial.** When no
 * marker matches (markers cleared, a fresh browser profile, storage wiped) the
 * ceremony can still succeed, because the authenticator does its own
 * credential lookup and the user picks. Deleting the fallback turns a
 * recoverable "no marker on this device" state into a hard failure for every
 * such user. The device-selection rule in
 * `docs/security/delegation-rail-security-model.md` is stated WITH this
 * fallback for that reason, and
 * `signer.test.ts` → "keeps passkeys[0] as the fallback when no device marker
 * is present (#1933 — load-bearing, do not delete)" fails if it is removed.
 *
 * Returns `undefined` only for an empty signer set; callers guard that
 * separately with a message that says what is actually wrong.
 */
export function hybridPasskeyToSignWith<P extends HybridPasskeyLike>(signers: {
  passkeys: readonly P[]
}): P | undefined {
  return hybridPasskeyOnDevice(signers) ?? signers.passkeys[0]
}

/**
 * Narrow to the signers that can produce a SAFE transaction signature (#1079).
 * A `delegator_passkey` signs Hybrid-account operations via
 * `delegationPasskeySigner` and can never sign a Safe tx — every Safe-shaped
 * call site names that exclusion through this guard instead of assuming the
 * union stops at two variants.
 */
export type SafeCapableSigner = EoaSigner | PasskeySigner

export function isSafeCapableSigner(
  signer: HavenUserSigner | null,
): signer is EoaSigner | PasskeySigner {
  return signer !== null && signer.type !== 'delegator_passkey'
}

export function setStoredPasskeySigner(value: StoredPasskeySigner): void {
  if (typeof window === 'undefined') return

  const normalized: StoredPasskeySigner = {
    ...value,
    safeAddress: value.safeAddress.toLowerCase() as Address,
  }
  const key = passkeyStorageKey(normalized.safeAddress, normalized.chainId)
  const oldValue = window.localStorage.getItem(key)
  const newValue = JSON.stringify(normalized)

  window.localStorage.setItem(key, newValue)
  dispatchStorageChange(key, oldValue, newValue)
}

export function clearStoredPasskeySigner(args: {
  safeAddress: Address
  chainId: number
}): void {
  if (typeof window === 'undefined') return

  const key = passkeyStorageKey(args.safeAddress, args.chainId)
  const oldValue = window.localStorage.getItem(key)

  window.localStorage.removeItem(key)
  dispatchStorageChange(key, oldValue, null)
}

export function getStoredPasskeySigner(args: {
  safeAddress?: Address
  chainId?: number
}): PasskeySigner | null {
  const { safeAddress, chainId } = args
  if (!safeAddress || chainId === undefined) {
    return null
  }

  const raw = getStoredPasskeySignerValue(args)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredPasskeySigner>
    const x = parsed.publicKey?.x
    const y = parsed.publicKey?.y

    if (
      parsed.schemaVersion !== PASSKEY_SCHEMA_VERSION ||
      !parsed.address ||
      !parsed.credentialId ||
      !parsed.safeAddress ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.chainId !== 'number' ||
      !ETH_ADDRESS_RE.test(parsed.address) ||
      !ETH_ADDRESS_RE.test(parsed.safeAddress) ||
      parsed.chainId !== chainId ||
      parsed.safeAddress.toLowerCase() !== safeAddress.toLowerCase() ||
      ((x !== undefined || y !== undefined) && (!x || !y || !HEX_32_RE.test(x) || !HEX_32_RE.test(y)))
    ) {
      return null
    }

    return {
      type: 'passkey',
      address: parsed.address as Address,
      credentialId: parsed.credentialId,
      publicKey:
        x && y
          ? {
              x: x as `0x${string}`,
              y: y as `0x${string}`,
            }
          : undefined,
      chainId: parsed.chainId,
    }
  } catch {
    return null
  }
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  window.addEventListener('storage', onChange)
  return () => window.removeEventListener('storage', onChange)
}

function getStoredPasskeySignerValue(args: {
  safeAddress?: Address
  chainId?: number
}): string | null {
  if (typeof window === 'undefined' || !args.safeAddress || args.chainId === undefined) {
    return null
  }

  return window.localStorage.getItem(passkeyStorageKey(args.safeAddress, args.chainId))
}

/**
 * Read the active human signer for a specific Safe.
 *
 * Resolution order:
 *   1. If localStorage has Safe passkey signer metadata for the safeAddress + chainId, return it.
 *   2. Otherwise, if a hydrated Hybrid signer set exists for the account,
 *      resolve WITHIN that set with `pickSigningPath`'s precedence
 *      (#1969/#2068): marker-matched passkey → connected EOA when the
 *      connected wallet IS the set's named owner → any passkey → null.
 *      A hydrated set never falls through to step 3 — a wallet that is not
 *      in the set is not a signer for this account.
 *   3. Otherwise, if Wagmi has a connected EOA, return that signer.
 *   4. Otherwise return null.
 */
export function useActiveSigner(args: {
  safeAddress?: Address
  chainId?: number
}): HavenUserSigner | null {
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient({ chainId: args.chainId })

  const passkeySignerValue = useSyncExternalStore(
    subscribe,
    // Both stores in one snapshot so a hybrid-signers hydration re-renders
    // consumers exactly like a Safe-passkey enrolment does (#1079).
    () => `${getStoredPasskeySignerValue(args)}|${args.safeAddress && args.chainId !== undefined ? window.localStorage.getItem(hybridSignersStorageKey(args.safeAddress, args.chainId)) : null}`,
    () => 'null|null',
  )
  const passkeySigner = useMemo(
    () => getStoredPasskeySigner(args),
    [args.chainId, args.safeAddress, passkeySignerValue],
  )

  if (passkeySigner) {
    return passkeySigner
  }

  // #1079: a Hybrid DeleGator account resolves its OWN signer set — before the
  // EOA branch on purpose, because the account's own signer beats whatever
  // wallet happens to be globally connected.
  //
  // #1969 (owner decision 2026-08-26): a NON-EMPTY hydrated set resolves even
  // when no device marker matches. The set is the account's on-chain-enrolled
  // signers from the owner-scoped read, so every listed passkey can sign for
  // THIS account by construction; the only unknown is device availability,
  // which only the WebAuthn ceremony can answer (cross-device transport is a
  // real signing path — the same shipped posture as `pickSigningPath` and
  // §6 of docs/security/delegation-rail-security-model.md, #1097). Which
  // credential would sign is `hybridPasskeyToSignWith` — the selector the
  // signing path uses — and the marker-less case is DISCLOSED in the wallet
  // menu (#1952) rather than silently offered.
  //
  // The one refusal kept: `pickSigningPath`'s exact precedence, mirrored so
  // display and signing cannot disagree — marker-matched passkey → connected
  // EOA (only when the connected wallet IS the set's named owner, #2068) →
  // any passkey. Without the mirror, a MIXED account (EOA owner + passkeys,
  // marker-less, owner wallet connected) would flip from signing with the
  // connected EOA to a cross-device passkey ceremony, because the
  // budget/send/re-key hooks feed the resolved signer into `pickSigningPath`.
  // Pinned by signer.test.ts › "mixed account: a connected EOA still
  // wins when no device marker matches (#1969 precedence mirror)".
  //
  // #2068: "an EOA is connected" is NOT the same as "the owner is connected".
  // The EOA rung requires the connected address to EQUAL the set's
  // `owner_address` — an unrelated wallet would be offered a signature the
  // account rejects at verification time, and a signer offered but failing
  // at signature time is worse than absent. On a mismatch the resolution
  // stays inside the set: any passkey if one exists, otherwise null — never
  // the EOA fallthrough below, which is for accounts WITHOUT a hydrated set
  // (legacy Safes, pre-hydration renders).
  const hybridSigners = getStoredHybridSigners(args)
  if (hybridSigners && args.safeAddress && args.chainId !== undefined) {
    const hasPasskeys = hybridSigners.passkeys.length > 0
    const markerMatched = hasPasskeys && hybridPasskeyOnDevice(hybridSigners) !== null
    const connectedIsOwner = Boolean(
      hybridSigners.owner_address &&
        address &&
        walletClient &&
        address.toLowerCase() === hybridSigners.owner_address.toLowerCase(),
    )
    if (hasPasskeys && (markerMatched || !connectedIsOwner)) {
      return {
        type: 'delegator_passkey',
        accountAddress: args.safeAddress,
        chainId: args.chainId,
        signers: hybridSigners,
      }
    }
    if (!connectedIsOwner) {
      // Hydrated set, no passkey, connected wallet is not the named owner
      // (or nothing is connected): the account has no reachable signer from
      // here. Refuse rather than offer a wallet the account will reject.
      return null
    }
    // No marker (or no passkeys) and the OWNER wallet is connected: fall
    // through to the EOA branch below — the same answer `pickSigningPath`
    // gives.
  }

  if (address && walletClient) {
    return {
      type: 'eoa',
      address,
      walletClient,
    }
  }

  return null
}
