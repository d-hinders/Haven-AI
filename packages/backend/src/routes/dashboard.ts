import { FastifyInstance, FastifyRequest } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { getChainData, shouldMarkApprox, tokenPeg } from '@haven_ai/core'
import {
  countFailedIntents7d,
  findFirstAgentPayment,
  findPortfolioSnapshots,
  hasFirstAgentPayment,
  insertPortfolioSnapshot,
  listAgentLastPayments,
  listDashboardAgents,
  listDashboardAccounts,
  listDashboardMerchants,
  listDashboardSinceGroups,
  listDashboardSpendGroups,
  listLatestEndedBudgetByAgent,
  listPendingAgentSetupStatuses,
  listReceivedSubBudgetsForAgents,
  listRefusalBucketsByAgent,
  type DashboardAllowanceRow,
  type DashboardSpendGroupRow,
  type RefusalBucketRow,
} from '../infra/repositories/dashboard.js'
import { listBalanceByDayForUser, listReceiptMerchantNamesForUser } from '../infra/repositories/analytics.js'
import { listContactsForUser } from '../infra/repositories/contacts.js'
import { getTokenPrice } from '../infra/prices.js'
import { currentPeriodBounds } from '../infra/chain/delegation-budget-reader.js'
import { deriveDelegationAllowances, deriveDelegationBudgets } from '../rails/delegation-budget-view.js'
import {
  combineBalanceFreshness,
  fetchPortfolioForAccount,
  isPortfolioUnpriceable,
  needsBackupSignerRecommendation,
} from '../modules/accounts/index.js'
import {
  activityWindowStartIso,
  buildActivityFeed,
  ownAccountNameResolver,
  compareTransactions,
  isValidActivityTimeZone,
  sinceTimeWord,
  type EnrichedTransaction,
  enrichedTransactionIdentityKey,
  enrichTransactionsWithAgents,
  foldOwnAccountTransfers,
  fetchAccountTransactions,
  mergeX402Transactions,
  resolveTransactionCurrency,
} from '../modules/transactions/index.js'

// ── #3803: the 7/30-day spend block ──────────────────────────────────────────

/** One window's figures. Fiat buckets are USD/EUR/SEK booked-or-netted sums. */
export interface SpendWindowFigures {
  grossUsd: number
  netUsd: number
  grossEur: number
  netEur: number
  grossSek: number
  netSek: number
  /** True when any row's booked fiat was NULL and got priced at today's rate (owner decision 1). */
  approx: boolean
  /**
   * #4165: the "≈" decision per fiat bucket — `shouldMarkApprox`, the one
   * rule: a re-priced row whose conversion changes the number in that
   * currency. USDC re-priced into USD is dollars and never sets `usd`.
   */
  approxByCurrency: FiatFlags
  /** #4165: a row needed today's rate in that bucket and had none — it is not in the sum. */
  unpricedByCurrency: FiatFlags
  payments: number
}

interface FiatFlags {
  usd: boolean
  eur: boolean
  sek: boolean
}

// ── #4707: the first agent payment, named ────────────────────────────────────

/**
 * `GET /dashboard/first-agent-payment` — the one payment the first-agent-payment
 * card names, or `null`.
 *
 * A separate route rather than an overview field: the overview polls every
 * 10 s, `onboardingProgress` is `additionalProperties: false`, and no
 * `payment_intents` index includes `user_id`. This read is asked for only
 * while `hasFirstAgentPayment` is true and the card is not dismissed, and it
 * stops as soon as a row comes back.
 *
 * `null` is a real answer, not an error: the user's only confirmed payment may
 * still be awaiting its merchant leg (see `FIND_FIRST_AGENT_PAYMENT_SQL`), and
 * the client renders nothing rather than a weaker claim.
 */
export interface FirstAgentPaymentResponse {
  payment: {
    id: string
    /** The agent's name — the card's heading. */
    agentName: string
    /** The token amount as stored; the card's figure when fiat would read $0.00. */
    amountHuman: string
    amountRaw: string | null
    tokenSymbol: string
    chainId: number
    /** ISO instant the funding leg confirmed — the card's "just now" / date. */
    confirmedAt: string
    /** Booked fiat at settle time, in each bucket; null when never priced. */
    usdValue: number | null
    eurValue: number | null
    sekValue: number | null
    /**
     * Contact name, else receipt-merchant name, for the counterparty. Null when
     * neither exists — the client then falls back to the x402 resource host and
     * renders no name at all rather than an address (#3810 rule 4).
     */
    merchantName: string | null
    /** The x402 resource URL, whose HOST is the last displayable name. */
    x402ResourceUrl: string | null
  } | null
}

export function emptySpendWindow(): SpendWindowFigures {
  return {
    grossUsd: 0,
    netUsd: 0,
    grossEur: 0,
    netEur: 0,
    grossSek: 0,
    netSek: 0,
    approx: false,
    approxByCurrency: { usd: false, eur: false, sek: false },
    unpricedByCurrency: { usd: false, eur: false, sek: false },
    payments: 0,
  }
}

/** A token's spot rates in the three fiat buckets; `null` bucket = no usable quote. */
export interface TokenRates {
  usd: number | null
  eur: number | null
  sek: number | null
}

/** A spend group's token, as the "≈" rule needs it, and its spot rates. */
export interface GroupPricing {
  symbol: string | null
  rates: TokenRates | null
}

/**
 * The chain registry's token identity for a (chain, token address) pair, or
 * `null` when the registry does not know it. Module scope since #4709: the
 * overview and the "since your last visit" read price their groups the same
 * way, and a second copy of this lookup is how the two would drift.
 */
function chainToken(
  chainKey: number,
  tokenKey: string,
): { symbol: string; decimals: number } | null {
  try {
    return (
      getChainData(chainKey).tokens.find(
        (t) => t.address !== null && t.address.toLowerCase() === tokenKey.toLowerCase(),
      ) ?? null
    )
  } catch {
    return null
  }
}

/**
 * Today's spot rates for a set of symbols. One `getTokenPrice` call per symbol
 * (shared 60 s CoinGecko cache); a failed read or a zero quote is `null` — the
 * wire distinguishes "no rate" from a 0 rate (owner decision 1: a
 * NULL-booked-fiat row is priced at today's rate and the total is marked ≈, so
 * a rate must never silently undercount).
 */
async function loadTokenRates(symbols: Iterable<string>): Promise<Map<string, TokenRates | null>> {
  const rateBySymbol = new Map<string, TokenRates | null>()
  for (const symbol of symbols) {
    if (!rateBySymbol.has(symbol)) rateBySymbol.set(symbol, null)
  }
  for (const symbol of rateBySymbol.keys()) {
    try {
      const price = await getTokenPrice(symbol)
      const pick = (value: number): number | null => (value > 0 ? value : null)
      rateBySymbol.set(symbol, { usd: pick(price.usd), eur: pick(price.eur), sek: pick(price.sek) })
    } catch {
      rateBySymbol.set(symbol, null)
    }
  }
  return rateBySymbol
}

/** The per-(chain, token) pricing map `accumulateWindow` reads. */
function groupPricing(
  groups: Array<{ chain_key: number; token_key: string }>,
  rateBySymbol: Map<string, TokenRates | null>,
): Map<string, GroupPricing> {
  const rates = new Map<string, GroupPricing>()
  for (const group of groups) {
    const symbol = chainToken(group.chain_key, group.token_key)?.symbol ?? null
    rates.set(`${group.chain_key}:${group.token_key}`, {
      symbol,
      rates: symbol ? (rateBySymbol.get(symbol) ?? null) : null,
    })
  }
  return rates
}

/**
 * The registry's own testnet marker (testnets only, #2534). Module scope since
 * #4709: the spend scope and the per-account wire flag read the same fact.
 */
function isChainTestnet(chainId: number): boolean {
  try {
    return getChainData(chainId).faucetUrl !== undefined
  } catch {
    return false
  }
}

/**
 * Testnet scope (owner decision 3): the figures cover mainnet accounts only
 * whenever the user has one; a testnet-only user sees test totals. One
 * derivation for every spend consumer — the overview's 7/30-day block and
 * #4709's "since your last visit" read the same `spend.scope`.
 */
export function spendScopeForAccounts(accounts: Array<{ chain_id: number }>): {
  scope: 'mainnet' | 'testnet'
  chainIds: number[]
} {
  const mainnetChainIds = [
    ...new Set(accounts.filter((account) => !isChainTestnet(account.chain_id)).map((a) => a.chain_id)),
  ]
  const allChainIds = [...new Set(accounts.map((a) => a.chain_id))]
  return {
    scope: mainnetChainIds.length > 0 ? 'mainnet' : 'testnet',
    chainIds: mainnetChainIds.length > 0 ? mainnetChainIds : allChainIds,
  }
}

function emptyRefusalBuckets(): {
  budget: number
  expired: number
  scope: number
  failed: number
  haven: number
} {
  return { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 }
}

/**
 * #4324: the 7-day window's latest refusal time per bucket, keyed as the
 * wire names it — only the buckets that have one. An acknowledged "Needs
 * attention" item re-arms when its bucket's time is after the
 * acknowledgement; an absent key never hides anything (#3295).
 */
export function latestRefusalTimes(row: RefusalBucketRow | undefined): {
  lastBudgetAt?: string
  lastExpiredAt?: string
  lastScopeAt?: string
  lastFailedAt?: string
  lastHavenAt?: string
} {
  if (!row) return {}
  const iso = (value: Date | null) => (value ? new Date(value).toISOString() : undefined)
  const pairs = [
    ['lastBudgetAt', iso(row.last_budget_7)],
    ['lastExpiredAt', iso(row.last_expired_7)],
    ['lastScopeAt', iso(row.last_scope_7)],
    ['lastFailedAt', iso(row.last_failed_7)],
    ['lastHavenAt', iso(row.last_haven_7)],
  ] as const
  return Object.fromEntries(pairs.filter(([, value]) => value !== undefined))
}

/**
 * The window columns every spend statement emits, suffix-free. `accumulateGroup`
 * adapts the 7/30-day rows to this shape; the "since your last visit" statement
 * (#4709) emits it directly, so the pricing fold below has ONE implementation
 * rather than a fourth copy of the netting/pricing rules.
 */
export interface SpendWindowColumns {
  gross_usd: string
  net_usd: string
  gross_eur: string
  net_eur: string
  gross_sek: string
  net_sek: string
  fb_usd: string
  fb_eur: string
  fb_sek: string
  payments: string
}

/**
 * Folds one spend GROUP's window columns into a window accumulator. `fb*` is
 * the token amount of rows whose booked fiat was NULL — priced at TODAY's rate
 * here (owner decision 1) and added to the same bucket. `approx` records that a
 * re-pricing happened; the display mark is `approxByCurrency`, which the one
 * rule sets only where the conversion changes the number (#4165), and a
 * bucket with no rate sets `unpricedByCurrency` instead of adding anything.
 * Exported for its unit test (`dashboard-spend-window.test.ts`): a pure fold.
 */
export function accumulateWindow(
  target: SpendWindowFigures,
  row: SpendWindowColumns,
  chainKey: number,
  tokenKey: string,
  pricing: Map<string, GroupPricing>,
): void {
  target.grossUsd += Number(row.gross_usd ?? '0')
  target.netUsd += Number(row.net_usd ?? '0')
  target.grossEur += Number(row.gross_eur ?? '0')
  target.netEur += Number(row.net_eur ?? '0')
  target.grossSek += Number(row.gross_sek ?? '0')
  target.netSek += Number(row.net_sek ?? '0')
  target.payments += Number(row.payments ?? '0')

  // String-concat, not a template literal: the route-module inventory regex
  // reads any `x.get(` followed by a quoted string as a Fastify registration,
  // and a backtick here fabricated a `GET /dashboard${chain}:${token}` route
  // in `route-modules.generated.ts` (#3803 round-2).
  const groupPricing = pricing.get(chainKey + ':' + tokenKey)
  const rate = groupPricing?.rates ?? null
  // #4288: a token PEGGED to the bucket's currency is that currency — the
  // registry's `tokenPeg` is a fact, so a NULL-booked USDC row re-prices at
  // exactly 1.0 in the USD bucket, not at CoinGecko's ≈0.9998 `usd` quote,
  // and a missing quote no longer marks a peg it could have priced. A float
  // (ETH, anything unknown) still uses the market rate, or nothing.
  const peg = tokenPeg(chainKey, groupPricing?.symbol ?? null)
  const buckets = [
    { key: 'usd', currency: 'USD', grossKey: 'grossUsd', netKey: 'netUsd' },
    { key: 'eur', currency: 'EUR', grossKey: 'grossEur', netKey: 'netEur' },
    { key: 'sek', currency: 'SEK', grossKey: 'grossSek', netKey: 'netSek' },
  ] as const
  for (const bucket of buckets) {
    const fallback = Number(row[`fb_${bucket.key}`] ?? '0')
    if (fallback <= 0) continue
    target.approx = true
    const perToken = peg === bucket.currency ? 1.0 : (rate?.[bucket.key] ?? null)
    if (perToken == null) {
      // #4165: no rate means no figure — the row is left out of the sum and
      // the bucket says so, never a "≈" standing in for "couldn't price".
      target.unpricedByCurrency[bucket.key] = true
      continue
    }
    target[bucket.grossKey] += fallback * perToken
    target[bucket.netKey] += fallback * perToken
    if (
      shouldMarkApprox({
        repriced: true,
        chainId: chainKey,
        tokenSymbol: groupPricing?.symbol ?? null,
        displayCurrency: bucket.currency,
        kind: 'total',
      })
    ) {
      target.approxByCurrency[bucket.key] = true
    }
  }
}

/**
 * Folds a 7/30-day spend GROUP into a window accumulator — the suffix adapter
 * over `accumulateWindow`, kept so the existing call sites and their unit test
 * read unchanged.
 */
export function accumulateGroup(
  target: SpendWindowFigures,
  group: DashboardSpendGroupRow,
  suffix: '7' | '30',
  pricing: Map<string, GroupPricing>,
): void {
  accumulateWindow(
    target,
    {
      gross_usd: group[`gross_usd_${suffix}`],
      net_usd: group[`net_usd_${suffix}`],
      gross_eur: group[`gross_eur_${suffix}`],
      net_eur: group[`net_eur_${suffix}`],
      gross_sek: group[`gross_sek_${suffix}`],
      net_sek: group[`net_sek_${suffix}`],
      fb_usd: group[`fb_usd_${suffix}`],
      fb_eur: group[`fb_eur_${suffix}`],
      fb_sek: group[`fb_sek_${suffix}`],
      payments: group[`payments_${suffix}`],
    },
    group.chain_key,
    group.token_key,
    pricing,
  )
}

function accumulateRefusalRow(target: ReturnType<typeof emptyRefusalBuckets>, row: RefusalBucketRow, suffix: '7' | '30'): void {
  target.budget += Number(row[`budget_${suffix}`] ?? '0')
  target.expired += Number(row[`expired_${suffix}`] ?? '0')
  target.scope += Number(row[`scope_${suffix}`] ?? '0')
  target.failed += Number(row[`failed_${suffix}`] ?? '0')
  target.haven += Number(row[`haven_${suffix}`] ?? '0')
}

/**
 * #4353: the wire `budgetEndedAt` — ISO of the unix-second expiry, or `null`
 * when there is none, it is unrepresentable, or it is NOT in the past (a live
 * budget is never "ended", whatever the read returned).
 */
export function budgetEndedAtIso(endedAtSec: string | undefined, now: Date): string | null {
  if (endedAtSec === undefined) return null
  const sec = Number(endedAtSec)
  if (!Number.isFinite(sec) || sec <= 0 || sec * 1000 > 8.64e15) return null
  if (sec * 1000 > now.getTime()) return null
  return new Date(sec * 1000).toISOString()
}

function getSnapshotDate(offsetDays = 0): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

function computePercentChange(current: number, previous: number): number {
  if (previous === 0) {
    return 0
  }
  return ((current - previous) / previous) * 100
}

export default async function dashboardRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Querystring: { tz?: string } }>('/overview', async (request, reply) => {
    const { sub } = request.user as { sub: string }

    // #3824: the activity groups bucket by the USER's local day, so the
    // caller names the zone. Validated exactly as analytics validates its
    // `tz` — an invalid zone is a 400, before any read. Default UTC, same as
    // analytics (`analytics-overview.ts`).
    const tz = request.query.tz ?? 'UTC'
    if (!isValidActivityTimeZone(tz)) {
      // Never echo the raw query value: an offset/abbreviation reflected
      // verbatim into a 400 body is exactly the instrument analytics refuses
      // to be (same wording and reasoning as its handler).
      return reply.code(400).send({ error: 'unsupported tz' })
    }

    const [
      accounts,
      agents,
      firstAgentPayment,
    ] = await Promise.all([
      listDashboardAccounts(sub),
      listDashboardAgents(sub),
      hasFirstAgentPayment(sub),
    ])
    // #2055: structurally zero — the approval queue died with the
    // AllowanceModule rail; both wire fields survive for compatibility.
    const actionableApprovals = 0

    // Delegation-rail agents: the live budget is the active delegation set
    // (#1090). Legacy-rail agents get no allowance entries — the Safe rail is
    // retired (#1440/#2020) and `agent_allowances` is no longer read.
    const allowancesByAgent = new Map<string, DashboardAllowanceRow[]>()
    const delegationAgentIds = agents
      .filter((agent) => agent.account_type === 'delegator_hybrid')
      .map((agent) => agent.id)
    const derivedByAgent = await deriveDelegationAllowances(delegationAgentIds)
    for (const agentId of delegationAgentIds) {
      allowancesByAgent.set(agentId, derivedByAgent.get(agentId) ?? [])
    }

    const currentPortfolio = await Promise.all(
      accounts.map((account) => fetchPortfolioForAccount(account.chain_id, account.account_address)),
    )

    // ── #3803: the redesigned dashboard's data ────────────────────────────
    //
    // The richer budget view beside the frozen six-field `allowances`
    // projection, the received sub-budgets, and the pending agents' setup
    // state. Expired budgets drop out via #3802's live-window predicate on
    // `listActiveDelegations` (this slice depends on that merge).
    const budgetsByAgent = await deriveDelegationBudgets(delegationAgentIds)
    const receivedSubBudgets = await listReceivedSubBudgetsForAgents(sub, delegationAgentIds)
    const pendingAgentIds = agents
      .filter((agent) => agent.status === 'pending_approval')
      .map((agent) => agent.id)
    const setupStatuses = await listPendingAgentSetupStatuses(sub, pendingAgentIds)

    const now = new Date()
    const toIso = now.toISOString()
    // THE window predicate (#3975): one derivation for every 7-day consumer —
    // the `spend.d7` SQL below, the Activity feed filter and the wire's
    // `activityWindowStart` all read this instant, so a confirmed agent
    // payment is inside `spend.d7` iff it is inside the Activity card.
    const from7Iso = activityWindowStartIso(now.getTime())
    const from30Iso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

    // Testnet scope (owner decision 3): the figures cover mainnet accounts
    // only whenever the user has one; a testnet-only user sees test totals.
    const { scope: spendScope, chainIds: scopeChainIds } = spendScopeForAccounts(accounts)

    const [
      spendGroups,
      merchants,
      refusalBuckets,
      failedIntentsRead,
      lastPayments,
      contacts,
      balanceByDayRows,
      endedBudgetByAgent,
    ] = await Promise.all([
      listDashboardSpendGroups(sub, scopeChainIds, from30Iso, from7Iso, toIso),
      listDashboardMerchants(sub, scopeChainIds, from30Iso, from7Iso, toIso),
      listRefusalBucketsByAgent(sub, scopeChainIds, from30Iso, from7Iso, toIso),
      countFailedIntents7d(sub, scopeChainIds, from7Iso, toIso),
      listAgentLastPayments(sub),
      listContactsForUser(sub),
      listBalanceByDayForUser(sub, { from: getSnapshotDate(-30), to: getSnapshotDate(0) }),
      listLatestEndedBudgetByAgent(delegationAgentIds),
    ])
    // One preference read per request — the same resolved currency the
    // transaction enrichment below receives (#3127).
    const currency = await resolveTransactionCurrency(sub)

    // Token identity + today's spot rates. One `getTokenPrice` call per
    // symbol (shared 60 s CoinGecko cache); a failed read or a zero quote is
    // `null` — the wire distinguishes "no rate" from a 0 rate (owner decision
    // 1: a NULL-booked-fiat row is priced at today's rate and the total is
    // marked ≈, so a rate must never silently undercount).
    const symbols = new Set<string>()
    for (const group of spendGroups) {
      const symbol = chainToken(group.chain_key, group.token_key)?.symbol
      if (symbol) symbols.add(symbol)
    }
    for (const budgets of budgetsByAgent.values()) {
      for (const budget of budgets) symbols.add(budget.token_symbol)
    }
    const rateBySymbol = await loadTokenRates(symbols)
    const rates = groupPricing(spendGroups, rateBySymbol)
    // spotRates: the BUDGET tokens only — the caption-currency rates the
    // client has no other way to get.
    const curKey = currency.toLowerCase() as 'usd' | 'eur' | 'sek'
    const spotRates: Record<string, number | null> = {}
    for (const budgets of budgetsByAgent.values()) {
      for (const budget of budgets) {
        if (budget.token_symbol in spotRates) continue
        spotRates[budget.token_symbol] = rateBySymbol.get(budget.token_symbol)?.[curKey] ?? null
      }
    }

    const d7 = emptySpendWindow()
    const d30 = emptySpendWindow()
    for (const group of spendGroups) {
      accumulateGroup(d7, group, '7', rates)
      accumulateGroup(d30, group, '30', rates)
    }
    const refusalsByAgent = new Map(refusalBuckets.map((row) => [row.agent_id, row]))
    // The user-level `budgetStops` stays COMBINED (#4353): the per-agent
    // `budget` bucket now counts delegation_budget_exceeded only and `expired`
    // counts delegation_expired, so a budget stop is their sum.
    const budgetStops7 = refusalBuckets.reduce(
      (sum, row) => sum + Number(row.budget_7 ?? '0') + Number(row.expired_7 ?? '0'),
      0,
    )
    const budgetStops30 = refusalBuckets.reduce(
      (sum, row) => sum + Number(row.budget_30 ?? '0') + Number(row.expired_30 ?? '0'),
      0,
    )

    // Counterparty names: contacts win, then merchant receipts (analytics'
    // label order) — but only as `merchantName` beside the raw fields.
    const merchantNames = new Map(contacts.map((c) => [c.address.toLowerCase(), c.name]))
    const labelAddresses = [
      ...new Set(
        [merchants.top_merchant_address, ...lastPayments.map((r) => r.merchant_address)].filter(
          (a): a is string => a != null,
        ),
      ),
    ]
    const receiptNames =
      labelAddresses.length > 0
        ? await listReceiptMerchantNamesForUser(sub, labelAddresses)
        : new Map<string, string>()
    const merchantNameFor = (address: string | null): string | null => {
      if (!address) return null
      const key = address.toLowerCase()
      return merchantNames.get(key) ?? receiptNames.get(key) ?? null
    }

    const topMerchant7d = merchants.top_merchant_key
      ? {
          key: merchants.top_merchant_key,
          x402ResourceUrl: merchants.top_merchant_url,
          to: merchants.top_merchant_to,
          merchantName: merchantNameFor(merchants.top_merchant_address),
        }
      : null

    const balanceByDay = balanceByDayRows.map((row) => ({
      snapshotDate: row.snapshot_date,
      totalUsd: Number(row.total_usd),
      totalEur: Number(row.total_eur),
      totalSek: row.total_sek == null ? null : Number(row.total_sek),
    }))

    // Per-account USDC: balance/freshness/funding from the portfolio the
    // route already fetched (no new chain reads), pace from the spend
    // groups restricted to the registry-USDC (chain, token) pair and the
    // agents whose `account_id` IS this account.
    const agentAccountById = new Map(agents.map((a) => [a.id, a.account_id]))
    const accountBlocks = accounts.map((account, index) => {
      const portfolio = currentPortfolio[index]
      const usdcToken = (() => {
        try {
          return getChainData(account.chain_id).tokens.find((t) => t.symbol === 'USDC') ?? null
        } catch {
          return null
        }
      })()
      const usdcItem = (portfolio.breakdown ?? []).find((item) => item.symbol === 'USDC') ?? null
      // `unavailable` freshness = the read never succeeded: the balance is
      // UNKNOWN — null, never 0. No registry USDC (or no item) is the same
      // unknown, and `funded` follows it rather than reading a zero.
      const usdcKnown =
        usdcToken != null && usdcItem != null && usdcItem.balanceFreshness?.status !== 'unavailable'
      const usdcBalanceAtomic = usdcKnown ? usdcItem.balance : null
      const usdcPace7dAtomic = usdcToken?.address
        ? spendGroups
            .filter(
              (group) =>
                group.chain_key === account.chain_id &&
                group.token_key === usdcToken.address!.toLowerCase() &&
                agentAccountById.get(group.agent_id) === account.id,
            )
            .reduce((sum, group) => sum + Number(group.pace_atomic), 0)
        : 0
      return {
        accountId: account.id,
        chainId: account.chain_id,
        isTestnet: isChainTestnet(account.chain_id),
        usdcBalanceAtomic,
        usdcDecimals: usdcToken?.decimals ?? null,
        ...(usdcItem?.balanceFreshness ? { usdcBalanceFreshness: usdcItem.balanceFreshness } : {}),
        funded: usdcBalanceAtomic == null ? null : BigInt(usdcBalanceAtomic) > 0n,
        needs_backup_recommendation: needsBackupSignerRecommendation({
          chainId: account.chain_id,
          signerCount: account.passkey_count + (account.owner_address ? 1 : 0),
        }),
        usdcPace7dAtomic: String(usdcPace7dAtomic),
      }
    })

    const windowWire = (figures: SpendWindowFigures) => ({
      gross: { usd: figures.grossUsd, eur: figures.grossEur, sek: figures.grossSek },
      net: { usd: figures.netUsd, eur: figures.netEur, sek: figures.netSek },
      approx: figures.approx,
      approxByCurrency: figures.approxByCurrency,
      unpricedByCurrency: figures.unpricedByCurrency,
      payments: figures.payments,
    })

    // #3295: a portfolio whose balance read failed serves the last-known
    // balances, marked stale (or unavailable when nothing was ever read).
    // The totals already use those substituted values, so a degraded read
    // shows the last figure we actually saw — never an understated zero.
    const balancesDegraded = combineBalanceFreshness(
      currentPortfolio.flatMap((portfolio) =>
        (portfolio.breakdown ?? []).map((item) => item.balanceFreshness),
      ),
    )

    const totalUsd = currentPortfolio.reduce((sum, item) => sum + item.totalUsd, 0)
    const totalEur = currentPortfolio.reduce((sum, item) => sum + item.totalEur, 0)
    const totalSek = currentPortfolio.reduce((sum, item) => sum + item.totalSek, 0)

    const todayDate = getSnapshotDate(0)
    const yesterdayDate = getSnapshotDate(-1)

    const snapshotRows = await findPortfolioSnapshots(sub, [todayDate, yesterdayDate])

    const snapshotsByDate = new Map(
      snapshotRows.map((row) => [row.snapshot_date, row]),
    )

    if (!snapshotsByDate.has(todayDate)) {
      // #3296: a read valued from a failed balance leg or a missing price is
      // unpriceable — inserting it would pin an understated figure on the day
      // (the row is never replaced and becomes tomorrow's baseline), so the
      // insert is skipped and the first CLEAN load that day writes it. Prices
      // served from #3297's last-good cache count as priced. One day with no
      // snapshot reports `change.available = false` tomorrow — a wrong figure
      // is worse than a missing one.
      const snapshotBlocked = currentPortfolio.some((portfolio) =>
        isPortfolioUnpriceable(portfolio),
      )
      if (snapshotBlocked) {
        // No amounts on purpose: the log line is a finding aid for a day with
        // no snapshot, not a figures channel.
        request.log.info(
          { userId: sub },
          'Daily portfolio snapshot skipped: the portfolio read is unpriceable (#3296)',
        )
      } else {
        await insertPortfolioSnapshot(sub, todayDate, totalUsd, totalEur, totalSek)
      }
    }

    const yesterdaySnapshot = snapshotsByDate.get(yesterdayDate)
    const previousUsd = Number(yesterdaySnapshot?.total_usd ?? '0')
    const previousEur = Number(yesterdaySnapshot?.total_eur ?? '0')
    // A pre-090 snapshot carries total_sek NULL: treated as "no SEK figure for
    // that day", not as a real zero — a zero would fabricate a -100% change.
    const changeAvailable = Boolean(yesterdaySnapshot)
    const sekChangeAvailable = changeAvailable && yesterdaySnapshot?.total_sek != null
    const previousSek = Number(yesterdaySnapshot?.total_sek ?? '0')

    const mergedTransactions: EnrichedTransaction[] = []
    // #3824: a capped explorer read makes every count the groups serve a
    // FLOOR over an unknown total — the flag is read per account here and ORs
    // into the group builder below (`countIsFloor`).
    let explorerTruncated = false
    const transactionResults = await Promise.allSettled(
      accounts.map(async (account) => {
        const { transactions, truncated } = await fetchAccountTransactions({
          accountId: account.id,
          accountAddress: account.account_address,
          chainId: account.chain_id,
          log: request.log,
        })

        if (truncated) explorerTruncated = true

        return transactions.map((tx) => ({
          ...tx,
          chainId: account.chain_id,
          accountId: account.id,
          accountAddress: account.account_address,
          accountName: account.name,
        }))
      }),
    )

    transactionResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        mergedTransactions.push(...result.value)
        return
      }

      const account = accounts[index]
      request.log.warn(
        { err: result.reason, accountId: account.id, chainId: account.chain_id },
        'Dashboard transaction aggregation failed',
      )
    })

    const visibleTransactions = await mergeX402Transactions(
      sub,
      accounts,
      mergedTransactions,
    )

    visibleTransactions.sort(compareTransactions)

    const seen = new Set<string>()
    const dedupedTransactions = visibleTransactions.filter((tx) => {
      const key = enrichedTransactionIdentityKey(tx)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const enrichedTransactions = await enrichTransactionsWithAgents(
      sub,
      dedupedTransactions,
      // The preview names its currency like the feed does (#3127 round-2
      // review): without the preference, the same payment is SEK here and
      // USD on /transactions for a USD user. #3824: the shared preference
      // read (one per request, above) also strikes the activity groups'
      // serve-time pricing in the SAME currency.
      currency,
    )

    // #4268: a move between two of the user's own accounts becomes ONE row,
    // as on `/transactions` (#4265) — the same fold, one definition. Always
    // on here: the web app is this route's only reader. It runs after
    // enrichment, because the fold refuses an outbound row with no initiator
    // classification (an enrichment outage) rather than risk hiding an agent
    // payment, and its pairing does not depend on the sort above. Ownership
    // is this surface's account set (`listDashboardAccounts`, hybrid only),
    // so a transfer from an account this route does not fetch stays a send.
    const foldedTransactions = foldOwnAccountTransfers(enrichedTransactions, accounts)

    // #3824: the grouped activity rows — server-side over the SAME feed the
    // preview slices, so the counts are not bounded by any client window.
    // Merchant labels come from the same two lookups analytics resolves them
    // from (address-book contacts, then receipt merchant names); one read of
    // each per request, over the counterparty addresses the feed carries.
    const merchantAddresses = Array.from(
      new Set(
        enrichedTransactions
          .filter((tx) => tx.direction === 'out' && tx.to)
          .map((tx) => tx.to.toLowerCase()),
      ),
    )
    // Fail-soft on purpose: the labels are display garnish on top of the
    // grouped rows — a contacts or receipt-read outage must not 500 the
    // overview, it just serves the raw addresses (the same degradation the
    // CSV export has always had when a lookup came back empty). Named with
    // the activity- prefix because #3803's route body already reads the same
    // two repositories for ITS labels — different address sets, different
    // failure posture, kept separate rather than merged.
    const [activityContacts, activityReceiptNames] = await Promise.all([
      listContactsForUser(sub).catch(() => []),
      listReceiptMerchantNamesForUser(sub, merchantAddresses).catch(() => new Map<string, string>()),
    ])
    const contactNames = new Map(activityContacts.map((c) => [c.address.toLowerCase(), c.name]))
    const resolveMerchantName = (address: string): string | null =>
      contactNames.get(address.toLowerCase()) ?? activityReceiptNames.get(address.toLowerCase()) ?? null

    // #3944: the feed builder returns the grouped rows BESIDE the two
    // empty-state facts — `hasOlderActivity` (any feed transaction outside
    // the window) and `windowDays` (ACTIVITY_WINDOW_DAYS, carried so the
    // client can name the window without hard-coding a 7 that drifts).
    // #3975: the route's OWN `now` rides in, so the feed's rolling window is
    // the SAME instant `from7Iso` was derived from — one clock, one window.
    const { groups: activity, hasOlderActivity, windowDays: activityWindowDays } =
      await buildActivityFeed({
        transactions: foldedTransactions,
        truncated: explorerTruncated,
        tz,
        currency,
        now: now.getTime(),
        resolveMerchantName,
        // #4099: a transfer between two of the user's accounts names the
        // other account on both sides — instead of "New recipient" on the
        // send and "Deposit" on the receipt.
        resolveOwnAccountName: ownAccountNameResolver(accounts),
      })

    return {
      totals: {
        usd: totalUsd,
        eur: totalEur,
        sek: totalSek,
      },
      change: {
        available: changeAvailable,
        // #3295: when some token has no known value, the totals are
        // understated by an unknown amount — the change is reported as
        // unavailable (null amounts), never as a swing computed from a zero.
        // Marked-stale tokens still diff normally: the last-known figures are
        // on both sides of the subtraction.
        usdAmount: balancesDegraded?.status === 'unavailable' ? null : totalUsd - previousUsd,
        eurAmount: balancesDegraded?.status === 'unavailable' ? null : totalEur - previousEur,
        // Null, not 0, when yesterday's snapshot predates migration 090: the
        // wire distinguishes "no SEK figure to diff against" from "changed by
        // exactly 0", and the frontend reports the change as unavailable
        // rather than fabricating a -100% swing from a missing baseline.
        sekAmount:
          sekChangeAvailable && balancesDegraded?.status !== 'unavailable'
            ? totalSek - previousSek
            : null,
        usdPercent: changeAvailable ? computePercentChange(totalUsd, previousUsd) : 0,
        eurPercent: changeAvailable ? computePercentChange(totalEur, previousEur) : 0,
        // sekPercent 0 beside sekAmount null is deliberate: the frontend
        // branches on the AMOUNT (null = "change unavailable") and never
        // reads the percentage in that state — the schema wants a number, so
        // 0 is the inert filler, not a claim the change was zero.
        sekPercent: sekChangeAvailable ? computePercentChange(totalSek, previousSek) : 0,
        // Additive (#3295): present only when at least one token's read is
        // stale or unavailable; absent on a clean read.
        ...(balancesDegraded ? { balancesFreshness: balancesDegraded } : {}),
      },
      actionableApprovals,
      pendingApprovals: actionableApprovals,
      onboardingProgress: {
        hasFirstAgentPayment: firstAgentPayment,
      },
      agents: agents.map((agent) => {
        const agentGroups = spendGroups.filter((group) => group.agent_id === agent.id)
        const stats7 = emptySpendWindow()
        const stats30 = emptySpendWindow()
        for (const group of agentGroups) {
          accumulateGroup(stats7, group, '7', rates)
          accumulateGroup(stats30, group, '30', rates)
        }
        const refusalRow = refusalsByAgent.get(agent.id)
        const refusals7 = emptyRefusalBuckets()
        const refusals30 = emptyRefusalBuckets()
        if (refusalRow) {
          accumulateRefusalRow(refusals7, refusalRow, '7')
          accumulateRefusalRow(refusals30, refusalRow, '30')
        }
        const lastPayment = lastPayments.find((row) => row.agent_id === agent.id) ?? null
        const setupStatus =
          agent.status === 'pending_approval' ? (setupStatuses.get(agent.id) ?? null) : null
        return {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          // #4429: the stored display colour (1..6), so the dashboard's agent
          // rows key their monogram off it instead of hashing the name.
          avatarTint: agent.avatar_tint,
          accountId: agent.account_id,
          accountName: agent.account_name,
          accountChainId: agent.account_chain_id,
          // Deprecated with #3807's tile removal; still emitted (the frontend
          // reads it with `?? 0` today). `resetPeriodMin` left the wire in
          // #3807 — the reset label it fed was removed with the KPI tiles,
          // and #3809's budget-caption rows replace this subtitle.
          allowances: (allowancesByAgent.get(agent.id) ?? []).map((allowance) => ({
            tokenSymbol: allowance.token_symbol,
            allowanceAmount: allowance.allowance_amount,
          })),
          // #3803: every budget with its identity and live window. The 6-row
          // preview cap moved to the client; the expired-row predicate is
          // #3802's (`listActiveDelegations`).
          budgets: (budgetsByAgent.get(agent.id) ?? []).map((budget) => {
            const { end } = currentPeriodBounds(
              Number(budget.start_date),
              budget.period_seconds,
              Math.floor(now.getTime() / 1000),
            )
            return {
              id: budget.id,
              delegationHash: budget.delegation_hash,
              chainId: budget.chain_id,
              tokenAddress: budget.token_address,
              tokenSymbol: budget.token_symbol,
              decimals: chainToken(budget.chain_id, budget.token_address)?.decimals ?? 18,
              budgetAtomic: budget.budget_atomic,
              periodSeconds: budget.period_seconds,
              startDate: new Date(Number(budget.start_date) * 1000).toISOString(),
              expiresAt: new Date(Number(budget.expires_at) * 1000).toISOString(),
              periodEnd: new Date(end * 1000).toISOString(),
            }
          }),
          // #4353: when the agent's latest budget ended (ISO), or null. The
          // SQL already filters to closed windows; re-checking `<= now` here
          // means a live row is never reported as ended (#4352's posture).
          budgetEndedAt: budgetEndedAtIso(endedBudgetByAgent.get(agent.id), now),
          receivedSubBudgets: receivedSubBudgets
            .filter((row) => row.agent_id === agent.id)
            .map((row) => ({
              parentAgentId: row.parent_agent_id,
              parentAgentName: row.parent_agent_name,
              open: row.open,
            })),
          // Owner decision 2: a pending agent whose setup expired or failed
          // is shown with "Remove", not "Finish setup" — the raw setup
          // status lets the client decide without a second round trip.
          ...(setupStatus != null ? { setupStatus } : {}),
          stats: {
            d7: { ...windowWire(stats7), refusals: { ...refusals7, ...latestRefusalTimes(refusalRow) } },
            d30: { ...windowWire(stats30), refusals: refusals30 },
            lastPaymentAt: lastPayment?.confirmed_at ? lastPayment.confirmed_at.toISOString() : null,
            lastCounterparty: lastPayment
              ? {
                  source: lastPayment.source,
                  x402ResourceUrl: lastPayment.x402_resource_url,
                  to: lastPayment.to_address,
                  merchantName: merchantNameFor(lastPayment.merchant_address),
                }
              : null,
          },
        }
      }),
      agentCount: {
        active: agents.filter((a) => a.status === 'active').length,
        paused: agents.filter((a) => a.status === 'paused').length,
        pending_approval: agents.filter((a) => a.status === 'pending_approval').length,
      },
      accounts: accountBlocks,
      spotRates,
      spend: {
        scope: spendScope,
        d7: {
          gross: { usd: d7.grossUsd, eur: d7.grossEur, sek: d7.grossSek },
          net: { usd: d7.netUsd, eur: d7.netEur, sek: d7.netSek },
          approx: d7.approx,
          approxByCurrency: d7.approxByCurrency,
          unpricedByCurrency: d7.unpricedByCurrency,
          payments: d7.payments,
          distinctMerchants: Number(merchants.distinct_merchants_7),
          budgetStops: budgetStops7,
        },
        d30: {
          gross: { usd: d30.grossUsd, eur: d30.grossEur, sek: d30.grossSek },
          net: { usd: d30.netUsd, eur: d30.netEur, sek: d30.netSek },
          approx: d30.approx,
          approxByCurrency: d30.approxByCurrency,
          unpricedByCurrency: d30.unpricedByCurrency,
          payments: d30.payments,
          distinctMerchants: Number(merchants.distinct_merchants_30),
          budgetStops: budgetStops30,
        },
        topMerchant7d,
        failedIntents7d: failedIntentsRead.count,
        // #4324: the unattributed "Payments failed" item re-arms on this.
        ...(failedIntentsRead.lastAt ? { lastFailedIntentAt: failedIntentsRead.lastAt.toISOString() } : {}),
        balance_by_day: balanceByDay,
      },
      // #3824: up to 8 grouped-activity rows over the rolling last 7 days
      // (24h × 7, the owner decision — #3975), newest first, grouped
      // server-side over the feed above. #3858: the former 5-row
      // `transactions` preview is gone — nothing has read it since #3810
      // (the dashboard renders `activity`).
      activity,
      // #3944: the Activity card's empty state must distinguish "no activity
      // ever" from "nothing in the window" — the rows above cannot carry
      // that (an empty list is both). True when the SAME feed the groups
      // bucket carries any transaction outside `activityWindowDays`; an
      // explorer-read failure degrades it to false, the same posture as the
      // rows. The window rides the wire so the copy names the window the
      // backend actually buckets over, never a client-side constant.
      hasOlderActivity,
      activityWindowDays,
      // #3975: the rolling window's start instant — the same `from7Iso` the
      // spend SQL received. The client marks the oldest Activity day heading
      // partial when this instant cuts its own local day, so the boundary is
      // the server's, never a client clock re-derivation.
      activityWindowStart: from7Iso,
    }
  })

  /**
   * #4709 — the "Since your last visit" figures (epic #4701 decision 4).
   *
   * The window is `(after, through]`: `after` is the PREVIOUS entry's instant
   * and `through` this entry's, both returned by `POST /user/visits`. A
   * payment confirmed exactly on a boundary is counted in exactly one of two
   * consecutive windows, and a payment confirmed after `through` belongs to
   * the next entry.
   *
   * The figures are #3803's NET definition with the #3755 netting, over the
   * SAME `spend.scope` the 7-day block uses (`spendScopeForAccounts`), in the
   * user's display currency — so the line cannot disagree with the sentence
   * below it. Display-only: nothing here is read by a payment path.
   */
  app.get<{ Querystring: { after: string; through: string; tz?: string } }>('/since', async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { after, through, tz } = request.query

      // The spec declares both as required `date-time` query parameters and
      // the request-validation plugin is enforced for this module, so the
      // handler only has to reject an unparseable instant (and a missing one,
      // which `new Date(undefined)` already is) — no `typeof` ladder, which
      // the request-schema ratchet counts as residue.
      const parseInstant = (value: string): Date | null => {
        const parsed = new Date(value)
        return Number.isNaN(parsed.getTime()) ? null : parsed
      }
      const afterDate = parseInstant(after)
      const throughDate = parseInstant(through)
      if (!afterDate || !throughDate) {
        return reply.code(400).send({ error: 'after and through must be ISO timestamps' })
      }
      if (afterDate.getTime() >= throughDate.getTime()) {
        return reply.code(400).send({ error: 'after must be before through' })
      }
      // Same validation and the same refusal wording as the overview's `tz`
      // (never echo the raw query value).
      if (tz !== undefined && !isValidActivityTimeZone(tz)) {
        return reply.code(400).send({ error: 'unsupported tz' })
      }

      const accounts = await listDashboardAccounts(sub)
      const { chainIds } = spendScopeForAccounts(accounts)
      const groups = await listDashboardSinceGroups(
        sub,
        chainIds,
        afterDate.toISOString(),
        throughDate.toISOString(),
      )
      const currency = await resolveTransactionCurrency(sub)
      const bucket = currency.toLowerCase() as 'usd' | 'eur' | 'sek'
      const netKey = bucket === 'usd' ? 'netUsd' : bucket === 'eur' ? 'netEur' : 'netSek'

      const symbols = new Set<string>()
      for (const group of groups) {
        const symbol = chainToken(group.chain_key, group.token_key)?.symbol
        if (symbol) symbols.add(symbol)
      }
      const rates = groupPricing(groups, await loadTokenRates(symbols))

      const byAgent = new Map<string, { id: string; name: string; figures: SpendWindowFigures }>()
      for (const group of groups) {
        const entry = byAgent.get(group.agent_id) ?? {
          id: group.agent_id,
          name: group.agent_name,
          figures: emptySpendWindow(),
        }
        accumulateWindow(entry.figures, group, group.chain_key, group.token_key, rates)
        byAgent.set(group.agent_id, entry)
      }

      const agents = [...byAgent.values()]
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          netSpend: entry.figures[netKey],
          payments: entry.figures.payments,
        }))
        .sort((a, b) => b.netSpend - a.netSpend || a.name.localeCompare(b.name))

      return {
        after: afterDate.toISOString(),
        through: throughDate.toISOString(),
        // The fixed "Since …" word, spoken in the caller's zone — the reason
        // `tz` is on this route at all. The sentence around it is assembled
        // from fixed templates in the frontend.
        timeWord: sinceTimeWord(afterDate.toISOString(), throughDate.toISOString(), tz ?? 'UTC'),
        currency,
        payments: agents.reduce((sum, agent) => sum + agent.payments, 0),
        net: agents.reduce((sum, agent) => sum + agent.netSpend, 0),
        agents,
      }
  })

  // #4707: the first agent payment, named. A small route of its own rather
  // than an overview field — see `FirstAgentPaymentResponse`.
  app.get('/first-agent-payment', async (request): Promise<FirstAgentPaymentResponse> => {
    const { sub } = request.user as { sub: string }

    const row = await findFirstAgentPayment(sub)
    if (!row) return { payment: null }

    // Counterparty naming, the same two sources the overview's merchant slot
    // reads: contacts win, then merchant receipts. The raw address is a lookup
    // key only — it never reaches the wire (#3810 rule 4).
    let merchantName: string | null = null
    if (row.merchant_address) {
      const key = row.merchant_address.toLowerCase()
      const contacts = await listContactsForUser(sub)
      merchantName = contacts.find((c) => c.address.toLowerCase() === key)?.name ?? null
      if (merchantName === null) {
        const receiptNames = await listReceiptMerchantNamesForUser(sub, [row.merchant_address])
        merchantName = receiptNames.get(key) ?? null
      }
    }

    return {
      payment: {
        id: row.id,
        agentName: row.agent_name,
        amountHuman: row.amount_human,
        amountRaw: row.amount_raw,
        tokenSymbol: row.token_symbol,
        chainId: row.chain_id,
        confirmedAt: row.confirmed_at.toISOString(),
        usdValue: row.usd_value == null ? null : Number(row.usd_value),
        eurValue: row.eur_value == null ? null : Number(row.eur_value),
        sekValue: row.sek_value == null ? null : Number(row.sek_value),
        merchantName,
        x402ResourceUrl: row.x402_resource_url,
      },
    }
  })
}
