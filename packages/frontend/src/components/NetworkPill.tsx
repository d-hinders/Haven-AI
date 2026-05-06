'use client'

import { getChainConfig } from '@/lib/chains'

/**
 * Small coloured pill identifying which chain a Haven account lives on. Designed to
 * sit next to an account name or address — compact, quiet, but enough to tell
 * Gnosis and Base apart at a glance on the Accounts list.
 */

const CHAIN_STYLES: Record<number, { dot: string; text: string; border: string; bg: string }> = {
  // Gnosis — green
  100: {
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    border: 'border-emerald-500/20',
    bg: 'bg-emerald-500/[0.06]',
  },
  // Base — blue
  8453: {
    dot: 'bg-sky-400',
    text: 'text-sky-300',
    border: 'border-sky-500/20',
    bg: 'bg-sky-500/[0.06]',
  },
}

const FALLBACK_STYLE = {
  dot: 'bg-zinc-400',
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
  let name = 'Unknown network'
  try {
    name = getChainConfig(chainId).name
  } catch {
    // fall through to fallback styling
  }

  const style = CHAIN_STYLES[chainId] ?? FALLBACK_STYLE
  const padding = size === 'md' ? 'px-2 py-0.5' : 'px-1.5 py-0.5'
  const textSize = size === 'md' ? 'text-[11px]' : 'text-[10px]'

  return (
    <span
      className={`inline-flex items-center gap-1.5 ${padding} rounded-full border ${style.border} ${style.bg} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      <span className={`${textSize} font-medium ${style.text} leading-none`}>{name}</span>
    </span>
  )
}
