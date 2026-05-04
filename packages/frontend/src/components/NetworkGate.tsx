'use client'

import { type ReactNode } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { getChainConfig } from '@/lib/chains'

interface NetworkGateProps {
  requiredChainId: number
  children: ReactNode
  /** Optional class on the wrapper around the switch button. */
  className?: string
}

/**
 * Renders `children` (typically a Sign button) when the connected wallet is
 * on `requiredChainId`. Otherwise renders a "Switch to <chain>" button that
 * triggers wagmi's switchChain. Used in signing flows where the wallet
 * network must match the Safe's chain at execution time.
 */
export default function NetworkGate({
  requiredChainId,
  children,
  className,
}: NetworkGateProps) {
  const { isConnected, chain } = useAccount()
  const { switchChain, isPending, error } = useSwitchChain()

  if (!isConnected || chain?.id === requiredChainId) {
    return <>{children}</>
  }

  let chainName = `chain ${requiredChainId}`
  try {
    chainName = getChainConfig(requiredChainId).name
  } catch {
    /* fall back to id label */
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => switchChain({ chainId: requiredChainId })}
        disabled={isPending}
        className="w-full px-4 py-2 rounded-md text-sm font-medium bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
      >
        {isPending ? `Switching to ${chainName}…` : `Switch wallet to ${chainName}`}
      </button>
      {error && (
        <p className="mt-2 text-xs text-red-400">
          Could not switch network: {error.message}
        </p>
      )}
    </div>
  )
}
