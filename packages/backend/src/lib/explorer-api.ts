/**
 * Block explorer API client.
 *
 * Three providers are supported, all normalized to the Etherscan-style
 * `Raw*Tx` shapes so the transactions route doesn't need to care which
 * one is backing a given chain:
 *
 *   - etherscan-v2   Unified Etherscan V2 endpoint (needs API key, paid tier
 *                    for many chains including Base).
 *   - blockscout-v1  Blockscout's legacy Etherscan-compatible endpoint.
 *   - blockscout-v2  Blockscout's REST v2 API. Required for Base because
 *                    the v1 `tokentx` action times out with HTTP 524.
 *
 * The chain registry picks one per chain.
 */
import { getAddress } from 'ethers'
import { getChain } from './chains.js'

// ── Normalized tx shapes (Etherscan-compatible) ───────────────────

interface EtherscanResponse<T> {
  status: string
  message: string
  result: T
}

export interface RawNormalTx {
  blockNumber: string
  timeStamp: string
  hash: string
  from: string
  to: string
  value: string
  gas: string
  gasUsed: string
  isError: string
  functionName: string
}

export interface RawInternalTx {
  blockNumber: string
  timeStamp: string
  hash: string
  from: string
  to: string
  value: string
  isError: string
  type: string
}

export interface RawERC20Transfer {
  blockNumber: string
  timeStamp: string
  hash: string
  from: string
  to: string
  value: string
  contractAddress: string
  tokenName: string
  tokenSymbol: string
  tokenDecimal: string
}

// ── Etherscan-compatible v1 client (Etherscan V2 + Blockscout v1) ──

async function fetchFromV1<T>(
  chainId: number,
  params: Record<string, string>,
  retries = 2,
): Promise<T[]> {
  const chain = getChain(chainId)
  const url = new URL(chain.explorerApiUrl)

  if (chain.explorerApiProvider === 'etherscan-v2') {
    url.searchParams.set('chainid', String(chainId))
  }
  if (chain.explorerApiKey) {
    url.searchParams.set('apikey', chain.explorerApiKey)
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url.toString())

    if (!response.ok) {
      if (attempt < retries && (response.status === 429 || response.status >= 500)) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      throw new Error(`Explorer API error (chain ${chainId}): ${response.status}`)
    }

    const data = (await response.json()) as EtherscanResponse<T[] | string>

    if (typeof data.result === 'string') {
      const msg = data.result
      const lower = msg.toLowerCase()
      if (attempt < retries && lower.includes('rate limit')) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      if (lower.includes('no transactions found') || lower.includes('no token transfers found')) {
        return []
      }
      throw new Error(
        `Explorer API (chain ${chainId}, ${chain.explorerApiProvider}) refused request: ${msg}`,
      )
    }

    return data.result
  }
  return []
}

// ── Blockscout v2 client ───────────────────────────────────────────
//
// v2 is a REST API: GET /api/v2/addresses/{addr}/{resource}. The response
// is { items, next_page_params }. We only fetch the first page (matching
// the old Etherscan-style behavior of sort=desc + offset).

interface V2Page<T> {
  items: T[]
  next_page_params: unknown
}

interface V2AddressRef {
  hash: string
}

interface V2Transaction {
  hash: string
  block_number: number
  timestamp: string // ISO8601
  from: V2AddressRef | null
  to: V2AddressRef | null
  value: string
  gas_limit: string | number
  gas_used: string | number
  status: 'ok' | 'error' | null
  method: string | null
}

interface V2TokenTransfer {
  transaction_hash: string
  block_number: number
  timestamp: string
  from: V2AddressRef | null
  to: V2AddressRef | null
  total: { decimals: string; value: string }
  token: {
    address_hash: string
    name: string | null
    symbol: string | null
    decimals: string | null
  }
}

interface SafeTransferPage {
  count: number
  next: string | null
  previous: string | null
  results: SafeTransfer[]
}

export interface SafeTransfer {
  type: 'ETHER_TRANSFER' | 'ERC20_TRANSFER' | 'ERC721_TRANSFER' | string
  executionDate: string
  blockNumber: number
  transactionHash: string
  from: string | null
  to: string | null
  value: string | null
  tokenAddress: string | null
  tokenInfo?: {
    address: string
    name: string
    symbol: string
    decimals: number
  } | null
}

async function fetchFromV2<T>(
  chainId: number,
  resource: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const chain = getChain(chainId)
  // explorerApiUrl ends in /api/v2. The caller owns the address, so the
  // caller passes `addresses/${addr}/${resource}`.
  const url = new URL(`${chain.explorerApiUrl.replace(/\/$/, '')}/${resource}`)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)

  const response = await fetch(url.toString())
  if (!response.ok) {
    throw new Error(`Blockscout v2 error (chain ${chainId}): ${response.status}`)
  }
  const data = (await response.json()) as V2Page<T>
  return data.items ?? []
}

export async function fetchSafeServiceTransfers(
  chainId: number,
  address: string,
  offset = 50,
): Promise<SafeTransfer[]> {
  const chain = getChain(chainId)
  const checksumAddress = toChecksumAddress(address)
  const url = new URL(
    `${chain.safeTxServiceUrl.replace(/\/$/, '')}/api/v1/safes/${checksumAddress}/transfers/`,
  )
  url.searchParams.set('limit', String(offset))

  const response = await fetch(url.toString())
  if (!response.ok) {
    throw new Error(`Safe Transaction Service error (chain ${chainId}): ${response.status}`)
  }

  const data = (await response.json()) as SafeTransferPage
  return data.results ?? []
}

function toChecksumAddress(address: string): string {
  try {
    return getAddress(address)
  } catch {
    return address
  }
}

function isoToUnix(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '0' : String(Math.floor(ms / 1000))
}

// ── Public fetchers (provider-aware) ──────────────────────────────

export async function fetchNormalTransactions(
  chainId: number,
  address: string,
  _page = 1,
  offset = 50,
): Promise<RawNormalTx[]> {
  const chain = getChain(chainId)
  if (chain.explorerApiProvider === 'blockscout-v2') {
    const items = await fetchFromV2<V2Transaction>(
      chainId,
      `addresses/${address}/transactions`,
    )
    return items.slice(0, offset).map((tx) => ({
      blockNumber: String(tx.block_number),
      timeStamp: isoToUnix(tx.timestamp),
      hash: tx.hash,
      from: tx.from?.hash ?? '',
      to: tx.to?.hash ?? '',
      value: tx.value ?? '0',
      gas: String(tx.gas_limit ?? ''),
      gasUsed: String(tx.gas_used ?? ''),
      isError: tx.status === 'error' ? '1' : '0',
      functionName: tx.method ?? '',
    }))
  }
  return fetchFromV1<RawNormalTx>(chainId, {
    module: 'account',
    action: 'txlist',
    address,
    startblock: '0',
    endblock: '99999999',
    page: String(_page),
    offset: String(offset),
    sort: 'desc',
  })
}

export async function fetchInternalTransactions(
  chainId: number,
  address: string,
  _page = 1,
  offset = 50,
): Promise<RawInternalTx[]> {
  const chain = getChain(chainId)
  if (chain.explorerApiProvider === 'blockscout-v2') {
    // Base Blockscout's v2 internal-transactions endpoint is unreliable
    // (times out with 524). Internal txs on fresh Safes are rare and also
    // surface via the normal tx list, so skipping here is the pragmatic
    // tradeoff to keep the overall request fast.
    return []
  }
  type BlockscoutInternal = RawInternalTx & { transactionHash?: string }
  const raw = await fetchFromV1<BlockscoutInternal>(chainId, {
    module: 'account',
    action: 'txlistinternal',
    address,
    startblock: '0',
    endblock: '99999999',
    page: String(_page),
    offset: String(offset),
    sort: 'desc',
  })
  return raw.map((tx) => ({ ...tx, hash: tx.hash || tx.transactionHash || '' }))
}

export async function fetchERC20Transfers(
  chainId: number,
  address: string,
  _page = 1,
  offset = 50,
): Promise<RawERC20Transfer[]> {
  const chain = getChain(chainId)
  if (chain.explorerApiProvider === 'blockscout-v2') {
    const items = await fetchFromV2<V2TokenTransfer>(
      chainId,
      `addresses/${address}/token-transfers`,
      { type: 'ERC-20' },
    )
    return items.slice(0, offset).map((t) => ({
      blockNumber: String(t.block_number),
      timeStamp: isoToUnix(t.timestamp),
      hash: t.transaction_hash,
      from: t.from?.hash ?? '',
      to: t.to?.hash ?? '',
      value: t.total?.value ?? '0',
      contractAddress: t.token.address_hash,
      tokenName: t.token.name ?? '',
      tokenSymbol: t.token.symbol ?? '',
      tokenDecimal: t.token.decimals ?? t.total?.decimals ?? '18',
    }))
  }
  return fetchFromV1<RawERC20Transfer>(chainId, {
    module: 'account',
    action: 'tokentx',
    address,
    startblock: '0',
    endblock: '99999999',
    page: String(_page),
    offset: String(offset),
    sort: 'desc',
  })
}
