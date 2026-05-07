'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { getChainConfig } from '@/lib/chains'

interface NetworkGateProps {
  requiredChainId: number
  children: ReactNode
  /** Optional class on the wrapper around the switch button. */
  className?: string
  /** When true, request a chain switch automatically once per mismatch. */
  autoSwitch?: boolean
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
  autoSwitch = false,
}: NetworkGateProps) {
  const { isConnected, chain } = useAccount()
  const { switchChain, isPending, error } = useSwitchChain()
  const attemptedMismatchRef = useRef<string | null>(null)

  const mismatchKey =
    isConnected && chain?.id !== undefined && chain.id !== requiredChainId
      ? `${chain.id}->${requiredChainId}`
      : null

  useEffect(() => {
    if (!autoSwitch || !switchChain || !mismatchKey || isPending) {
      return
    }

    if (attemptedMismatchRef.current === mismatchKey) {
      return
    }

    attemptedMismatchRef.current = mismatchKey
    switchChain({ chainId: requiredChainId })
  }, [autoSwitch, isPending, mismatchKey, requiredChainId, switchChain])

  useEffect(() => {
    if (chain?.id === requiredChainId) {
      attemptedMismatchRef.current = null
    }
  }, [chain?.id, requiredChainId])

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
        className="w-full px-4 py-2 rounded-md text-sm font-medium bg-[var(--v2-warning-soft)] text-[var(--v2-warning)] border border-[var(--v2-warning)]/25 hover:border-[var(--v2-warning)]/40 hover:bg-[var(--v2-warning-soft)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-warning)]/30"
      >
        {isPending ? `Switching to ${chainName}…` : `Switch wallet to ${chainName}`}
      </button>
      {error && (
        <p className="mt-2 text-xs text-[var(--v2-danger)]">
          Could not switch network: {error.message}
        </p>
      )}
    </div>
  )
}
