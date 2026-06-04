import { api } from '@/lib/api'
import { getChainConfig } from '@/lib/chains'
import type {
  AggregatedTransaction,
  TransactionFilterState,
} from '@/types/transactions'

interface UserSafeResponse {
  id: string
  safe_address: string
  chain_id: number
  name: string
}

interface CurrentUserResponse {
  safes: UserSafeResponse[]
}

interface AgentAllowanceResponse {
  token_address: string
  token_symbol: string
}

interface AgentResponse {
  id: string
  name: string
  safe_id: string | null
  safe_address: string | null
  safe_name: string | null
  allowances?: AgentAllowanceResponse[]
}

interface AgentActivityResponse {
  activity: X402ActivityItem[]
}

interface X402ActivityItem {
  type: 'payment' | 'approval'
  id: string
  agent_id?: string
  agent_name?: string
  token: string
  token_address?: string | null
  amount_raw?: string | null
  amount: string
  to: string
  status: string
  tx_hash: string | null
  source?: string | null
  x402_resource_url?: string | null
  x402_merchant_address?: string | null
  safe_id?: string | null
  safe_address?: string | null
  safe_name?: string | null
  chain_id?: number | null
  explorer_url: string | null
  confirmed_at?: string | null
  payment_proof_status?: string | null
  payment_flow_status?: 'paid' | 'confirming_merchant' | 'needs_attention' | null
  payment_attention_reason?: 'merchant_retry_rejected_after_payment' | null
  created_at: string
}

interface ParsedTokenFilter {
  chainId: number
  address: string | null
}

export async function fetchX402ActivityTransactions(
  filters: TransactionFilterState = {},
): Promise<AggregatedTransaction[]> {
  try {
    // Temporary PR-preview bridge: remove this fan-out once the deployed backend
    // serves normalized x402 rows from /transactions and /dashboard/overview.
    const [activityResponse, agentsResponse, userResponse] = await Promise.all([
      api.get<AgentActivityResponse>('/agent-activity/feed?limit=100'),
      api.get<{ agents: AgentResponse[] }>('/agents'),
      api.get<CurrentUserResponse>('/auth/me'),
    ])

    return buildX402ActivityTransactions(
      activityResponse.activity,
      agentsResponse.agents,
      userResponse.safes,
      filters,
    )
  } catch {
    return []
  }
}

export function mergeTransactionsWithX402Activity(
  transactions: AggregatedTransaction[],
  x402Transactions: AggregatedTransaction[],
): AggregatedTransaction[] {
  if (x402Transactions.length === 0) return transactions

  const seen = new Set<string>()
  const merged: AggregatedTransaction[] = []

  const backendX402 = transactions.filter((tx) => tx.source === 'x402')
  const directTransactions = transactions.filter((tx) => tx.source !== 'x402')

  for (const tx of [...backendX402, ...x402Transactions, ...directTransactions]) {
    const key = `${tx.hash.toLowerCase()}:${tx.safeId}:${tx.source ?? 'direct'}`
    const existingHashKey = `${tx.hash.toLowerCase()}:${tx.safeId}`
    if (seen.has(key) || seen.has(existingHashKey)) continue

    merged.push(tx)
    seen.add(key)
    seen.add(existingHashKey)
  }

  return merged.sort((a, b) => (
    b.timestamp - a.timestamp ||
    b.blockNumber - a.blockNumber ||
    a.hash.localeCompare(b.hash)
  ))
}

function buildX402ActivityTransactions(
  activity: X402ActivityItem[],
  agents: AgentResponse[],
  safes: UserSafeResponse[],
  filters: TransactionFilterState,
): AggregatedTransaction[] {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const safesById = new Map(safes.map((safe) => [safe.id, safe]))
  const safesByAddress = new Map(
    safes.map((safe) => [safe.safe_address.toLowerCase(), safe]),
  )
  const tokenFilter = parseTokenKey(filters.tokenKey)

  return activity.flatMap((item) => {
    if (item.type !== 'payment') return []
    if (item.source !== 'x402') return []
    if (item.status !== 'confirmed') return []
    if (!item.tx_hash) return []

    const agent = item.agent_id ? agentsById.get(item.agent_id) : undefined
    if (filters.agentId === 'user') return []
    if (
      filters.agentId &&
      filters.agentId !== 'user' &&
      item.agent_id !== filters.agentId
    ) {
      return []
    }

    const safe = resolveSafe(item, agent, safesById, safesByAddress)
    const safeId = item.safe_id ?? agent?.safe_id ?? safe?.id
    if (!safeId) return []
    if (filters.safeId && safeId !== filters.safeId) return []

    const chainId = item.chain_id ?? safe?.chain_id ?? 100
    const tokenAddress = resolveTokenAddress(item, agent, chainId)
    if (tokenFilter) {
      if (chainId !== tokenFilter.chainId) return []
      if (tokenFilter.address === null) return []
      if (tokenAddress && tokenAddress !== tokenFilter.address) return []
      if (!tokenAddress && !tokenSymbolMatchesFilter(item.token, tokenFilter)) return []
    }

    const timestamp = parseActivityTimestamp(item.confirmed_at ?? item.created_at)
    const safeAddress = item.safe_address ?? agent?.safe_address ?? safe?.safe_address
    if (!safeAddress) return []

    return [{
      hash: item.tx_hash,
      type: 'erc20',
      from: safeAddress,
      to: item.x402_merchant_address ?? item.to,
      value: item.amount_raw ?? '',
      valueFormatted: item.amount,
      asset: item.token,
      decimals: resolveTokenDecimals(tokenAddress, chainId) ?? 18,
      direction: 'out',
      timestamp,
      blockNumber: 0,
      isError: false,
      tokenAddress: tokenAddress ?? undefined,
      tokenSymbol: item.token,
      agentId: item.agent_id,
      agentName: item.agent_name ?? agent?.name,
      chainId,
      safeId,
      safeAddress,
      safeName: item.safe_name ?? agent?.safe_name ?? safe?.name ?? 'Haven wallet',
      source: 'x402',
      x402ResourceUrl: item.x402_resource_url,
      x402MerchantAddress: item.x402_merchant_address,
      paymentId: item.id,
      paymentProofStatus: item.payment_proof_status ?? null,
      paymentFlowStatus: item.payment_flow_status ?? null,
      paymentAttentionReason: item.payment_attention_reason ?? null,
    }]
  })
}

function resolveSafe(
  item: X402ActivityItem,
  agent: AgentResponse | undefined,
  safesById: Map<string, UserSafeResponse>,
  safesByAddress: Map<string, UserSafeResponse>,
): UserSafeResponse | undefined {
  if (item.safe_id) return safesById.get(item.safe_id)
  if (agent?.safe_id) return safesById.get(agent.safe_id)
  if (item.safe_address) return safesByAddress.get(item.safe_address.toLowerCase())
  if (agent?.safe_address) return safesByAddress.get(agent.safe_address.toLowerCase())
  return undefined
}

function resolveTokenAddress(
  item: X402ActivityItem,
  agent: AgentResponse | undefined,
  chainId: number,
): string | null {
  if (item.token_address) return item.token_address.toLowerCase()

  const allowanceToken = agent?.allowances?.find(
    (allowance) => allowance.token_symbol === item.token,
  )?.token_address
  if (allowanceToken) return allowanceToken.toLowerCase()

  try {
    const token = Object.values(getChainConfig(chainId).tokens).find(
      (candidate) => candidate.symbol === item.token,
    )
    return token?.address?.toLowerCase() ?? null
  } catch {
    return null
  }
}

function resolveTokenDecimals(
  tokenAddress: string | null,
  chainId: number,
): number | null {
  if (!tokenAddress) return null

  try {
    const token = Object.values(getChainConfig(chainId).tokens).find(
      (candidate) => candidate.address?.toLowerCase() === tokenAddress,
    )
    return token?.decimals ?? null
  } catch {
    return null
  }
}

function parseTokenKey(tokenKey?: string): ParsedTokenFilter | null {
  if (!tokenKey) return null
  const [chainPart, addressPart] = tokenKey.split(':')
  const chainId = Number(chainPart)
  if (!Number.isFinite(chainId)) return null

  if (addressPart === 'native') return { chainId, address: null }
  if (!/^0x[0-9a-fA-F]{40}$/.test(addressPart)) return null
  return { chainId, address: addressPart.toLowerCase() }
}

function tokenSymbolMatchesFilter(
  symbol: string,
  tokenFilter: ParsedTokenFilter,
): boolean {
  if (!tokenFilter.address) return false

  try {
    const token = Object.values(getChainConfig(tokenFilter.chainId).tokens).find(
      (candidate) => candidate.address?.toLowerCase() === tokenFilter.address,
    )
    return token?.symbol === symbol
  } catch {
    return false
  }
}

function parseActivityTimestamp(value: string): number {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}
