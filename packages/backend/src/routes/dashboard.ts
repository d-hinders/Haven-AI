import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import {
  findPortfolioSnapshots,
  hasFirstAgentPayment,
  insertPortfolioSnapshot,
  listDashboardAgents,
  listDashboardSafes,
  sumMonthlyPaymentSpend,
  type DashboardAllowanceRow,
  type MonthlySpendRow,
} from '../infra/repositories/dashboard.js'
import { getFiatValuesForTokenAmount } from '../infra/fiat-values.js'
import { fetchPortfolioForSafe } from '../modules/accounts/index.js'
import { deriveDelegationAllowances } from '../rails/delegation-budget-view.js'
import {
  compareTransactions,
  type EnrichedTransaction,
  enrichedTransactionIdentityKey,
  enrichTransactionsWithAgents,
  fetchSafeTransactions,
  mergeX402Transactions,
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
): Promise<{ usd: number; eur: number }> {
  let usd = 0
  let eur = 0

  for (const row of rows) {
    usd += Number(row.usd_sum ?? '0')
    eur += Number(row.eur_sum ?? '0')

    const fallbackAmount = Number(row.fallback_amount ?? '0')
    if (fallbackAmount <= 0) continue

    const fallback = await getFiatValuesForTokenAmount(
      row.token_symbol,
      fallbackAmount.toString(),
    )
    usd += fallback.usd ?? 0
    eur += fallback.eur ?? 0
  }

  return { usd, eur }
}

export default async function dashboardRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get('/overview', async (request) => {
    const { sub } = request.user as { sub: string }

    const [
      safes,
      agents,
      firstAgentPayment,
    ] = await Promise.all([
      listDashboardSafes(sub),
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
      safes.map((safe) => fetchPortfolioForSafe(safe.chain_id, safe.safe_address)),
    )

    const totalUsd = currentPortfolio.reduce((sum, item) => sum + item.totalUsd, 0)
    const totalEur = currentPortfolio.reduce((sum, item) => sum + item.totalEur, 0)

    const todayDate = getSnapshotDate(0)
    const yesterdayDate = getSnapshotDate(-1)

    const snapshotRows = await findPortfolioSnapshots(sub, [todayDate, yesterdayDate])

    const snapshotsByDate = new Map(
      snapshotRows.map((row) => [row.snapshot_date, row]),
    )

    if (!snapshotsByDate.has(todayDate)) {
      await insertPortfolioSnapshot(sub, todayDate, totalUsd, totalEur)
    }

    const yesterdaySnapshot = snapshotsByDate.get(yesterdayDate)
    const previousUsd = Number(yesterdaySnapshot?.total_usd ?? '0')
    const previousEur = Number(yesterdaySnapshot?.total_eur ?? '0')
    const changeAvailable = Boolean(yesterdaySnapshot)

    // #2055: the approval-spend bucket is gone with approval_requests —
    // monthly spend is payment_intents alone now (historical executed-approval
    // spend disappears with the table, per the #2021 readability waiver).
    const paymentSpendRows = await sumMonthlyPaymentSpend(sub)
    const paymentSpend = await accumulateMonthlySpend(paymentSpendRows)

    const monthlySpendUsd = paymentSpend.usd
    const monthlySpendEur = paymentSpend.eur

    const mergedTransactions: EnrichedTransaction[] = []
    const transactionResults = await Promise.allSettled(
      safes.map(async (safe) => {
        const { transactions } = await fetchSafeTransactions({
          safeId: safe.id,
          safeAddress: safe.safe_address,
          chainId: safe.chain_id,
          log: request.log,
        })

        return transactions.map((tx) => ({
          ...tx,
          chainId: safe.chain_id,
          safeId: safe.id,
          safeAddress: safe.safe_address,
          safeName: safe.name,
        }))
      }),
    )

    transactionResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        mergedTransactions.push(...result.value)
        return
      }

      const safe = safes[index]
      request.log.warn(
        { err: result.reason, safeId: safe.id, chainId: safe.chain_id },
        'Dashboard transaction aggregation failed',
      )
    })

    const visibleTransactions = await mergeX402Transactions(
      sub,
      safes,
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
    )

    const successfulTransactions = dedupedTransactions.filter((tx) => !tx.isError).length

    return {
      totals: {
        usd: totalUsd,
        eur: totalEur,
      },
      change: {
        available: changeAvailable,
        usdAmount: totalUsd - previousUsd,
        eurAmount: totalEur - previousEur,
        usdPercent: changeAvailable ? computePercentChange(totalUsd, previousUsd) : 0,
        eurPercent: changeAvailable ? computePercentChange(totalEur, previousEur) : 0,
      },
      metrics: {
        connectedAgents: activeAgents.length,
        monthlyAgentSpendUsd: monthlySpendUsd,
        monthlyAgentSpendEur: monthlySpendEur,
        successfulTransactions,
        activeAccounts: safes.length,
      },
      actionableApprovals,
      pendingApprovals: actionableApprovals,
      onboardingProgress: {
        hasFirstAgentPayment: firstAgentPayment,
      },
      agents: agents.slice(0, AGENT_PREVIEW_LIMIT).map((agent) => ({
        id: agent.id,
        name: agent.name,
        status: agent.status,
        safeId: agent.safe_id,
        safeName: agent.safe_name,
        safeChainId: agent.safe_chain_id,
        allowances: (allowancesByAgent.get(agent.id) ?? []).map((allowance) => ({
          tokenSymbol: allowance.token_symbol,
          allowanceAmount: allowance.allowance_amount,
          resetPeriodMin: allowance.reset_period_min,
        })),
      })),
      transactions: enrichedTransactions.slice(0, TRANSACTION_PREVIEW_LIMIT).map((tx) => ({
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
        blockNumber: tx.blockNumber,
        isError: tx.isError,
        tokenAddress: tx.tokenAddress,
        tokenSymbol: tx.tokenSymbol,
        chainId: tx.chainId,
        safeId: tx.safeId,
        safeAddress: tx.safeAddress,
        safeName: tx.safeName,
        agentId: tx.agentId,
        agentName: tx.agentName,
        source: tx.source,
        x402ResourceUrl: tx.x402ResourceUrl,
        x402MerchantAddress: tx.x402MerchantAddress,
      })),
    }
  })
}
