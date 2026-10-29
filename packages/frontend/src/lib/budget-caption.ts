import { currentPeriodBounds, shouldMarkApprox } from '@haven_ai/core'
import { defaultTokenUnitDecimals, formatAllowanceAmount, getTokenDecimals } from './allowance-format'
import { formatFiatDisplay } from './format'
import { formatSubBudgetDate } from './sub-budget'

/**
 * The ONE budget caption (#3806, epic #3801) — every budget meter in the app
 * phrases periods, refills, expiry and failed reads through this module, so
 * no two surfaces can disagree about what a budget row says. The dashboard's
 * agent rows ask for the compact `style: 'row'` wording (#3908) — the same
 * figures and next event, with the period word in place of "used this
 * period"; every other surface keeps the full wording.
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
// currency, and the caption carries at most ONE leading "≈" — only where the
// one rule (`shouldMarkApprox`, #4165) says the conversion changes the number,
// so USDC in USD carries none. An unknown rate falls back to token mode.

export type BudgetRate = { currency: 'USD' | 'EUR' | 'SEK'; /** Fiat per one token unit. */ perToken: number }

export interface BudgetAmountOptions {
  chainId?: number | null
  /** Absent, or a rate that could not be resolved, renders token mode. */
  rate?: BudgetRate | null
}

function tokenAmount(atomic: string, symbol: string, chainId: number | null | undefined): string {
  // #4333: a `chainId: null` row (the analytics read, which carries the token's
  // SYMBOL only) falls back to the symbol's own decimals — the same table
  // `formatAllowanceForToken` consults — instead of a blind 18. A 1.00 USDC
  // budget divided by 10^18 read "0.00 of 0.00"; divided by 10^6 it reads
  // "0.00 of 1.00". Unknown symbols still fall to 18.
  const decimals = chainId != null ? getTokenDecimals(chainId, symbol) : defaultTokenUnitDecimals(symbol)
  // Always two decimals. The SYMBOL is appended by the phrase that uses the
  // amount — a caption names it once ("1.25 of 5.00 USDC"), a note names it
  // on its own figure ("incl. 1.25 USDC by Helper").
  return formatAllowanceAmount(atomic, decimals ?? 18, {
    symbol,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** Bare fiat — "$1.25", or 4 decimals under a cent ("<0,0001 kr" below 0.00005; 2026-10-22, superseding #3897). An unparseable amount falls back to token mode. */
function fiatValue(atomic: string, symbol: string, rate: BudgetRate, chainId: number | null | undefined): string {
  // Same #4333 fallback as `tokenAmount`: symbol decimals when no chain is given.
  const decimals = chainId != null ? getTokenDecimals(chainId, symbol) : defaultTokenUnitDecimals(symbol)
  // Every token decimal, not the 4-digit display default (#3897): truncating
  // first turned a sub-cent amount into "0" before it was converted, so the
  // caption printed "≈$0.00" where "≈0,0001 kr" is the true figure.
  const decimal = formatAllowanceAmount(atomic, decimals ?? 18, { maximumFractionDigits: decimals ?? 18 })
  const human = Number.parseFloat(decimal)
  if (!Number.isFinite(human)) return tokenAmount(atomic, symbol, chainId)
  return formatFiatDisplay(human * rate.perToken, rate.currency)
}

/** "≈" when the one rule says the conversion changes the number (#4165), else nothing. */
function approxPrefix(symbol: string, chainId: number | null | undefined, rate: BudgetRate): string {
  return shouldMarkApprox({ repriced: true, chainId, tokenSymbol: symbol, displayCurrency: rate.currency, kind: 'total' })
    ? '≈'
    : ''
}

/**
 * One budget amount in the mode `options` selects: token units, or fiat —
 * marked "≈" where the conversion changes the number.
 */
export function budgetAmount(atomic: string, symbol: string, options: BudgetAmountOptions = {}): string {
  const { chainId = null, rate } = options
  return rate
    ? `${approxPrefix(symbol, chainId, rate)}${fiatValue(atomic, symbol, rate, chainId)}`
    : `${tokenAmount(atomic, symbol, chainId)} ${symbol}`.trim()
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
  /**
   * #3922: the server's liveness for the row (`is_live`). `false` means the
   * backend no longer counts it as a live budget — for an active row, past its
   * expiry — and it reads as expired even if this render's clock disagrees.
   * Undefined (analytics, allowance rows) defers to `expiresSec` alone. It is
   * a fetch-time snapshot, so the clock comparison stays: a page left open
   * past `expiresSec` still flips to expired.
   */
  isLive?: boolean | null
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
  /**
   * #3908: `'row'` is the shared agent row's compact meter caption — "1.20
   * of 3.00 USDC · per day · refills in 5h" (token mode since #4165). The bar
   * already shows usage, so "used this period" gives way to the period word.
   * Default `'full'` keeps every other surface's wording.
   */
  style?: 'full' | 'row'
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
  const { nowMs, timeZone, rate, style = 'full' } = options
  const figures = rate
    ? // Currency mode: at most ONE leading "≈" for the caption — the estimate
      // covers the line, not each figure — and only where the one rule says
      // the conversion changes the number (#4165): USDC in USD carries none.
      `${approxPrefix(row.symbol, row.chainId, rate)}${fiatValue(row.usedAtomic ?? '0', row.symbol, rate, row.chainId)} of ${fiatValue(row.budgetAtomic, row.symbol, rate, row.chainId)}`
    : // The dashboard row (#3910) joins the cap and its symbol with a no-break
      // space: its amounts segment may wrap at its own spaces, and "3.00" /
      // "USDC" must not land on separate lines. Other surfaces keep a plain one.
      `${tokenAmount(row.usedAtomic ?? '0', row.symbol, row.chainId)} of ${tokenAmount(row.budgetAtomic, row.symbol, row.chainId)}${style === 'row' ? '\u00a0' : ' '}${row.symbol}`
  const usedLine =
    style === 'row' ? `${figures} · ${budgetPeriodWords(row.periodSeconds)}` : `${figures} used this period`
  const refillMs = nextRefillAt(row.startSec, row.periodSeconds, nowMs)
  const expiresMs = row.expiresSec != null ? row.expiresSec * 1000 : null
  // #4350: the end date is ALWAYS named, as an absolute "ends <date>"
  // segment (the sub-budget formatter, so no surface drifts). When the
  // expiry is the next event it IS the phrase — an absolute date still reads
  // as an expiry at the re-key tie; when a refill comes first, the end date
  // rides after the refill wording, so a daily budget 89 days out reads
  // "refills in 5h · ends 21 Jan 2027" and never a bare "refills" that
  // hides the end. Rows without an expiry (the analytics read) name nothing.
  const endsAt = expiresMs != null ? `ends ${formatSubBudgetDate(row.expiresSec!)}` : null
  // The earlier of the two wins; a tie is the expiry — a re-key carry row's
  // expiry sits AT its period boundary, so it correctly reads as an expiry,
  // never as a refill that will not happen.
  const when =
    expiresMs != null && expiresMs <= refillMs
      ? endsAt!
      : `refills ${formatNextEvent(refillMs, nowMs, timeZone)}${endsAt ? ` · ${endsAt}` : ''}`
  return `${usedLine} · ${when}`
}

function rowIsExpired(row: BudgetCaptionRow, nowMs: number): boolean {
  return row.isLive === false || (row.expiresSec != null && row.expiresSec * 1000 <= nowMs)
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
  if (rowIsExpired(row, nowMs)) return { kind: 'expired', caption: EXPIRED_CAPTION }
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
  /** "+N budgets" — a count the caller renders; the dashboard row appends it
      to the meter's caption line (`· +N budgets`, #3908), which the
      progressbar's ARIA label does not announce. */
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
      !rowIsExpired(r, nowMs) && // expired (#3802; the server's `is_live` too, #3922)
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
