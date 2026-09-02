import type { SafeDetails } from '@/types/transactions'

export type RetiredRailOwnerAccess = 'wallet' | 'passkey-only' | 'unknown'

/**
 * Classify legacy Safe owner access from positive evidence only. An unknown
 * owner is deliberately not treated as a wallet: it may be a passkey enrolled
 * outside Haven, and Safe's web interface cannot sign for a Haven passkey.
 */
export function classifyRetiredRailOwnerAccess({
  details,
  passkeyAddresses,
  walletAddress,
}: {
  details: SafeDetails | null
  passkeyAddresses: ReadonlySet<string>
  walletAddress?: string | null
}): RetiredRailOwnerAccess {
  if (!details || details.owners.length === 0) return 'unknown'

  const knownWalletOwner = walletAddress?.toLowerCase()
  if (knownWalletOwner && details.owners.some((owner) => owner.toLowerCase() === knownWalletOwner)) {
    return 'wallet'
  }

  return details.owners.every((owner) => passkeyAddresses.has(owner.toLowerCase()))
    ? 'passkey-only'
    : 'unknown'
}
