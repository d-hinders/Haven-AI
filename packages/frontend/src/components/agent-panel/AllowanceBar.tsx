'use client'

import { useState, useEffect } from 'react'
import { type AgentAllowance } from '@/hooks/useAgents'
import { computeEffectiveAllowance, type AllowanceInfo } from '@/lib/allowance-module'
import { formatAllowanceAmount } from '@/lib/allowance-format'
import { budgetPeriodLabel } from '@/lib/budget-period'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { formatConfiguredAllowance, timeUntil, tokenDecimals, tokenSymbol } from './agent-display'

/** On-chain allowance bar (on-chain data primary). */
export function AllowanceBar({
  info,
  loading,
  chainTimeSec,
  chainId = DEFAULT_CHAIN_ID,
}: {
  info: AllowanceInfo
  loading?: boolean
  chainTimeSec: number | null
  chainId?: number
}) {
  const decimals = tokenDecimals(info.token, chainId)
  const symbol = tokenSymbol(info.token, chainId)
  // chainTimeSec is captured in the same fetch cycle as `info`, so it is
  // non-null whenever real allowances render. The fallback only covers the
  // brief pre-load frame (where `loading` is already shown); the reset decision
  // must otherwise use chain time, never the device clock.
  //
  // ONE clock for the whole row (#1995). `nowSec` decides *whether* the
  // allowance has reset; `nowMs` formats *how long until* it does. They are the
  // same instant by construction, so the two halves of that sentence can no
  // longer disagree. Before this, the countdown read `Date.now()` inside
  // `timeUntil` — one line below the comment above saying the device clock must
  // never be used — and any skew that pushed a near-boundary reset past zero
  // rendered "Resets in now" for an allowance the component had just decided
  // has NOT reset. Do not read a second clock here, even one that would
  // usually agree — including in the fallback branch above, which is exactly
  // why `nowMs` is derived FROM `nowSec` rather than read alongside it. Note
  // what that does and does not buy: `timeUntil`'s parameter makes the clock
  // visible at the call site, it does not make a wrong one impossible.
  const nowSec = chainTimeSec ?? Math.floor(Date.now() / 1000)
  const nowMs = nowSec * 1000
  const effective = computeEffectiveAllowance(info, nowSec)
  const total = info.amount
  const spent = effective.effectiveSpent
  const remaining = effective.remaining
  const pct = total > 0n ? Number((spent * 100n) / total) : 0
  const nearLimit = pct >= 90 && remaining > 0n
  // Semantic bar fills via design-system tokens (--v2-bar-fill-*) — these
  // replace the previous hardcoded indigo / amber / red Tailwind gradients
  // so the colors are consistent with the rest of the v2 palette.
  const fillStyle =
    pct < 40
      ? 'var(--v2-bar-fill-ok)'
      : pct < 75
        ? 'var(--v2-bar-fill-warn)'
        : 'var(--v2-bar-fill-danger)'

  // Animate bar width from 0 to target on mount
  const [displayPct, setDisplayPct] = useState(0)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDisplayPct(Math.min(pct, 100)))
    return () => cancelAnimationFrame(frame)
  }, [pct])

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[var(--v2-ink-2)] font-medium flex items-center gap-1.5">
          {symbol}
          {nearLimit && (
            <span
              className="inline-flex items-center gap-1 rounded bg-[var(--v2-danger-soft)] px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-[var(--v2-danger)] animate-pending-pulse"
              title={`${pct}% of allowance spent`}
            >
              <span className="w-1 h-1 rounded-full bg-[var(--v2-danger)]" />
              near limit
            </span>
          )}
          {loading && (
            <span className="ml-1 text-[var(--v2-ink-3)] animate-pulse">...</span>
          )}
        </span>
        <span className="text-[var(--v2-ink-3)]">
          <span className="v2-tabular">{formatAllowanceAmount(remaining.toString(), decimals, { symbol })}</span>
          {' / '}
          <span className="v2-tabular">{formatAllowanceAmount(total.toString(), decimals, { symbol })}</span>
          {' remaining'}
          {info.resetTimeMin > 0 && (
            <span className="text-[var(--v2-ink-3)] ml-1">
              {budgetPeriodLabel(info.resetTimeMin)}
            </span>
          )}
        </span>
      </div>
      <div
        className={`w-full h-[3px] bg-[var(--v2-surface-2)] rounded-full overflow-hidden ${
          nearLimit ? 'ring-1 ring-danger/30 ring-offset-0' : ''
        }`}
      >
        <div
          className={`h-full rounded-full allowance-fill ${nearLimit ? 'animate-pulse' : ''}`}
          style={{ width: `${displayPct}%`, background: fillStyle }}
        />
      </div>
      {/* Reset info */}
      {effective.isResetPending && (
        <p className="text-xs text-[var(--v2-success)]">
          Reset pending — full allowance available
        </p>
      )}
      {!effective.isResetPending && effective.nextResetTime && (
        <p className="text-xs text-[var(--v2-ink-3)]">
          Resets in {timeUntil(effective.nextResetTime, nowMs)}
        </p>
      )}
      {remaining === 0n && total > 0n && !effective.isResetPending && (
        <p className="text-xs text-[var(--v2-danger)]">
          Fully spent{info.resetTimeMin > 0 ? ' — resets ' + (effective.nextResetTime ? 'in ' + timeUntil(effective.nextResetTime, nowMs) : 'next period') : ''}
        </p>
      )}
    </div>
  )
}

export function AllowanceBarSkeleton({ symbol }: { symbol: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[var(--v2-ink-2)]">{symbol}</span>
      <div className="flex-1 h-[3px] bg-[var(--v2-surface-2)] rounded-full" />
      <span className="text-[var(--v2-ink-3)] animate-pulse">loading...</span>
    </div>
  )
}

/**
 * DB-configured allowance row, shown when on-chain data is unavailable.
 *
 * **Deliberately renders no bar (#1846).** `AgentAllowance` carries
 * `allowance_amount` and `reset_period_min` and nothing else — there is no
 * spend figure on this shape, so there is no proportion to draw. The rule that
 * used to sit here was `h-full w-full`: the same 3px geometry as `AllowanceBar`
 * above, permanently pegged at 100%, a meter that renders identically whatever
 * is true. It read as "fully spent" (or as a live meter that happens to be
 * pegged) when what is actually known is only the configured envelope.
 *
 * If a spend figure ever reaches this shape, render `AllowanceBar` — do not
 * reintroduce a track here. `AllowanceBar.test.tsx` pins the split.
 */
export function ConfiguredAllowanceRow({
  allowance,
  chainId,
}: {
  allowance: AgentAllowance
  chainId: number
}) {
  const reset = budgetPeriodLabel(allowance.reset_period_min)

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-[var(--v2-ink-2)]">{allowance.token_symbol}</span>
        <span className="text-right text-[var(--v2-ink-3)]">
          <span className="v2-tabular">{formatConfiguredAllowance(allowance, chainId)}</span>
          {` ${allowance.token_symbol}`}
          {allowance.reset_period_min > 0 ? ` ${reset}` : ''}
        </span>
      </div>
      <p className="text-xs text-[var(--v2-ink-3)]">Configured in Haven</p>
    </div>
  )
}
