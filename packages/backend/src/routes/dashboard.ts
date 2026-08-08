import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { countActionableApprovalsForUser } from '../infra/repositories/approval-requests.js'
import {
  findPortfolioSnapshots,
  hasFirstAgentPayment,
  insertPortfolioSnapshot,
  listDashboardAgents,
  listDashboardAllowances,
  listDashboardSafes,
  sumMonthlyApprovalSpend,
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
      actionableApprovals,
      firstAgentPayment,
    ] = await Promise.all([
      listDashboardSafes(sub),
      listDashboardAgents(sub),
      countActionableApprovalsForUser(sub),
      hasFirstAgentPayment(sub),
    ])

    const activeAgents = agents.filter((agent) => agent.status === 'active')

    const agentIds = agents.map((agent) => agent.id)
    const allowanceRows = await listDashboardAllowances(agentIds)

    const allowancesByAgent = new Map<string, DashboardAllowanceRow[]>()
    for (const row of allowanceRows) {
      const existing = allowancesByAgent.get(row.agent_id) ?? []
      existing.push(row)
      allowancesByAgent.set(row.agent_id, existing)
    }

    // Delegation-rail agents: the live budget is the active delegation set,
    // not the frozen agent_allowances onboarding mirror (#1090).
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

    const [paymentSpendRows, approvalSpendRows] = await Promise.all([
      sumMonthlyPaymentSpend(sub),
      sumMonthlyApprovalSpend(sub),
    ])

    const [paymentSpend, approvalSpend] = await Promise.all([
      accumulateMonthlySpend(paymentSpendRows),
      accumulateMonthlySpend(approvalSpendRows),
    ])

    const monthlySpendUsd = paymentSpend.usd + approvalSpend.usd
    const monthlySpendEur = paymentSpend.eur + approvalSpend.eur

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
