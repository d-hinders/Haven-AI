'use client'

import { useAccount, useWalletClient } from 'wagmi'
import type { Address, WalletClient } from 'viem'

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
  publicKey: { x: `0x${string}`; y: `0x${string}` }
  chainId: number
}

/**
 * PR #4 writes passkey signer metadata in this exact shape under
 * `haven_passkey_${safeAddress.toLowerCase()}_${chainId}`.
 */
interface StoredPasskeyMetadata {
  address: string
  credentialId: string
  publicKey: {
    x: string
    y: string
  }
  chainId?: number
}

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/

export function getStoredPasskeySigner(args: {
  safeAddress?: Address
  chainId?: number
}): PasskeySigner | null {
  if (typeof window === 'undefined' || !args.safeAddress || args.chainId === undefined) {
    return null
  }

  const key = `haven_passkey_${args.safeAddress.toLowerCase()}_${args.chainId}`
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as StoredPasskeyMetadata
    const { address, credentialId } = parsed
    const x = parsed.publicKey?.x
    const y = parsed.publicKey?.y

    if (
      !address ||
      !credentialId ||
      !x ||
      !y ||
      !ETH_ADDRESS_RE.test(address) ||
      !HEX_32_RE.test(x) ||
      !HEX_32_RE.test(y)
    ) {
      return null
    }

    return {
      type: 'passkey',
      address: address as Address,
      credentialId,
      publicKey: {
        x: x as `0x${string}`,
        y: y as `0x${string}`,
      },
      chainId: args.chainId,
    }
  } catch {
    return null
  }
}

/**
 * Read the active human signer for the dashboard's currently-selected Safe.
 *
 * Resolution order:
 *   1. If localStorage has passkey signer metadata for the current safeAddress + chainId,
 *      return a PasskeySigner.
 *   2. If Wagmi has a connected EOA, return an EoaSigner.
 *   3. Otherwise return null.
 *
 * Note: this reads localStorage during render and does not subscribe to storage updates yet.
 * PR #4's enrollment UI will need to add an external-store subscription so same-tab writes
 * trigger a rerender immediately.
 */
export function useActiveSigner(args: {
  safeAddress?: Address
  chainId?: number
}): HavenUserSigner | null {
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient()

  const passkeySigner = getStoredPasskeySigner(args)
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
