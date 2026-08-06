'use client'

import { Bot } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { type AgentAllowance } from '@/hooks/useAgents'
import { formatAllowanceAmount, getTokenDecimals } from '@/lib/allowance-format'
import { truncate } from '@/lib/format'
import { getChainTokens } from '@/lib/safe-tx'

/** Display helpers shared across the agent-panel pieces. */

/** Resolve token address to symbol (chain-aware) */
export function tokenSymbol(addr: string, chainId: number): string {
  const lower = addr.toLowerCase()
  const tokens = getChainTokens(chainId)
  if (lower === '0x0000000000000000000000000000000000000000') {
    return Object.entries(tokens).find(([, cfg]) => cfg.address === null)?.[0] ?? 'Native'
  }
  for (const [symbol, cfg] of Object.entries(tokens)) {
    if (cfg.address && cfg.address.toLowerCase() === lower) return symbol
  }
  return truncate(addr)
}

/** Resolve token address to decimals (chain-aware) */
export function tokenDecimals(addr: string, chainId: number): number {
  const lower = addr.toLowerCase()
  const tokens = getChainTokens(chainId)
  if (lower === '0x0000000000000000000000000000000000000000') return 18
  for (const cfg of Object.values(tokens)) {
    if (cfg.address && cfg.address.toLowerCase() === lower) return cfg.decimals
  }
  return 18
}

function tokenDecimalsForAllowance(allowance: AgentAllowance, chainId: number): number {
  return getTokenDecimals(chainId, allowance.token_symbol) ?? tokenDecimals(allowance.token_address, chainId)
}

export function formatConfiguredAllowance(allowance: AgentAllowance, chainId: number): string {
  try {
    return formatAllowanceAmount(
      BigInt(allowance.allowance_amount).toString(),
      tokenDecimalsForAllowance(allowance, chainId),
      { symbol: allowance.token_symbol },
    )
  } catch {
    return allowance.allowance_amount
  }
}

/** Format relative time until a date */
export function timeUntil(date: Date): string {
  const diffMs = date.getTime() - Date.now()
  if (diffMs <= 0) return 'now'
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function BotIcon({ size = 15 }: { size?: number }) {
  return (
    <Icon icon={Bot} size={size} className="flex-shrink-0" />
  )
}
