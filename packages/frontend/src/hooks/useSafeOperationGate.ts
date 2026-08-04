'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import {
  getStoredHybridSigners,
  getStoredPasskeySigner,
  hybridPasskeyOnDevice,
  hybridSignersStorageKey,
  passkeyStorageKey,
} from '@/lib/signer'

export type SafeOperationGate =
  | { kind: 'ready' }
  | { kind: 'no_signer' }
  | { kind: 'passkey_on_other_device' }

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  window.addEventListener('storage', onStoreChange)
  return () => window.removeEventListener('storage', onStoreChange)
}

function readStoredPasskeyValue(args: {
  safeAddress?: Address
  chainId?: number
}): string | null {
  if (typeof window === 'undefined' || !args.safeAddress || args.chainId === undefined) {
    return null
  }

  return window.localStorage.getItem(passkeyStorageKey(args.safeAddress, args.chainId))
}

function readStoredHybridValue(args: {
  safeAddress?: Address
  chainId?: number
}): string | null {
  if (typeof window === 'undefined' || !args.safeAddress || args.chainId === undefined) {
    return null
  }

  return window.localStorage.getItem(hybridSignersStorageKey(args.safeAddress, args.chainId))
}

export function useSafeOperationGate(args: {
  safeAddress?: Address
  chainId?: number
}): SafeOperationGate {
  const { passkeys, user } = useAuth()
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient({ chainId: args.chainId })

  const storedPasskeyValue = useSyncExternalStore(
    subscribe,
    () => readStoredPasskeyValue(args),
    () => null,
  )

  const storedPasskeySigner = useMemo(
    () => getStoredPasskeySigner(args),
    [args.chainId, args.safeAddress, storedPasskeyValue],
  )

  // #1079: rail awareness. A Hybrid DeleGator account's signer set lives in
  // the hydrated hybrid-signers store, not in the Safe passkey store — and a
  // globally-connected EOA says nothing about who may sign for it.
  const storedHybridValue = useSyncExternalStore(
    subscribe,
    () => readStoredHybridValue(args),
    () => null,
  )

  const hybridSigners = useMemo(
    () => getStoredHybridSigners(args),
    [args.chainId, args.safeAddress, storedHybridValue],
  )

  const isHybridAccount = useMemo(() => {
    const safeAddress = args.safeAddress?.toLowerCase()
    if (!safeAddress || args.chainId === undefined) return false
    return (user?.safes ?? []).some(
      (safe) =>
        safe.account_type === 'delegator_hybrid' &&
        safe.chain_id === args.chainId &&
        safe.safe_address.toLowerCase() === safeAddress,
    )
  }, [args.chainId, args.safeAddress, user?.safes])

  const backendPasskey = useMemo(() => {
    const safeAddress = args.safeAddress?.toLowerCase()
    if (!safeAddress || args.chainId === undefined) {
      return null
    }

    return (
      passkeys.find(
        (passkey) =>
          passkey.chain_id === args.chainId &&
          passkey.safe_address?.toLowerCase() === safeAddress,
      ) ?? null
    )
  }, [args.chainId, args.safeAddress, passkeys])

  if (isHybridAccount) {
    if (hybridSigners && hybridSigners.passkeys.length > 0) {
      return hybridPasskeyOnDevice(hybridSigners)
        ? { kind: 'ready' }
        : { kind: 'passkey_on_other_device' }
    }
    // No signer set known (hydration failed or none enrolled). Deliberately
    // NOT falling through to the connected-EOA branch: a random connected
    // wallet cannot sign for a Hybrid account.
    return { kind: 'no_signer' }
  }

  if (backendPasskey && !storedPasskeySigner) {
    return { kind: 'passkey_on_other_device' }
  }

  if (storedPasskeySigner) {
    return { kind: 'ready' }
  }

  if (address && walletClient) {
    return { kind: 'ready' }
  }

  return { kind: 'no_signer' }
}
