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
  // #2073: a wallet IS connected, but it is not the hybrid account's named
  // owner. Distinct from `no_signer` so consumers can say "the wallet you
  // connected is the wrong one" instead of "connect a wallet" — the header
  // pill and the action area used to silently disagree about whether a
  // useful wallet was connected. Carries both addresses so a consumer can
  // name the mismatch. Only the hybrid branch produces it: on the legacy
  // rail any connected wallet may propose (ownership is enforced by the
  // Safe itself), so "wrong wallet" is not a knowable client-side fact there.
  | { kind: 'wrong_wallet'; connectedAddress: Address; ownerAddress: Address }
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
    // #2413: every listed account is on the delegation rail, so matching the
    // address and chain is the whole test.
    return (user?.safes ?? []).some(
      (safe) =>
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
    // #2073: the set names an owner and a DIFFERENT wallet is connected —
    // that is a fact worth naming, not a generic "no signer". Deliberately
    // keyed on the connected ADDRESS alone (no walletClient requirement):
    // the mismatch is true whatever chain the wallet sits on, and switching
    // networks would not make a non-owner wallet the owner.
    if (
      hybridSigners?.owner_address &&
      address &&
      address.toLowerCase() !== hybridSigners.owner_address.toLowerCase()
    ) {
      return {
        kind: 'wrong_wallet',
        connectedAddress: address,
        ownerAddress: hybridSigners.owner_address as Address,
      }
    }
    // No signer set known (hydration failed or none enrolled), no wallet
    // connected at all, or the owner IS connected but its walletClient is not
    // ready yet (e.g. wrong network). Deliberately NOT falling through to the
    // connected-EOA branch: a random connected wallet cannot sign for a
    // Hybrid account.
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
