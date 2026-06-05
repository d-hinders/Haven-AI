'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import {
  getStoredPasskeySigner,
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

export function useSafeOperationGate(args: {
  safeAddress?: Address
  chainId?: number
}): SafeOperationGate {
  const { passkeys } = useAuth()
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
