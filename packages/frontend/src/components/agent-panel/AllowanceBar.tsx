'use client'

import { useState, useEffect } from 'react'
import { type AgentAllowance } from '@/hooks/useAgents'
import { computeEffectiveAllowance, type AllowanceInfo } from '@/lib/allowance-math'
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

/**
 * The placeholder for a token budget while its data is still loading.
 *
 * `aria-busy="true"` is not decoration (#2204). Two readers need it and
 * neither had it:
 *
 *   - a screen reader, which was given a bare "loading..." with no busy state,
 *     so the row said nothing about being unfinished;
 *   - the capture harness, which cannot otherwise tell this row apart from a
 *     resolved one. `/agents` photographed with all three cards on this
 *     placeholder is 40 CSS px shorter than the same page resolved, clears the
 *     #2036 content floor comfortably (886 chars / 147 elements against a floor
 *     of 30 / 6), and produces a PNG that looks entirely healthy. The busy flag
 *     is the app SAYING it is not finished, which is what
 *     `resolveContentSettled` now refuses to capture over.
 *
 * `aria-busy` and nothing else, deliberately (#2204 design review). The first
 * draft also put `role="status"` + `aria-live="polite"` + a per-token
 * `aria-label` here, which announced the byte-identical "Loading USDC budget"
 * once per AgentCard — three times over on `/agents`, carrying no information
 * the first one did not. The app's own convention is one status region per
 * loading SURFACE (`DashboardClient.tsx:134`, `AgentDetailClient.tsx:373`,
 * `TransactionsTable.tsx:150`), so the live region lives on the list in
 * `AgentCard` and each row only reports its own busy state.
 */
export function AllowanceBarSkeleton({ symbol }: { symbol: string }) {
  return (
    <div className="flex items-center gap-2 text-xs" aria-busy="true">
      <span className="text-[var(--v2-ink-2)]">{symbol}</span>
      <div className="flex-1 h-[3px] bg-[var(--v2-surface-2)] rounded-full" />
      <span className="text-[var(--v2-ink-3)] animate-pulse">loading...</span>
    </div>
  )
}

/**
 * The agent's granted budget, rendered from the `agent.allowances` array.
 *
 * ── What the number actually is, and why the caption changed (#2224) ─────────
 *
 * This row was captioned **"Configured in Haven"**, which says Haven holds the
 * limit. Traced to the code that emits the value, that is false on every path
 * that can reach this component today:
 *
 *   - `GET /agents` and `GET /agents/:id` fill `allowances` from
 *     `deriveDelegationAllowances` (`backend/src/routes/agents.ts:85-98` and
 *     `:113-121`), which is `rails/delegation-budget-view.ts` projecting the
 *     agent's **ACTIVE `agent_delegations` rows** — `budget_atomic` →
 *     `allowance_amount`, `period_seconds / 60` → `reset_period_min`. Those are
 *     the terms of a delegation the user SIGNED, enforced by the caveat
 *     enforcers during redemption. That file's own header says it: *"Read/
 *     reporting path ONLY: enforcement stays the on-chain delegation."*
 *   - A legacy-rail agent gets `allowances: []` outright — the `agent_allowances`
 *     read surface is retired (#1440/#2020, `infra/repositories/agents.ts:232-237`),
 *     so no row renders here at all and the card shows "No agent budget
 *     configured".
 *
 * So the array is never a Haven-side policy mirror. It is an on-chain-enforced
 * envelope, reported. The caption inverted the one claim Haven makes everywhere
 * else — `/custody` exists to say the limit is enforced by the account and not
 * by Haven's database.
 *
 * **The wording is not new.** `/custody` already labels this exact data
 * "Agent spend authority (enforced on-chain)" (`custody/page.tsx:249-251`,
 * `:427`) and states the honesty caveat that applies here unchanged: *"These
 * are the terms of the delegation you signed"* (`:314-316`) — the signed terms,
 * not a fresh chain read. Inventing a third phrasing for one fact is the defect
 * #2195 just fixed one surface over, so this reuses `/custody`'s.
 *
 * ── Why the "fallback" framing in the old header was wrong too ───────────────
 *
 * The configured budget row is the ordinary delegation-rail rendering. The
 * proportional `AllowanceBar` above remains a pure legacy-data renderer for
 * historical math coverage, but the dashboard no longer reads it from a Safe
 * AllowanceModule.
 *
 * **Deliberately renders no bar (#1846).** `AgentAllowance` carries
 * `allowance_amount` and `reset_period_min` and nothing else — there is no
 * spend figure on this shape, so there is no proportion to draw. The rule that
 * used to sit here was `h-full w-full`: the same 3px geometry as `AllowanceBar`
 * above, permanently pegged at 100%, a meter that renders identically whatever
 * is true. It read as "fully spent" (or as a live meter that happens to be
 * pegged) when what is actually known is only the granted envelope.
 *
 * If a spend figure ever reaches this shape, render `AllowanceBar` — do not
 * reintroduce a track here. `AllowanceBar.test.tsx` pins the split.
 *
 * The component keeps its name: it is named for its INPUT (the configured
 * `allowances` projection), not for the claim it makes about it, and the claim
 * was the defect.
 */
/**
 * The caption, exported so the test can assert the rendered string without
 * restating it, and so a future third surface reuses it rather than minting a
 * fourth phrasing. The independently-restated literal lives in
 * `AllowanceBar.test.tsx`, which is what can catch an unintended copy change.
 */
export const GRANTED_BUDGET_CAPTION = 'Enforced on-chain'

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
      <p className="text-xs text-[var(--v2-ink-3)]">{GRANTED_BUDGET_CAPTION}</p>
    </div>
  )
}
