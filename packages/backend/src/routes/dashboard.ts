import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { getChainData } from '@haven_ai/core'
import {
  countFailedIntents7d,
  findPortfolioSnapshots,
  hasFirstAgentPayment,
  insertPortfolioSnapshot,
  listAgentLastPayments,
  listDashboardAgents,
  listDashboardAccounts,
  listDashboardMerchants,
  listDashboardSpendGroups,
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
  compareTransactions,
  type EnrichedTransaction,
  enrichedTransactionIdentityKey,
  enrichTransactionsWithAgents,
  fetchAccountTransactions,
  mergeX402Transactions,
  resolveTransactionCurrency,
} from '../modules/transactions/index.js'

const TRANSACTION_PREVIEW_LIMIT = 5

// ── #3803: the 7/30-day spend block ──────────────────────────────────────────

/** One window's figures. Fiat buckets are USD/EUR/SEK booked-or-netted sums. */
interface SpendWindowFigures {
  grossUsd: number
  netUsd: number
  grossEur: number
  netEur: number
  grossSek: number
  netSek: number
  /** True when any row's booked fiat was NULL and got priced at today's rate (owner decision 1). */
  approx: boolean
  payments: number
}

function emptySpendWindow(): SpendWindowFigures {
  return {
    grossUsd: 0,
    netUsd: 0,
    grossEur: 0,
    netEur: 0,
    grossSek: 0,
    netSek: 0,
    approx: false,
    payments: 0,
  }
}

/** A token's spot rates in the three fiat buckets; `null` bucket = no usable quote. */
interface TokenRates {
  usd: number | null
  eur: number | null
  sek: number | null
}

function emptyRefusalBuckets(): { budget: number; scope: number; failed: number; haven: number } {
  return { budget: 0, scope: 0, failed: 0, haven: 0 }
}

/**
 * Folds a spend GROUP into a window accumulator. `fb*` is the token amount of
 * rows whose booked fiat was NULL — priced at TODAY's rate here (owner
 * decision 1) and added to the same bucket, with `approx` marking the total
 * so the client never presents a re-priced figure as booked.
 */
function accumulateGroup(
  target: SpendWindowFigures,
  group: DashboardSpendGroupRow,
  suffix: '7' | '30',
  rates: Map<string, TokenRates | null>,
): void {
  target.grossUsd += Number(group[`gross_usd_${suffix}`] ?? '0')
  target.netUsd += Number(group[`net_usd_${suffix}`] ?? '0')
  target.grossEur += Number(group[`gross_eur_${suffix}`] ?? '0')
  target.netEur += Number(group[`net_eur_${suffix}`] ?? '0')
  target.grossSek += Number(group[`gross_sek_${suffix}`] ?? '0')
  target.netSek += Number(group[`net_sek_${suffix}`] ?? '0')
  target.payments += Number(group[`payments_${suffix}`] ?? '0')

  // String-concat, not a template literal: the route-module inventory regex
  // reads any `x.get(` followed by a quoted string as a Fastify registration,
  // and a backtick here fabricated a `GET /dashboard${chain}:${token}` route
  // in `route-modules.generated.ts` (#3803 round-2).
  const rate = rates.get(group.chain_key + ':' + group.token_key) ?? null
  const fbUsd = Number(group[`fb_usd_${suffix}`] ?? '0')
  const fbEur = Number(group[`fb_eur_${suffix}`] ?? '0')
  const fbSek = Number(group[`fb_sek_${suffix}`] ?? '0')
  if (fbUsd > 0) {
    target.approx = true
    if (rate?.usd != null) {
      target.grossUsd += fbUsd * rate.usd
      target.netUsd += fbUsd * rate.usd
    }
  }
  if (fbEur > 0) {
    target.approx = true
    if (rate?.eur != null) {
      target.grossEur += fbEur * rate.eur
      target.netEur += fbEur * rate.eur
    }
  }
  if (fbSek > 0) {
    target.approx = true
    if (rate?.sek != null) {
      target.grossSek += fbSek * rate.sek
      target.netSek += fbSek * rate.sek
    }
  }
}

function accumulateRefusalRow(target: ReturnType<typeof emptyRefusalBuckets>, row: RefusalBucketRow, suffix: '7' | '30'): void {
  target.budget += Number(row[`budget_${suffix}`] ?? '0')
  target.scope += Number(row[`scope_${suffix}`] ?? '0')
  target.failed += Number(row[`failed_${suffix}`] ?? '0')
  target.haven += Number(row[`haven_${suffix}`] ?? '0')
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

  app.get('/overview', async (request) => {
    const { sub } = request.user as { sub: string }

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
    const from7Iso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const from30Iso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

    // Testnet scope (owner decision 3): the figures cover mainnet accounts
    // only whenever the user has one; a testnet-only user sees test totals.
    // `faucetUrl` is the registry's own testnet marker (testnets only, #2534).
    const isChainTestnet = (chainId: number): boolean => {
      try {
        return getChainData(chainId).faucetUrl !== undefined
      } catch {
        return false
      }
    }
    const mainnetChainIds = [
      ...new Set(accounts.filter((account) => !isChainTestnet(account.chain_id)).map((a) => a.chain_id)),
    ]
    const allChainIds = [...new Set(accounts.map((a) => a.chain_id))]
    const scopeChainIds = mainnetChainIds.length > 0 ? mainnetChainIds : allChainIds
    const spendScope: 'mainnet' | 'testnet' = mainnetChainIds.length > 0 ? 'mainnet' : 'testnet'

    const [
      spendGroups,
      merchants,
      refusalBuckets,
      failedIntents7d,
      lastPayments,
      contacts,
      balanceByDayRows,
    ] = await Promise.all([
      listDashboardSpendGroups(sub, scopeChainIds, from30Iso, from7Iso, toIso),
      listDashboardMerchants(sub, scopeChainIds, from30Iso, from7Iso, toIso),
      listRefusalBucketsByAgent(sub, scopeChainIds, from30Iso, from7Iso, toIso),
      countFailedIntents7d(sub, scopeChainIds, from7Iso, toIso),
      listAgentLastPayments(sub),
      listContactsForUser(sub),
      listBalanceByDayForUser(sub, { from: getSnapshotDate(-30), to: getSnapshotDate(0) }),
    ])
    // One preference read per request — the same resolved currency the
    // transaction enrichment below receives (#3127).
    const currency = await resolveTransactionCurrency(sub)

    // Token identity + today's spot rates. One `getTokenPrice` call per
    // symbol (shared 60 s CoinGecko cache); a failed read or a zero quote is
    // `null` — the wire distinguishes "no rate" from a 0 rate (owner decision
    // 1: a NULL-booked-fiat row is priced at today's rate and the total is
    // marked ≈, so a rate must never silently undercount).
    const chainToken = (
      chainKey: number,
      tokenKey: string,
    ): { symbol: string; decimals: number } | null => {
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
    const rateBySymbol = new Map<string, TokenRates | null>()
    for (const group of spendGroups) {
      const symbol = chainToken(group.chain_key, group.token_key)?.symbol
      if (symbol && !rateBySymbol.has(symbol)) rateBySymbol.set(symbol, null)
    }
    for (const budgets of budgetsByAgent.values()) {
      for (const budget of budgets) {
        if (!rateBySymbol.has(budget.token_symbol)) rateBySymbol.set(budget.token_symbol, null)
      }
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
    const rates = new Map<string, TokenRates | null>()
    for (const group of spendGroups) {
      const symbol = chainToken(group.chain_key, group.token_key)?.symbol
      rates.set(`${group.chain_key}:${group.token_key}`, symbol ? (rateBySymbol.get(symbol) ?? null) : null)
    }
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
    const budgetStops7 = refusalBuckets.reduce((sum, row) => sum + Number(row.budget_7 ?? '0'), 0)
    const budgetStops30 = refusalBuckets.reduce((sum, row) => sum + Number(row.budget_30 ?? '0'), 0)

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
    const transactionResults = await Promise.allSettled(
      accounts.map(async (account) => {
        const { transactions } = await fetchAccountTransactions({
          accountId: account.id,
          accountAddress: account.account_address,
          chainId: account.chain_id,
          log: request.log,
        })

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
      // USD on /transactions for a USD user.
      currency,
    )

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
            d7: { ...windowWire(stats7), refusals: refusals7 },
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
          payments: d7.payments,
          distinctMerchants: Number(merchants.distinct_merchants_7),
          budgetStops: budgetStops7,
        },
        d30: {
          gross: { usd: d30.grossUsd, eur: d30.grossEur, sek: d30.grossSek },
          net: { usd: d30.netUsd, eur: d30.netEur, sek: d30.netSek },
          approx: d30.approx,
          payments: d30.payments,
          distinctMerchants: Number(merchants.distinct_merchants_30),
          budgetStops: budgetStops30,
        },
        topMerchant7d,
        failedIntents7d,
        balance_by_day: balanceByDay,
      },
      transactions: enrichedTransactions.slice(0, TRANSACTION_PREVIEW_LIMIT).map((tx) =>
        ({
          hash: tx.hash,
          type: tx.type,
          from: tx.from,
          to: tx.to,
          value: tx.value,
          valueFormatted: tx.valueFormatted,
          asset: tx.asset,
          decimals: tx.decimals,
          direction: tx.direction,
          timestamp: tx.timestamp,
          // #3132: the preview carries the same synthesized x402 rows as the
          // feed, so the marked fallback must reach it too (no `scope`: the
          // preview is not a list query).
          timestampSource: tx.timestampSource,
          confirmedAt: tx.confirmedAt,
          blockNumber: tx.blockNumber,
          isError: tx.isError,
          tokenAddress: tx.tokenAddress,
          tokenSymbol: tx.tokenSymbol,
          chainId: tx.chainId,
          accountId: tx.accountId,
          accountAddress: tx.accountAddress,
          accountName: tx.accountName,
          agentId: tx.agentId,
          agentName: tx.agentName,
          source: tx.source,
          x402ResourceUrl: tx.x402ResourceUrl,
          x402MerchantAddress: tx.x402MerchantAddress,
          // #3778: the non-secret delivery pointer, when one was reported.
          deliveryReference: tx.deliveryReference ?? null,
        }),
      ),
    }
  })
}
