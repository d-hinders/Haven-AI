'use client'

import { Bot } from 'lucide-react'
import { Icon, type IconSize } from '@/components/ui/Icon'
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

/**
 * Format the remaining time until `date`, measured against `nowMs`.
 *
 * `nowMs` is REQUIRED, and that is the whole point (#1995). This helper used
 * to read `Date.now()` itself, which silently made the device clock the
 * reference for every caller. `AllowanceBar` decides whether an allowance has
 * reset from CHAIN time (`computeEffectiveAllowance(info, chainTimeSec)`) and
 * then rendered the countdown for that same decision through here — so one
 * sentence was computed against two clocks, and any device-clock skew could
 * make the two halves contradict each other outright (a live budget whose
 * countdown reads `now`).
 *
 * Making the reference time a parameter rather than an ambient read raises the
 * cost of the mistake without eliminating it, and the difference is worth being
 * precise about: it stops the split happening by FORGETTING — the caller must
 * now name a clock — but the type is `number`, so passing one derived from a
 * different read than the surrounding decision still typechecks. This is a
 * legibility guarantee, not a soundness one. Pass the SAME instant the
 * surrounding decision was made from, and read it once.
 */
export function timeUntil(date: Date, nowMs: number): string {
  const diffMs = date.getTime() - nowMs
  if (diffMs <= 0) return 'now'
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function BotIcon({ size = 16 }: { size?: IconSize }) {
  return (
    <Icon icon={Bot} size={size} className="flex-shrink-0" />
  )
}
