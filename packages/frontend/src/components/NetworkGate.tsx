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

  // Inline ghost button — sits in place of the action button without a
  // yellow background so it doesn't read as a warning anomaly. The hint
  // above (rendered by the parent OnchainActionGate or caller) tells
  // the user *why* the action is gated.
  return (
    <div className={className}>
      <p
        role="status"
        className="mb-2 flex items-start gap-2 text-xs text-[var(--v2-ink-3)]"
      >
        <svg
          aria-hidden="true"
          className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" strokeLinecap="round" />
          <circle cx="12" cy="8" r="0.6" fill="currentColor" />
        </svg>
        <span>Your wallet is on a different network than this account.</span>
      </p>
      <button
        type="button"
        onClick={() => switchChain({ chainId: requiredChainId })}
        disabled={isPending}
        className="h-10 w-full rounded-md border border-[var(--v2-border-strong)] bg-white px-4 text-sm font-medium text-[var(--v2-ink)] transition-colors hover:border-[var(--v2-brand)]/40 hover:bg-[var(--v2-surface)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
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
