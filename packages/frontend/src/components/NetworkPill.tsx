'use client'

import { resolveChainOrNull } from '@/lib/chains'

/**
 * Small coloured pill identifying which chain a Haven account lives on. Designed to
 * sit next to an account name or address — compact, quiet, but enough to tell
 * networks apart at a glance. Resolves a PERSISTED row's chain, so it covers
 * history-only Gnosis (100) as well as the offered Base chains.
 */

const CHAIN_STYLES: Record<number, { dot: string; text: string; border: string; bg: string }> = {
  // Gnosis — green. History-only (#3634): rows persisted before the removal.
  100: {
    dot: 'bg-[var(--v2-success)]',
    text: 'text-[var(--v2-success)]',
    border: 'border-success/20',
    bg: 'bg-[var(--v2-success-soft)]',
  },
  // Base — sky-tinted pill (chain-identity tokens, see globals.css)
  8453: {
    dot: 'bg-[var(--v2-chain-base-dot)]',
    text: 'text-[var(--v2-chain-base-fg)]',
    border: 'border-[var(--v2-chain-base-border)]',
    bg: 'bg-[var(--v2-chain-base-bg)]',
  },
  // Base Sepolia — amber, to flag the testnet distinctly from Base mainnet
  84532: {
    dot: 'bg-[var(--v2-chain-testnet)]',
    text: 'text-[var(--v2-chain-testnet-fg)]',
    border: 'border-[var(--v2-chain-testnet-border)]',
    bg: 'bg-[var(--v2-chain-testnet-bg)]',
  },
}

const FALLBACK_STYLE = {
  dot: 'bg-[var(--v2-ink-3)]',
  text: 'text-[var(--v2-ink-2)]',
  border: 'border-[var(--v2-border)]',
  bg: 'bg-[var(--v2-surface-2)]',
}

interface NetworkPillProps {
  chainId: number
  size?: 'sm' | 'md'
  className?: string
}

export default function NetworkPill({ chainId, size = 'sm', className = '' }: NetworkPillProps) {
  // Resolve safely so an unknown chain doesn't crash the UI.
  const name = resolveChainOrNull(chainId)?.name ?? 'Unknown network'

  const style = CHAIN_STYLES[chainId] ?? FALLBACK_STYLE
  const padding = size === 'md' ? 'px-2 py-0.5' : 'px-1.5 py-0.5'
  const textSize = 'text-xs'

  return (
    <span
      className={`inline-flex items-center gap-1.5 ${padding} rounded-full border ${style.border} ${style.bg} ${className}`}
      title={`Chain ${chainId}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      <span className={`${textSize} font-medium ${style.text} leading-none`}>{name}</span>
    </span>
  )
}
