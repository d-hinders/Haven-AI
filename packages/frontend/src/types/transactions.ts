export interface Transaction {
  hash: string
  type: 'native' | 'erc20' | 'internal'
  from: string
  to: string
  value: string
  valueFormatted: string
  asset: string
  decimals: number
  direction: 'in' | 'out'
  timestamp: number
  blockNumber: number
  isError: boolean
  tokenAddress?: string
  tokenSymbol?: string
  agentName?: string
  source?: 'direct' | 'x402' | 'mpp_demo'
  x402ResourceUrl?: string | null
  x402MerchantAddress?: string | null
}

export interface AggregatedTransaction extends Transaction {
  chainId: number
  safeId: string
  safeAddress: string
  safeName: string
  agentId?: string
}

export interface TransactionsResponse {
  transactions: Transaction[]
  total: number
  page: number
  limit: number
  pages: number
}

export interface TransactionsFeedResponse {
  transactions: AggregatedTransaction[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  partialFailure: boolean
  failedSafeIds: string[]
}

export interface TransactionFilterState {
  safeId?: string
  agentId?: string
  tokenKey?: string
}

export interface TransactionFilterSafeOption {
  id: string
  name: string
  address: string
  chainId: number
}

export interface TransactionFilterAgentOption {
  id: string
  name: string
  status: string
}

export interface TransactionFilterTokenOption {
  key: string
  symbol: string
  address: string | null
  chainId: number
  isNative: boolean
}

export interface TransactionFilterOptionsResponse {
  safes: TransactionFilterSafeOption[]
  agents: TransactionFilterAgentOption[]
  tokens: TransactionFilterTokenOption[]
}

export interface BalanceItem {
  symbol: string
  address: string | null
  balance: string
  formatted: string
  decimals: number
}

export interface BalancesResponse {
  balances: BalanceItem[]
}

export interface PortfolioBreakdown {
  symbol: string
  balance: string
  formatted: string
  usdValue: number
  eurValue: number
}

export interface PortfolioResponse {
  totalUsd: number
  totalEur: number
  breakdown: PortfolioBreakdown[]
}

export interface SafeDetails {
  address: string
  owners: string[]
  threshold: number
  nonce: number
}
