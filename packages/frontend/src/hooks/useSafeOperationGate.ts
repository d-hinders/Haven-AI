'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import {
  getStoredHybridSigners,
  getStoredPasskeySigner,
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
      // #1969 (owner decision 2026-08-26): a non-empty hydrated set is READY,
      // marker or not. The set is the account's on-chain-enrolled signers, and
      // the ceremony works without a local marker (cross-device WebAuthn — the
      // same shipped posture as `pickSigningPath`). Returning
      // `passkey_on_other_device` here made this gate a false blocker (#1097):
      // it stripped Send/Receive from the dashboard hero for a user whose
      // send modal works, while the availability hint already lives next to
      // the working actions (DelegationSendModal, AccountSignersCard, the
      // #1952 wallet-menu disclosure). `passkey_on_other_device` remains the
      // LEGACY-Safe answer below, where the block is real: the stored signer
      // metadata a Safe passkey needs is physically absent on this device.
      return { kind: 'ready' }
    }
    // #2068: an owner-only hybrid set (EOA owner, zero enrolled passkeys)
    // CAN sign — but only with the named owner. The check is the connected
    // ADDRESS against the set's `owner_address`, mirroring `pickSigningPath`
    // and `useActiveSigner`: "a wallet is connected" never satisfied "the
    // owner is connected", and a gate opened for a wallet whose signature
    // the account rejects would be worse than the false `no_signer` it
    // replaces.
    if (
      hybridSigners?.owner_address &&
      address &&
      walletClient &&
      address.toLowerCase() === hybridSigners.owner_address.toLowerCase()
    ) {
      return { kind: 'ready' }
    }
    // No signer set known (hydration failed or none enrolled), or the set
    // names an owner this connected wallet is not. Deliberately NOT falling
    // through to the connected-EOA branch: a random connected wallet cannot
    // sign for a Hybrid account.
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
