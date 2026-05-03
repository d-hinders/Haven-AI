import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getFiatValuesForTokenAmount } from '../lib/fiat-values.js'
import { fetchPortfolioForSafe } from '../lib/portfolio.js'
import {
  type EnrichedTransaction,
  enrichTransactionsWithAgents,
  fetchSafeTransactions,
} from './transactions.js'

interface UserSafeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string
  is_default: boolean
}

interface AgentRow {
  id: string
  name: string
  status: string
  safe_id: string | null
  safe_name: string | null
  safe_chain_id: number | null
}

interface AllowanceRow {
  agent_id: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

interface SnapshotRow {
  total_usd: string
  total_eur: string
}

interface MonthlySpendRow {
  token_symbol: string
  usd_sum: string | null
  eur_sum: string | null
  fallback_amount: string | null
}

function compareTransactions(
  a: EnrichedTransaction,
  b: EnrichedTransaction,
): number {
  return (
    b.timestamp - a.timestamp ||
    b.blockNumber - a.blockNumber ||
    a.hash.localeCompare(b.hash) ||
    a.type.localeCompare(b.type) ||
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.safeAddress.localeCompare(b.safeAddress)
  )
}

function getSnapshotDate(offsetDays = 0): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

function computePercentChange(current: number, previous: number): number {
  if (previous === 0) {
    return current === 0 ? 0 : 100
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
    usd += fallback.usd
    eur += fallback.eur
  }

  return { usd, eur }
}

export default async function dashboardRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get('/overview', async (request) => {
    const { sub } = request.user as { sub: string }

    const [safeResult, agentResult, pendingApprovalsResult] = await Promise.all([
      pool.query<UserSafeRow>(
        `SELECT id, safe_address, chain_id, name, is_default
         FROM user_safes
         WHERE user_id = $1
         ORDER BY created_at ASC`,
        [sub],
      ),
      pool.query<AgentRow>(
        `SELECT a.id, a.name, a.status, a.safe_id, us.name AS safe_name, us.chain_id AS safe_chain_id
         FROM agents a
         LEFT JOIN user_safes us ON us.id = a.safe_id
         WHERE a.user_id = $1
           AND a.status != 'revoked'
         ORDER BY
           CASE a.status
             WHEN 'active' THEN 0
             WHEN 'paused' THEN 1
             ELSE 2
           END,
           a.created_at DESC`,
        [sub],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM approval_requests
         WHERE user_id = $1 AND status = 'pending'`,
        [sub],
      ),
    ])

    const safes = safeResult.rows
    const agents = agentResult.rows
    const activeAgents = agents.filter((agent) => agent.status === 'active')

    const agentIds = agents.map((agent) => agent.id)
    const allowanceResult =
      agentIds.length === 0
        ? { rows: [] as AllowanceRow[] }
        : await pool.query<AllowanceRow>(
            `SELECT agent_id, token_symbol, allowance_amount, reset_period_min
             FROM agent_allowances
             WHERE agent_id = ANY($1)
             ORDER BY created_at ASC`,
            [agentIds],
          )

    const allowancesByAgent = new Map<string, AllowanceRow[]>()
    for (const row of allowanceResult.rows) {
      const existing = allowancesByAgent.get(row.agent_id) ?? []
      existing.push(row)
      allowancesByAgent.set(row.agent_id, existing)
    }

    const currentPortfolio = await Promise.all(
      safes.map((safe) => fetchPortfolioForSafe(safe.chain_id, safe.safe_address)),
    )

    const totalUsd = currentPortfolio.reduce((sum, item) => sum + item.totalUsd, 0)
    const totalEur = currentPortfolio.reduce((sum, item) => sum + item.totalEur, 0)

    const todayDate = getSnapshotDate(0)
    const yesterdayDate = getSnapshotDate(-1)

    await pool.query(
      `INSERT INTO user_daily_portfolio_snapshots (
         user_id, snapshot_date, total_usd, total_eur, updated_at
       ) VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, snapshot_date)
       DO UPDATE SET
         total_usd = EXCLUDED.total_usd,
         total_eur = EXCLUDED.total_eur,
         updated_at = NOW()`,
      [sub, todayDate, totalUsd, totalEur],
    )

    const yesterdaySnapshot = await pool.query<SnapshotRow>(
      `SELECT total_usd, total_eur
       FROM user_daily_portfolio_snapshots
       WHERE user_id = $1 AND snapshot_date = $2`,
      [sub, yesterdayDate],
    )

    const previousUsd = Number(yesterdaySnapshot.rows[0]?.total_usd ?? '0')
    const previousEur = Number(yesterdaySnapshot.rows[0]?.total_eur ?? '0')
    const changeAvailable = yesterdaySnapshot.rows.length > 0

    const [paymentSpendRows, approvalSpendRows] = await Promise.all([
      pool.query<MonthlySpendRow>(
        `SELECT token_symbol,
                COALESCE(SUM(usd_value), 0)::TEXT AS usd_sum,
                COALESCE(SUM(eur_value), 0)::TEXT AS eur_sum,
                COALESCE(
                  SUM(
                    CASE
                      WHEN usd_value IS NULL OR eur_value IS NULL
                        THEN amount_human::NUMERIC
                      ELSE 0
                    END
                  ),
                  0
                )::TEXT AS fallback_amount
         FROM payment_intents
         WHERE user_id = $1
           AND status = 'confirmed'
           AND confirmed_at >= DATE_TRUNC('month', NOW())
         GROUP BY token_symbol`,
        [sub],
      ),
      pool.query<MonthlySpendRow>(
        `SELECT token_symbol,
                COALESCE(SUM(usd_value), 0)::TEXT AS usd_sum,
                COALESCE(SUM(eur_value), 0)::TEXT AS eur_sum,
                COALESCE(
                  SUM(
                    CASE
                      WHEN usd_value IS NULL OR eur_value IS NULL
                        THEN amount_human::NUMERIC
                      ELSE 0
                    END
                  ),
                  0
                )::TEXT AS fallback_amount
         FROM approval_requests
         WHERE user_id = $1
           AND status = 'executed'
           AND executed_at >= DATE_TRUNC('month', NOW())
         GROUP BY token_symbol`,
        [sub],
      ),
    ])

    const [paymentSpend, approvalSpend] = await Promise.all([
      accumulateMonthlySpend(paymentSpendRows.rows),
      accumulateMonthlySpend(approvalSpendRows.rows),
    ])

    const monthlySpendUsd = paymentSpend.usd + approvalSpend.usd
    const monthlySpendEur = paymentSpend.eur + approvalSpend.eur

    const mergedTransactions: EnrichedTransaction[] = []
    for (const safe of safes) {
      try {
        const { transactions } = await fetchSafeTransactions({
          safeId: safe.id,
          safeAddress: safe.safe_address,
          chainId: safe.chain_id,
          log: request.log,
        })

        for (const tx of transactions) {
          mergedTransactions.push({
            ...tx,
            chainId: safe.chain_id,
            safeId: safe.id,
            safeAddress: safe.safe_address,
            safeName: safe.name,
          })
        }
      } catch (err) {
        request.log.warn(
          { err, safeId: safe.id, chainId: safe.chain_id },
          'Dashboard transaction aggregation failed',
        )
      }
    }

    mergedTransactions.sort(compareTransactions)

    const seen = new Set<string>()
    const dedupedTransactions = mergedTransactions.filter((tx) => {
      const key = `${tx.hash}:${tx.type}:${tx.from}:${tx.to}:${tx.safeAddress.toLowerCase()}`
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
      pendingApprovals: Number(pendingApprovalsResult.rows[0]?.count ?? '0'),
      agents: agents.slice(0, 6).map((agent) => ({
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
      transactions: enrichedTransactions.slice(0, 5).map((tx) => ({
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
      })),
    }
  })
}
