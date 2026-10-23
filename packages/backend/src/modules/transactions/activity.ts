/**
 * Server-side grouped dashboard activity (#3824, epic #3801).
 *
 * `GET /dashboard/overview` already builds the full merged feed in memory —
 * explorer rows from `fetchAccountTransactions` (capped at the explorer
 * window, with a `truncated` flag) merged with the synthesized x402 rows —
 * then slices five of them for the preview. The "×40" activity rows the
 * redesigned dashboard needs cannot be built client-side from that slice
 * (the counts would be bounded by whatever window the client happened to
 * load), so the route groups THE SAME FEED here, in memory. This is not a
 * database table and never becomes one.
 *
 * Group key — agent + token + counterparty + user-local day + outcome +
 * activityType, with the sending account inside the counterparty half on
 * outbound rows (#4117, at `counterpartyKey`). Two further deliberate
 * extensions to #3824's stated key, both stated here so the PR can carry
 * them:
 *
 * - **token** (`chainId` + `tokenAddress`, with symbol/decimals): a group
 *   serves ONE `sumAtomic` in ONE `tokenSymbol` at ONE `decimals` — summing
 *   atomic units across tokens would fabricate a number. In practice an
 *   agent's payments to one merchant are one token, so the acceptance shape
 *   (40 same-day payments → one group) is unaffected; a merchant genuinely
 *   paid in two tokens is two rows, which is the honest reading.
 * - **activityType**: a delegate sweep to the same counterparty as a stream
 *   of payments is a different activity class and must not merge into the
 *   ×N ("×40 payments" beside "sweep" — the mockup renders them as separate
 *   rows).
 *
 * `outcome` is derived, not stored — `Transaction.status` is the accounting
 * PUSH status (types.ts) and something else entirely. The mapping, stated
 * for the PR:
 *
 *   1. `isError` → `'failed'` (the chain says the execution failed);
 *   2. else `paymentFlowStatus` `'confirming_merchant'` or
 *      `'needs_attention'` → `'pending'` (money moved, merchant-side
 *      settlement not confirmed / needs a human look);
 *   3. else a `paymentProofStatus` that is present but not a terminal proof
 *      (`protocol_receipt_attached`, `merchant_response_observed`) →
 *      `'pending'`;
 *   4. else → `'confirmed'`.
 *
 * Deposits (inbound rows) have no meaningful agent/merchant counterparty, so
 * they group per local day under the counterparty key `'deposit'` — except a
 * transfer from another of the user's own accounts, keyed `own:<from>` and
 * named by that account (#4099).
 *
 * A move between two of the user's own accounts arrives already folded into
 * its outbound leg (#4268: the route runs #4265's `foldOwnAccountTransfers`
 * before this builder), carrying `ownTransfer`. It groups under
 * `move:<fromAccountId>:<toAccountId>` in place of the counterparty half, so
 * same-day moves between the same two accounts merge into one "×N" row while
 * chain, token, day, outcome and activityType still split it. `own:<from>`
 * stays for an inbound leg that was not folded (its partner leg is missing).
 *
 * When the explorer window that produced the feed was truncated, EVERY group
 * carries `countIsFloor: true` — the count is a floor over an unknown total,
 * and the client renders "×40+". A count is never presented as exact when it
 * isn't.
 */
import { getServeTimeFiatValues } from '../../infra/fiat-values.js'
import {
  DEFAULT_TRANSACTION_CURRENCY,
  type TransactionCurrency,
} from '../../domain/transaction-currency.js'
import type { EnrichedTransaction } from './types.js'
import { ownAccountDisplayName } from './own-account.js'

/** The derived per-group status (#3824) — see the mapping in the module doc. */
export type ActivityOutcome = 'confirmed' | 'pending' | 'failed'

/** The proof statuses that mean "merchant-side evidence is terminal". */
const TERMINAL_PROOF_STATUSES = new Set([
  'protocol_receipt_attached',
  'merchant_response_observed',
])

/**
 * The activity window and group budget. "Up to 8 groups over the last 7
 * days, newest first" — the route feeds this the whole merged feed; the
 * window and the slice bound the response.
 *
 * The window is ROLLING (owner decision, epic #3801, 2026-10-09: "Rolling 7
 * and 30 days; no calendar month"): `[now − 7×24h, now)` on the transaction
 * instant — the same definition the route's `spend.d7` window and
 * `/analytics/overview` use. #3975 moved the card off its original 7
 * user-local calendar days (#3824): the local-day HEADINGS stay (the group
 * key still buckets per `tz` day), but window membership no longer walks
 * local days — a payment is in the card iff it is in the header's 7-day
 * window, so the two can never disagree. Because the rolling window spans
 * one more local day than seven whenever a 23h DST day sits inside it, the
 * oldest day's heading can cover part of a day — the client marks it
 * partial, following the analytics precedent (`docs/product/analytics.md`).
 */
export const ACTIVITY_WINDOW_DAYS = 7
/** The rolling window in milliseconds — `ACTIVITY_WINDOW_DAYS × 24h`. */
export const ACTIVITY_WINDOW_MS = ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000

/**
 * The window's start instant, `now − ACTIVITY_WINDOW_MS`. THE window
 * predicate: the route feeds its `spend.d7` SQL (`from7Iso`) this same
 * derivation off the same `now` it hands the feed, so a confirmed agent
 * payment is inside `spend.d7` IFF it is inside the Activity card — one
 * function, every consumer (#3975).
 */
export function activityWindowStartIso(nowMs: number): string {
  return new Date(nowMs - ACTIVITY_WINDOW_MS).toISOString()
}

/**
 * The window membership predicate: a transaction (unix seconds) is in the
 * Activity card iff it is in the rolling window that ends at `nowMs` — the
 * same `[now − 7×24h, now)` interval `spend.d7` applies to `confirmed_at`.
 * The window's start is INCLUSIVE, its end exclusive; feed rows are never in
 * the future, so the end bound is enforced by the data, not here.
 */
export function isInsideActivityWindow(unixSeconds: number, nowMs: number): boolean {
  return unixSeconds * 1000 >= nowMs - ACTIVITY_WINDOW_MS
}

/** The per-response group cap (#3824). */
export const ACTIVITY_GROUP_LIMIT = 8

/**
 * The analytics route's rule, verbatim in spirit (`analytics-overview.ts`):
 * `Intl.DateTimeFormat`'s constructor accepts far more than IANA names, and
 * Postgres (`AT TIME ZONE`) and JS Date math disagree about offset-string
 * signs — so only a zone from the actual tzdata list constructs a bucketing.
 * 'UTC' is added explicitly because the spec permits implementations to omit
 * it from `supportedValuesOf`.
 */
export function isValidActivityTimeZone(tz: string): boolean {
  return tz === 'UTC' || Intl.supportedValuesOf('timeZone').includes(tz)
}

/**
 * One `en-CA` day-key formatter per zone, cached: `localDayKey` runs once per
 * transaction in `buildActivityGroups`, and the constructor dominates that
 * cost. The map is bounded — the route only accepts zones from
 * `Intl.supportedValuesOf` (or 'UTC'), a fixed list of a few hundred.
 */
const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>()

function dayKeyFormatter(tz: string): Intl.DateTimeFormat {
  let formatter = dayKeyFormatters.get(tz)
  if (formatter == null) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    dayKeyFormatters.set(tz, formatter)
  }
  return formatter
}

/** `YYYY-MM-DD` of `unixSeconds` in `tz` (en-CA yields ISO calendar dates). */
export function localDayKey(unixSeconds: number, tz: string): string {
  return dayKeyFormatter(tz).format(new Date(unixSeconds * 1000))
}

/**
 * The UTC offset `tz` observes at `instantMs`, in milliseconds (positive east
 * of UTC). `formatToParts` reads the zone's own wall clock; the difference to
 * the instant IS the offset.
 */
function zoneOffsetMs(instantMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs))
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return asUtc - instantMs
}

/**
 * The UTC instant of local midnight for `day` (`YYYY-MM-DD`) in `tz`. Found by
 * iterating the zone's offset at the candidate instant: start from the naive
 * UTC parse, subtract the observed offset, repeat. Two rounds converge for
 * every real zone — an offset only changes inside a DST transition, and a
 * transition shifts the guess by at most one hour, which the second round
 * absorbs. (A `Intl`-less library or a `SET TIME ZONE` round-trip is not
 * available here, and this must work for any IANA zone the frontend sends.)
 */
function zonedMidnightMs(day: string, tz: string): number {
  let guess = Date.parse(`${day}T00:00:00Z`)
  for (let i = 0; i < 2; i++) {
    guess = Date.parse(`${day}T00:00:00Z`) - zoneOffsetMs(guess, tz)
  }
  return guess
}

/**
 * Exported for the Period filter's custom-range bounds (`period.ts`): the
 * same iterate-the-offset construction, so a calendar date converts to its
 * zone midnight through DST exactly as `localDayBounds` does (#4095).
 */
export { zonedMidnightMs }

export interface LocalDayBounds {
  /** Inclusive ISO start of the local day. */
  startIso: string
  /** Exclusive ISO end of the local day (the next day's local midnight). */
  endIso: string
}

/**
 * The user-local calendar day containing `nowMs` in `tz`, as a half-open
 * `[startIso, endIso)` instant pair — the bounds the agent stats route passes
 * as SQL parameters (#3977). The end is derived from the START day, not from
 * `nowMs`, so a clock landing exactly on local midnight still yields the full
 * 24h (23h/25h on DST days) rather than a zero-width window.
 */
export function localDayBounds(nowMs: number, tz: string): LocalDayBounds {
  const day = localDayKey(Math.floor(nowMs / 1000), tz)
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  const nextDay = new Date(Date.UTC(year, month - 1, dayOfMonth + 1)).toISOString().slice(0, 10)
  return {
    startIso: new Date(zonedMidnightMs(day, tz)).toISOString(),
    endIso: new Date(zonedMidnightMs(nextDay, tz)).toISOString(),
  }
}

export function activityOutcome(tx: {
  isError: boolean
  paymentFlowStatus?: string | null
  paymentProofStatus?: string | null
}): ActivityOutcome {
  if (tx.isError) return 'failed'
  if (tx.paymentFlowStatus === 'confirming_merchant' || tx.paymentFlowStatus === 'needs_attention') {
    return 'pending'
  }
  if (tx.paymentProofStatus != null && !TERMINAL_PROOF_STATUSES.has(tx.paymentProofStatus)) {
    return 'pending'
  }
  return 'confirmed'
}

/**
 * The counterparty half of the group key. Inbound rows are deposits: no
 * counterparty beyond the day — except a transfer from another of the user's
 * own accounts (#4099), which keys on that account so it can carry its name.
 * Outbound x402 rows name the RESOURCE when one was recorded (the sharpest
 * per-payment counterparty identity — two resources at one merchant are two
 * activity rows), else the merchant address. Every other outbound row groups
 * by the far-side address. Every outbound key also carries the sending
 * account (#4117), so one group has one sender and can name it: without it,
 * two own accounts' unattributed sends to one recipient on one day merged.
 * Inbound rows stay unsplit — their day's deposits are one group whichever
 * account received them. A folded own-account move (#4268) keys on its two
 * accounts, `move:<from>:<to>`: it is neither a send to a counterparty nor a
 * deposit.
 */
function counterpartyKey(tx: EnrichedTransaction, fromOwnAccount: boolean): string {
  if (tx.ownTransfer) return `move:${tx.accountId}:${tx.ownTransfer.toAccountId}`
  if (tx.direction === 'in') return fromOwnAccount ? `own:${tx.from.toLowerCase()}` : 'deposit'
  const counterparty =
    tx.source === 'x402' && tx.x402ResourceUrl ? tx.x402ResourceUrl : tx.to.toLowerCase()
  return `out:${tx.accountId}:${counterparty}`
}

/**
 * The wire shape. `activityType` / `agentId` / `agentName` / the counterparty
 * raw fields come from the group's NEWEST member; `status` is the derived
 * outcome. The fiat pair is either book-time (every member converted) or
 * serve-time (`approx*`), never both — see the module doc.
 */
export interface DashboardActivityGroup {
  count: number
  /** Present ONLY when the explorer window was truncated: the count is a floor. */
  countIsFloor?: boolean
  sumAtomic: string
  tokenSymbol: string
  decimals: number
  /** ISO 8601 instant of the newest member's `timestamp`. */
  latestAt: string
  agentId: string | null
  agentName: string | null
  source: string | null
  x402ResourceUrl: string | null
  to: string
  /**
   * Contact or receipt-merchant name for the counterparty, else the name of
   * the user's own account on the other side of a transfer between two of
   * their accounts (#4099) — the receiving account on the sender's row, the
   * sending account on the receiver's; null otherwise. Null on every other
   * deposit.
   */
  merchantName: string | null
  /**
   * #4117: the label of the user's own account the group's money LEFT — a
   * contact name saved for it first, the account's own name otherwise (the
   * order the receiving side's "From <account>" uses). Outbound groups only;
   * absent on deposits and when no name resolves.
   */
  fromAccountName?: string
  /**
   * #4268: present only on a move between two of the user's own accounts,
   * folded into one group (#4265's fold). The two accounts' own Haven names,
   * "Unnamed account" when an account has none — never an address. The group
   * keeps `direction: 'out'`, `merchantName` and `fromAccountName` as an
   * unfolded send would, so a client that predates the field still renders a
   * readable out row.
   */
  ownTransfer?: { fromAccountName: string; toAccountName: string }
  activityType: string | null
  direction: 'in' | 'out'
  status: ActivityOutcome
  convertedAmount?: string
  convertedCurrency?: TransactionCurrency
  approxAmount?: string | null
  approxCurrency?: TransactionCurrency
}

export interface BuildActivityGroupsParams {
  /** The full merged, deduped, agent-enriched feed — the same list the preview slices. */
  transactions: EnrichedTransaction[]
  /** True when any account's explorer read was capped: every count is a floor. */
  truncated: boolean
  /** IANA zone — the caller validated it (`isValidActivityTimeZone`). */
  tz: string
  /** The user's preferred currency; the serve-time pricing denominator. */
  currency?: TransactionCurrency
  /** Injectable; the route passes its own `now` so every 7-day window — the
   * spend SQL's and this feed's — derives from ONE instant. Defaults to
   * Date.now(). */
  now?: number
  /**
   * Contact/receipt merchant-name resolution, wired by the route (it owns
   * the two repository reads). Null/undefined name → the raw address stands.
   */
  resolveMerchantName?: (address: string) => string | null
  /**
   * #4099: the name of one of the user's OWN accounts at `address` on
   * `chainId` (`ownAccountNameResolver`), or null. Names both sides of a
   * transfer between two own accounts: the sender's row by the receiving
   * account, the receiver's row by the sending one. The receiving side keys
   * its own group (`counterpartyKey`), so it never merges into — or renames —
   * the day's other deposits; the client's no-address inbound label reads
   * `merchantName` before "Deposit" (#4099 frontend half).
   */
  resolveOwnAccountName?: (address: string, chainId: number) => string | null
}

/**
 * #4099: own-account name lookup — the export route's rule
 * (`routes/transactions.ts`): the address is case-insensitive, the chain is
 * not, because an account exists only on the chain it was created on.
 */
export function ownAccountNameResolver(
  accounts: ReadonlyArray<{ account_address: string; chain_id: number; name: string | null }>,
): (address: string, chainId: number) => string | null {
  const names = new Map<string, string>()
  for (const account of accounts) {
    if (account.name) names.set(`${account.account_address.toLowerCase()}:${account.chain_id}`, account.name)
  }
  return (address, chainId) => names.get(`${address.toLowerCase()}:${chainId}`) ?? null
}

interface GroupAccumulator {
  count: number
  sumAtomic: bigint
  sumHuman: number
  latestTs: number
  /** The newest member so far — the sample the wire fields read from. */
  sample: EnrichedTransaction
  /** Members kept for the fiat decision (book-time coverage). */
  members: EnrichedTransaction[]
}

function toAtomicSum(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

export async function buildActivityGroups(
  params: BuildActivityGroupsParams,
): Promise<DashboardActivityGroup[]> {
  const {
    transactions,
    truncated,
    tz,
    currency = DEFAULT_TRANSACTION_CURRENCY,
    now = Date.now(),
    resolveMerchantName,
    resolveOwnAccountName,
  } = params

  /**
   * The sending own account's label on an inbound row, when the sender is one
   * of the user's own accounts (#4099) — a contact name the user saved for it
   * first, the account's own name otherwise, the same order the send side
   * uses. Null for every other inbound row: those stay unnamed deposits.
   */
  const ownSenderName = (tx: EnrichedTransaction): string | null => {
    if (tx.direction !== 'in') return null
    const ownName = resolveOwnAccountName?.(tx.from, tx.chainId) ?? null
    return ownName === null ? null : (resolveMerchantName?.(tx.from) ?? ownName)
  }

  // One instant comparison, no tz: the rolling window `[now − 168h, now)` is
  // the same predicate the route's `spend.d7` SQL applies to `confirmed_at`
  // (`isInsideActivityWindow`), so the header and the card can never
  // disagree (#3975). The local-day key still buckets the groups.
  const groups = new Map<string, GroupAccumulator>()

  for (const tx of transactions) {
    if (!isInsideActivityWindow(tx.timestamp, now)) continue
    const day = localDayKey(tx.timestamp, tz)

    const key = [
      tx.agentId ?? '',
      tx.chainId,
      tx.tokenAddress?.toLowerCase() ?? 'native',
      counterpartyKey(tx, ownSenderName(tx) !== null),
      day,
      activityOutcome(tx),
      tx.activityType ?? '',
    ].join('\u0000')

    let group = groups.get(key)
    if (!group) {
      group = { count: 0, sumAtomic: 0n, sumHuman: 0, latestTs: 0, sample: tx, members: [] }
      groups.set(key, group)
    }
    group.count += 1
    group.sumAtomic += toAtomicSum(tx.value)
    group.sumHuman += Number(tx.valueFormatted) || 0
    if (tx.timestamp > group.latestTs) {
      group.latestTs = tx.timestamp
      group.sample = tx
    }
    group.members.push(tx)
  }

  const ordered = Array.from(groups.values()).sort((a, b) => b.latestTs - a.latestTs)

  return Promise.all(
    ordered.slice(0, ACTIVITY_GROUP_LIMIT).map(async (group) => {
      const { sample } = group
      const wire: DashboardActivityGroup = {
        count: group.count,
        sumAtomic: group.sumAtomic.toString(),
        tokenSymbol: sample.tokenSymbol ?? sample.asset,
        decimals: sample.decimals,
        latestAt: new Date(group.latestTs * 1000).toISOString(),
        agentId: sample.agentId ?? null,
        agentName: sample.agentName ?? null,
        source: sample.source ?? null,
        x402ResourceUrl: sample.x402ResourceUrl ?? null,
        to: sample.to,
        // Contacts and receipts first, then the user's own accounts (#4099)
        // — the export's order. A deposit is named only when it came from
        // another own account; its group holds that sender alone.
        merchantName:
          sample.direction === 'out'
            ? (resolveMerchantName?.(sample.to) ??
              resolveOwnAccountName?.(sample.to, sample.chainId) ??
              null)
            : ownSenderName(sample),
        activityType: sample.activityType ?? null,
        direction: sample.direction,
        status: activityOutcome(sample),
      }

      // #4117: the outbound key carries the sending account, so every member
      // left the same one and the sample names it. A contact saved for that
      // account is what the first lookup is for — the route prefetches
      // receipt names for outbound `to` addresses only, so a receipt name
      // applies here only incidentally.
      if (sample.direction === 'out') {
        const fromAccountName =
          resolveMerchantName?.(sample.accountAddress) ?? (sample.accountName || null)
        if (fromAccountName) wire.fromAccountName = fromAccountName
      }

      // #4268: the move key holds one (from, to) pair, so the sample names
      // both ends. Each end is the account's own name (#4265's rule), not a
      // contact label: the row reads as a move between the user's accounts.
      if (sample.ownTransfer) {
        wire.ownTransfer = {
          fromAccountName: ownAccountDisplayName(sample.accountName),
          toAccountName: sample.ownTransfer.toAccountName,
        }
      }

      // Fiat sum: book-time when EVERY member converted (they were all struck
      // in the user's preferred currency by enrichment, so the currency is
      // that one); otherwise a serve-time approx over the token total. A
      // group is one token by construction (the key), so the pricing read is
      // one call per group.
      const allConverted =
        group.members.length > 0 &&
        group.members.every((tx) => tx.convertedAmount != null)
      if (allConverted) {
        wire.convertedAmount = group.members
          .reduce((sum, tx) => sum + Number(tx.convertedAmount), 0)
          .toFixed(4)
        wire.convertedCurrency = currency
      } else {
        const values = await getServeTimeFiatValues(
          sample.tokenSymbol ?? sample.asset,
          group.sumHuman.toString(),
        )
        const approx = values[currency.toLowerCase() as 'usd' | 'eur' | 'sek']
        wire.approxCurrency = currency
        wire.approxAmount = approx == null ? null : approx.toFixed(4)
      }

      if (truncated) {
        wire.countIsFloor = true
      }
      return wire
    }),
  )
}

/**
 * The overview's whole activity payload (#3944): the grouped rows BESIDE the
 * two empty-state facts the card needs but cannot derive from the rows.
 *
 * `hasOlderActivity` is true when the feed carries any transaction OUTSIDE
 * the rolling 7-day window — activity exists, just not in the window, so the
 * empty state may not say "No activity yet". The flag reads from the SAME
 * feed the groups bucket (an explorer-read failure degrades it to false, the
 * same posture as the rows), and applies the SAME instant predicate
 * `buildActivityGroups` runs — identical inputs, so the flag can never
 * disagree with the rows.
 *
 * `windowDays` rides the wire so the client can NAME the window ("No
 * activity in the last N days") without hard-coding a 7 that would drift
 * from `ACTIVITY_WINDOW_DAYS` — the dashboard has no window constant of its
 * own, and #3944's rule is that the copy may not invent one.
 *
 * `windowStartIso` rides the wire too (#3975): the instant the rolling
 * window starts. The client marks the oldest day heading partial when the
 * window start cuts its own local day — the analytics precedent, computed
 * from the boundary instant rather than re-derived from a second clock.
 */
export interface ActivityFeed {
  groups: DashboardActivityGroup[]
  hasOlderActivity: boolean
  windowDays: number
  windowStartIso: string
}

export async function buildActivityFeed(
  params: BuildActivityGroupsParams,
): Promise<ActivityFeed> {
  const now = params.now ?? Date.now()
  const groups = await buildActivityGroups({ ...params, now })
  const hasOlderActivity = params.transactions.some(
    (tx) => !isInsideActivityWindow(tx.timestamp, now),
  )
  return {
    groups,
    hasOlderActivity,
    windowDays: ACTIVITY_WINDOW_DAYS,
    windowStartIso: activityWindowStartIso(now),
  }
}
