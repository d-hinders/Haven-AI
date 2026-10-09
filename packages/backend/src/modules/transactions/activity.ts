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
 * activityType. Two deliberate extensions to #3824's stated key, both stated
 * here so the PR can carry them:
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
 * they group per local day under the counterparty key `'deposit'`.
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
 */
export const ACTIVITY_WINDOW_DAYS = 7
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

/** `YYYY-MM-DD` of `unixSeconds` in `tz` (en-CA yields ISO calendar dates). */
export function localDayKey(unixSeconds: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(
    new Date(unixSeconds * 1000),
  )
}

/** The user-local days covered by "the last 7 days" ending now. */
function activityWindowDays(nowMs: number, tz: string): Set<string> {
  const days = new Set<string>()
  const nowSeconds = Math.floor(nowMs / 1000)
  for (let i = 0; i < ACTIVITY_WINDOW_DAYS; i += 1) {
    days.add(localDayKey(nowSeconds - i * 86_400, tz))
  }
  return days
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
 * counterparty beyond the day. Outbound x402 rows name the RESOURCE when one
 * was recorded (the sharpest per-payment counterparty identity — two
 * resources at one merchant are two activity rows), else the merchant
 * address. Every other outbound row groups by the far-side address.
 */
function counterpartyKey(tx: EnrichedTransaction): string {
  if (tx.direction === 'in') return 'deposit'
  if (tx.source === 'x402' && tx.x402ResourceUrl) return tx.x402ResourceUrl
  return tx.to.toLowerCase()
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
  /** Contact or receipt-merchant name for the counterparty, when one exists. */
  merchantName: string | null
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
  /** Injectable for tests; defaults to Date.now(). */
  now?: number
  /**
   * Contact/receipt merchant-name resolution, wired by the route (it owns
   * the two repository reads). Null/undefined name → the raw address stands.
   */
  resolveMerchantName?: (address: string) => string | null
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
  } = params

  const windowDays = activityWindowDays(now, tz)
  const groups = new Map<string, GroupAccumulator>()

  for (const tx of transactions) {
    const day = localDayKey(tx.timestamp, tz)
    if (!windowDays.has(day)) continue

    const key = [
      tx.agentId ?? '',
      tx.chainId,
      tx.tokenAddress?.toLowerCase() ?? 'native',
      counterpartyKey(tx),
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
        merchantName:
          sample.direction === 'out'
            ? (resolveMerchantName?.(sample.to) ?? null)
            : null,
        activityType: sample.activityType ?? null,
        direction: sample.direction,
        status: activityOutcome(sample),
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
