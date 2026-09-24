import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import {
  findPortfolioSnapshots,
  hasFirstAgentPayment,
  insertPortfolioSnapshot,
  listDashboardAgents,
  listDashboardAccounts,
  sumMonthlyPaymentSpend,
  type DashboardAllowanceRow,
  type MonthlySpendRow,
} from '../infra/repositories/dashboard.js'
import { getFiatValuesForTokenAmount } from '../infra/fiat-values.js'
import { fetchPortfolioForAccount } from '../modules/accounts/index.js'
import { deriveDelegationAllowances } from '../rails/delegation-budget-view.js'
import {
  compareTransactions,
  type EnrichedTransaction,
  enrichedTransactionIdentityKey,
  enrichTransactionsWithAgents,
  fetchAccountTransactions,
  mergeX402Transactions,
  resolveTransactionCurrency,
} from '../modules/transactions/index.js'

const AGENT_PREVIEW_LIMIT = 6
const TRANSACTION_PREVIEW_LIMIT = 5

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

async function accumulateMonthlySpend(
  rows: MonthlySpendRow[],
): Promise<{ usd: number; eur: number; sek: number }> {
  let usd = 0
  let eur = 0
  let sek = 0

  for (const row of rows) {
    usd += Number(row.usd_sum ?? '0')
    eur += Number(row.eur_sum ?? '0')
    sek += Number(row.sek_sum ?? '0')

    // Two INDEPENDENT re-price buckets. `getFiatValuesForTokenAmount` prices
    // the token amount into all three currencies, but each bucket may only
    // land its own currency: `sek_sum` already holds every row's booked
    // `sek_value`, and pricing SEK from the USD/EUR bucket's read is the
    // double-count the round-3 review measured (21 vs 10.5) — migration 090
    // backfills rows whose usd/eur are NULL, so the USD/EUR predicate
    // collects rows SEK has already priced. The row shapes are disjoint
    // neither way: a row can carry a booked SEK figure and still need the
    // USD/EUR re-price, or the reverse, so neither bucket may `continue` the
    // other.
    const fallbackAmount = Number(row.fallback_amount ?? '0')
    if (fallbackAmount > 0) {
      const fallback = await getFiatValuesForTokenAmount(
        row.token_symbol,
        fallbackAmount.toString(),
      )
      usd += fallback.usd ?? 0
      eur += fallback.eur ?? 0
    }

    const fallbackAmountSek = Number(row.fallback_amount_sek ?? '0')
    if (fallbackAmountSek > 0) {
      const sekFallback = await getFiatValuesForTokenAmount(
        row.token_symbol,
        fallbackAmountSek.toString(),
      )
      sek += sekFallback.sek ?? 0
    }
  }

  return { usd, eur, sek }
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

    const activeAgents = agents.filter((agent) => agent.status === 'active')

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
      await insertPortfolioSnapshot(sub, todayDate, totalUsd, totalEur, totalSek)
    }

    const yesterdaySnapshot = snapshotsByDate.get(yesterdayDate)
    const previousUsd = Number(yesterdaySnapshot?.total_usd ?? '0')
    const previousEur = Number(yesterdaySnapshot?.total_eur ?? '0')
    // A pre-090 snapshot carries total_sek NULL: treated as "no SEK figure for
    // that day", not as a real zero — a zero would fabricate a -100% change.
    const changeAvailable = Boolean(yesterdaySnapshot)
    const sekChangeAvailable = changeAvailable && yesterdaySnapshot?.total_sek != null
    const previousSek = Number(yesterdaySnapshot?.total_sek ?? '0')
    const paymentSpendRows = await sumMonthlyPaymentSpend(sub)
    const paymentSpend = await accumulateMonthlySpend(paymentSpendRows)

    const monthlySpendUsd = paymentSpend.usd
    const monthlySpendEur = paymentSpend.eur
    const monthlySpendSek = paymentSpend.sek

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
      // The preview names its currency like the feed does (#3127 round-3
      // review): without the preference, the same payment is SEK here and
      // USD on /transactions for a USD user.
      await resolveTransactionCurrency(sub),
    )

    const successfulTransactions = dedupedTransactions.filter((tx) => !tx.isError).length

    return {
      totals: {
        usd: totalUsd,
        eur: totalEur,
        sek: totalSek,
      },
      change: {
        available: changeAvailable,
        usdAmount: totalUsd - previousUsd,
        eurAmount: totalEur - previousEur,
        // Null, not 0, when yesterday's snapshot predates migration 090: the
        // wire distinguishes "no SEK figure to diff against" from "changed by
        // exactly 0", and the frontend reports the change as unavailable
        // rather than fabricating a -100% swing from a missing baseline.
        sekAmount: sekChangeAvailable ? totalSek - previousSek : null,
        usdPercent: changeAvailable ? computePercentChange(totalUsd, previousUsd) : 0,
        eurPercent: changeAvailable ? computePercentChange(totalEur, previousEur) : 0,
        // sekPercent 0 beside sekAmount null is deliberate: the frontend
        // branches on the AMOUNT (null = "change unavailable") and never
        // reads the percentage in that state — the schema wants a number, so
        // 0 is the inert filler, not a claim the change was zero.
        sekPercent: sekChangeAvailable ? computePercentChange(totalSek, previousSek) : 0,
      },
      metrics: {
        connectedAgents: activeAgents.length,
        monthlyAgentSpendUsd: monthlySpendUsd,
        monthlyAgentSpendEur: monthlySpendEur,
        monthlyAgentSpendSek: monthlySpendSek,
        successfulTransactions,
        activeAccounts: accounts.length,
      },
      actionableApprovals,
      pendingApprovals: actionableApprovals,
      onboardingProgress: {
        hasFirstAgentPayment: firstAgentPayment,
      },
      agents: agents.slice(0, AGENT_PREVIEW_LIMIT).map((agent) =>
        ({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          accountId: agent.account_id,
          accountName: agent.account_name,
          accountChainId: agent.account_chain_id,
          allowances: (allowancesByAgent.get(agent.id) ?? []).map((allowance) => ({
            tokenSymbol: allowance.token_symbol,
            allowanceAmount: allowance.allowance_amount,
            resetPeriodMin: allowance.reset_period_min,
          })),
        }),
      ),
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
        }),
      ),
    }
  })
}
