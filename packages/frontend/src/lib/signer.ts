'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { Address, WalletClient } from 'viem'

export const PASSKEY_SCHEMA_VERSION = 1

export type HavenUserSigner = EoaSigner | PasskeySigner

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

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
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
 *   1. If localStorage has passkey signer metadata for the safeAddress + chainId, return it.
 *   2. Otherwise, if Wagmi has a connected EOA, return that signer.
 *   3. Otherwise return null.
 */
export function useActiveSigner(args: {
  safeAddress?: Address
  chainId?: number
}): HavenUserSigner | null {
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient()

  const passkeySignerValue = useSyncExternalStore(
    subscribe,
    () => getStoredPasskeySignerValue(args),
    () => null,
  )
  const passkeySigner = useMemo(
    () => getStoredPasskeySigner(args),
    [args.chainId, args.safeAddress, passkeySignerValue],
  )

  if (passkeySigner) {
    return passkeySigner
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
