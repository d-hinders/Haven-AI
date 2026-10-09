import { currentPeriodBounds } from '@haven_ai/core'
import { formatAllowanceAmount, getTokenDecimals } from './allowance-format'
import { formatFiat } from './format'

/**
 * The ONE budget caption (#3806, epic #3801) — every budget meter in the app
 * phrases periods, refills, expiry and failed reads through this module, so
 * no two surfaces can disagree about what a budget row says.
 *
 * Three rules bind everything here:
 *
 * 1. **The clock is a parameter.** `nowMs` is a required argument on every
 *    entry point and nothing here reads `Date.now()` (#1995, the
 *    `agent-display.tsx` class of bug): a render captured on a frozen clock
 *    — every visual baseline — must produce the words that clock says.
 * 2. **The anchor is `start_date`.** A period runs from the row's
 *    `start_date` (Unix seconds): `start_date + k × period_seconds`, via
 *    `currentPeriodBounds` in `@haven_ai/core` — the same boundary the
 *    backend's reads report. It is NOT creation time: budgets are signed with
 *    `startDate: nowSec - 60`, and a re-key's carry/steady pair keeps the old
 *    boundary. The read's `period_end` is used only to detect a STALE read
 *    (now past it → the used amount belongs to a finished period).
 * 3. **Times are formatted `en-GB` with an explicit `timeZone`.** The zone is
 *    a parameter so a test — and a frozen-clock capture — does not depend on
 *    the machine it runs on. Omitted, it falls to the runtime's zone, which
 *    is what a live render wants.
 *
 * Money-path note: display only. No arithmetic here decides anything; the
 * one computation (`usedPercent`) is a ratio of two atomic strings on the
 * same token.
 */

// ── Period words ────────────────────────────────────────────────────────────
//
// The named rhythms the app offers read "per day" and so on (owner decision
// 2, 2026-10-09). Any other length reads "every N <largest unit that divides
// it exactly>": 14 400 → "every 4 hours", 5 400 → "every 90 minutes",
// 90 → "every 90 seconds", 1 209 600 → "every 14 days". No delegation budget
// is one-off — the API minimum is 60 s — so there is deliberately no
// "doesn't refill" wording keyed on a period length; a budget that never
// refills is a re-key carry row whose `expires_at` is at or before its period
// boundary, and that row's next event is simply "expires …".

const NAMED_PERIODS: Record<number, string> = {
  86_400: 'per day',
  604_800: 'per week',
  2_592_000: 'per month',
  3_600: 'per hour',
}

const PERIOD_UNITS = [
  { seconds: 86_400, one: 'day', many: 'days' },
  { seconds: 3_600, one: 'hour', many: 'hours' },
  { seconds: 60, one: 'minute', many: 'minutes' },
  { seconds: 1, one: 'second', many: 'seconds' },
] as const

/** "per day" · "per week" · "per month" · "per hour" · "every 4 hours" · … */
export function budgetPeriodWords(periodSeconds: number): string {
  const named = NAMED_PERIODS[periodSeconds]
  if (named) return named
  if (!Number.isFinite(periodSeconds) || periodSeconds <= 0) return `every ${periodSeconds} seconds`
  for (const unit of PERIOD_UNITS) {
    if (periodSeconds % unit.seconds === 0) {
      const n = periodSeconds / unit.seconds
      return `every ${n} ${n === 1 ? unit.one : unit.many}`
    }
  }
  return `every ${periodSeconds} seconds`
}

// ── Next event ──────────────────────────────────────────────────────────────
//
// The earlier of the refill and `expires_at`, phrased at three distances:
// under 24 h relative ("in 45m", "in 5h"), under 7 days weekday and 24-hour
// time ("Thu 14:02"), otherwise day and month ("14 Nov").

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

/**
 * "in 45m" · "Thu 14:02" · "14 Nov" — the time part of a next-event phrase,
 * at the distance the target sits from `nowMs`.
 */
export function formatNextEvent(targetMs: number, nowMs: number, timeZone?: string): string {
  const diff = targetMs - nowMs
  if (diff < 24 * MS_PER_HOUR) {
    const mins = Math.max(1, Math.round(diff / MS_PER_MINUTE))
    if (mins < 60) return `in ${mins}m`
    return `in ${Math.round(mins / 60)}h`
  }
  if (diff < 7 * MS_PER_DAY) {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    }).format(targetMs)
  }
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(targetMs)
}

/**
 * The next period boundary after `nowMs`, anchored on `start_date` —
 * `currentPeriodBounds(start, P, floor(now/1000)).end` in milliseconds.
 */
export function nextRefillAt(startSec: number, periodSeconds: number, nowMs: number): number {
  return currentPeriodBounds(startSec, periodSeconds, Math.floor(nowMs / 1000)).end * 1000
}

// ── Amounts ─────────────────────────────────────────────────────────────────
//
// Token mode is the budget card's voice: the delegation's own units, always
// two decimals ("1.25 of 5.00 USDC"). Currency mode is everywhere else: a
// rate supplied by the caller converts the token amounts to the display
// currency, and the caption carries ONE leading "≈" because a spot rate is an
// estimate. An unknown rate falls back to token mode.

export type BudgetRate = { currency: 'USD' | 'EUR' | 'SEK'; /** Fiat per one token unit. */ perToken: number }

export interface BudgetAmountOptions {
  chainId?: number | null
  /** Absent, or a rate that could not be resolved, renders token mode. */
  rate?: BudgetRate | null
}

function tokenAmount(atomic: string, symbol: string, chainId: number | null | undefined): string {
  const decimals = chainId != null ? getTokenDecimals(chainId, symbol) : undefined
  // Always two decimals. The SYMBOL is appended by the phrase that uses the
  // amount — a caption names it once ("1.25 of 5.00 USDC"), a note names it
  // on its own figure ("incl. 1.25 USDC by Helper").
  return formatAllowanceAmount(atomic, decimals ?? 18, {
    symbol,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** Bare fiat — "$1.25". An unparseable amount falls back to token mode. */
function fiatValue(atomic: string, symbol: string, rate: BudgetRate, chainId: number | null | undefined): string {
  const decimals = chainId != null ? getTokenDecimals(chainId, symbol) : undefined
  const decimal = formatAllowanceAmount(atomic, decimals ?? 18, {})
  const human = Number.parseFloat(decimal)
  if (!Number.isFinite(human)) return tokenAmount(atomic, symbol, chainId)
  return formatFiat(human * rate.perToken, rate.currency)
}

/**
 * One budget amount in the mode `options` selects: token units, or "≈" fiat —
 * the "≈" marks the estimate a spot rate always is.
 */
export function budgetAmount(atomic: string, symbol: string, options: BudgetAmountOptions = {}): string {
  const { chainId = null, rate } = options
  return rate ? `≈${fiatValue(atomic, symbol, rate, chainId)}` : `${tokenAmount(atomic, symbol, chainId)} ${symbol}`.trim()
}

// ── The caption ─────────────────────────────────────────────────────────────

/**
 * One budget row, normalized to what a caption needs. Callers map their wire
 * shape onto this — `agent_delegations` rows (Unix seconds) and the analytics
 * response (ISO `period_start`/`period_end`, from which the caller derives
 * the period length) both project onto it.
 */
export interface BudgetCaptionRow {
  /** Slot identity: token (address or symbol) and recipient, for pairing. */
  token: string
  recipient: string | null
  /** Unix seconds. The anchor — NOT creation time. */
  startSec: number
  periodSeconds: number
  /** Unix seconds; null when the row carries no expiry (the analytics read). */
  expiresSec: number | null
  budgetAtomic: string
  /** The used amount when a read exists, else null — "no figure" ≠ "failed". */
  usedAtomic: string | null
  /** False when the on-chain read failed (the used amount is a fallback). */
  readFromChain: boolean
  /** The read's period end (ms). now ≥ it → the read is stale. */
  periodEndMs: number | null
  /** Ordering anchor when no row has a read: the first row by creation. */
  createdMs?: number | null
  symbol: string
  chainId?: number | null
}

export interface BudgetCaptionOptions {
  /** Required — the helper never reads the clock itself (#1995). */
  nowMs: number
  timeZone?: string
  /** Currency mode; absent or unresolvable → token mode. */
  rate?: BudgetRate | null
}

export type BudgetCaption =
  | { kind: 'meter'; usedPercent: number; label: string; caption: string }
  /** No figure exists on the row — render nothing, not zero. */
  | { kind: 'none' }
  /** The chain read failed: no meter, the caption says so. */
  | { kind: 'unknown'; caption: string }
  | { kind: 'expired'; caption: string }
  /** A future `start_date` — the dormant half of a re-key. */
  | { kind: 'not-started'; caption: string }
  /** now ≥ the read's `period_end`: the used amount belongs to a finished
      period, so it renders as unknown until the next read. The old amount is
      never paired with the next refill. */
  | { kind: 'refilled-updating'; caption: string }

export const UNREAD_CAPTION = 'Usage this period couldn’t be read'
export const EXPIRED_CAPTION = 'This budget has expired and can no longer be spent.'

function usedPercentOf(usedAtomic: string, budgetAtomic: string): number | null {
  let used: bigint
  let total: bigint
  try {
    used = BigInt(usedAtomic)
    total = BigInt(budgetAtomic)
  } catch {
    return null
  }
  if (total <= 0n) return 0
  if (used <= 0n) return 0
  return Math.min(100, Number((used * 10_000n) / total) / 100)
}

function meterCaption(row: BudgetCaptionRow, options: BudgetCaptionOptions): string {
  const { nowMs, timeZone, rate } = options
  const usedLine = rate
    ? // Currency mode: ONE leading "≈" for the caption — a spot rate is an
      // estimate, and the estimate covers the line, not each figure.
      `≈${fiatValue(row.usedAtomic ?? '0', row.symbol, rate, row.chainId)} of ${fiatValue(row.budgetAtomic, row.symbol, rate, row.chainId)} used this period`
    : `${tokenAmount(row.usedAtomic ?? '0', row.symbol, row.chainId)} of ${tokenAmount(row.budgetAtomic, row.symbol, row.chainId)} ${row.symbol} used this period`
  const refillMs = nextRefillAt(row.startSec, row.periodSeconds, nowMs)
  const expiresMs = row.expiresSec != null ? row.expiresSec * 1000 : null
  // The earlier of the two wins; "expires" is the phrase at a tie — a re-key
  // carry row's expiry sits AT its period boundary, so it correctly reads as
  // an expiry, never as a refill that will not happen.
  const when =
    expiresMs != null && expiresMs <= refillMs
      ? `expires ${formatNextEvent(expiresMs, nowMs, timeZone)}`
      : `refills ${formatNextEvent(refillMs, nowMs, timeZone)}`
  return `${usedLine} · ${when}`
}

/**
 * The caption for one budget row (#3806). Every budget meter in the app — the
 * agent detail card, the edit modals, the analytics table, the dashboard row
 * — renders through this one function.
 */
export function budgetCaption(row: BudgetCaptionRow, options: BudgetCaptionOptions): BudgetCaption {
  const { nowMs } = options
  // An `active` row can outlive its `expires_at` — nothing flips the status.
  // Such a budget can no longer spend: no meter, no countdown.
  if (row.expiresSec != null && row.expiresSec * 1000 <= nowMs) return { kind: 'expired', caption: EXPIRED_CAPTION }
  // The dormant half of a re-key: the steady grant has not begun.
  if (row.startSec * 1000 > nowMs) {
    return { kind: 'not-started', caption: `Starts ${formatNextEvent(row.startSec * 1000, nowMs, options.timeZone)}` }
  }
  // No read at all is not a failed read: the row renders nothing rather than
  // claiming a measurement it does not have.
  if (row.usedAtomic == null || !row.readFromChain) {
    return row.readFromChain ? { kind: 'none' } : { kind: 'unknown', caption: UNREAD_CAPTION }
  }
  // now ≥ the read's period_end: the used amount belongs to a finished
  // period. It renders as unknown until the next read — the old amount is
  // never paired with the next refill.
  if (row.periodEndMs != null && nowMs >= row.periodEndMs) {
    return { kind: 'refilled-updating', caption: UNREAD_CAPTION }
  }
  const usedPercent = usedPercentOf(row.usedAtomic, row.budgetAtomic)
  if (usedPercent == null) return { kind: 'unknown', caption: UNREAD_CAPTION }
  return {
    kind: 'meter',
    usedPercent,
    label: `${row.symbol} budget used`.trim(),
    caption: meterCaption(row, options),
  }
}

// ── Notes ───────────────────────────────────────────────────────────────────
//
// Quiet lines under a caption, in the caption's mode: what other agents have
// already spent of this budget, and what is carved away for task budgets.

export interface BudgetNote {
  agentName: string
  usedAtomic: string
}

/** "incl. 1.25 USDC by Helper" — one line per sub-agent that spent. */
export function budgetNoteLine(note: BudgetNote, symbol: string, options: BudgetAmountOptions = {}): string {
  return `incl. ${budgetAmount(note.usedAtomic, symbol, options)} by ${note.agentName}`
}

/** "1.00 USDC reserved for task budgets" — the carve-out the card names. */
export function budgetReservedNote(reservedAtomic: string, symbol: string, options: BudgetAmountOptions = {}): string {
  return `${budgetAmount(reservedAtomic, symbol, options)} reserved for task budgets`
}

// ── Several budgets (the dashboard row, adopted in #3809) ───────────────────

export interface SelectedBudgets {
  primary: BudgetCaptionRow
  /** "+N budgets" — visible text OUTSIDE the meter caption (the ARIA label
      does not announce it), so the caller renders it, not the caption. */
  extraCount: number
}

/**
 * Collapse one agent's period budgets to a primary row plus a count.
 *
 * Expired rows and future-start rows are excluded from the count — and
 * because a re-key's steady grant starts exactly where its carry dies, the
 * carry/steady pair in one (token, recipient) slot always leaves exactly one
 * live row, so the pair counts as one without any pairing machinery. Task
 * budgets and received sub-budgets are carved from these rows and are not
 * inputs here (owner decision 1).
 *
 * Primary: the highest used % among rows with a chain read, ties broken by
 * the soonest refill; if no row has a read, the first row by `created_at`,
 * with its used amount unknown.
 */
export function selectPrimaryBudgets(rows: BudgetCaptionRow[], nowMs: number): SelectedBudgets | null {
  const nowSec = Math.floor(nowMs / 1000)
  const live = rows.filter(
    (r) =>
      !(r.expiresSec != null && r.expiresSec <= nowSec) && // expired (#3802)
      r.startSec <= nowSec, // future start — the dormant half of a re-key
  )
  if (live.length === 0) return null
  const read = live.filter((r) => r.usedAtomic != null && r.readFromChain && usedPercentOf(r.usedAtomic, r.budgetAtomic) != null)
  let primary: BudgetCaptionRow
  if (read.length > 0) {
    primary = read.reduce((best, r) => {
      const bestPct = usedPercentOf(best.usedAtomic!, best.budgetAtomic)!
      const pct = usedPercentOf(r.usedAtomic!, r.budgetAtomic)!
      if (pct !== bestPct) return pct > bestPct ? r : best
      // Tie: the soonest refill wins.
      return nextRefillAt(r.startSec, r.periodSeconds, nowMs) < nextRefillAt(best.startSec, best.periodSeconds, nowMs) ? r : best
    })
  } else {
    // No row has a read: the first by `created_at` (falling back to list
    // order when creation time is absent), its used amount unknown.
    primary = live.reduce((best, r) => {
      const bestCreated = best.createdMs ?? Number.POSITIVE_INFINITY
      const created = r.createdMs ?? Number.POSITIVE_INFINITY
      return created < bestCreated ? r : best
    })
  }
  return { primary, extraCount: live.length - 1 }
}
