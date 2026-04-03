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
}

export interface TransactionsResponse {
  transactions: Transaction[]
  total: number
  page: number
  limit: number
  pages: number
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
