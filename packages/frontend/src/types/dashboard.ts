import type { AggregatedTransaction } from './transactions'

export interface DashboardAgentAllowance {
  tokenSymbol: string
  allowanceAmount: string
  resetPeriodMin: number
}

export interface DashboardAgentPreview {
  id: string
  name: string
  status: string
  safeId: string | null
  safeName: string | null
  safeChainId: number | null
  allowances: DashboardAgentAllowance[]
}

export interface DashboardOverviewResponse {
  totals: {
    usd: number
    eur: number
  }
  change: {
    available: boolean
    usdAmount: number
    eurAmount: number
    usdPercent: number
    eurPercent: number
  }
  metrics: {
    connectedAgents: number
    monthlyAgentSpendUsd: number
    monthlyAgentSpendEur: number
    successfulTransactions: number
    activeAccounts: number
  }
  pendingApprovals: number
  agents: DashboardAgentPreview[]
  transactions: AggregatedTransaction[]
}
