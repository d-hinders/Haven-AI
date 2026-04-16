/**
 * Block explorer API client (Etherscan V2 — unified endpoint for all EVM chains).
 *
 * Parameterized by chainId so it works for Gnosis, Base, and future chains.
 */
import { getChain } from './chains.js'

// ── Raw response types from Etherscan V2 ──────────────────────────

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

// ── Core fetch ────────────────────────────────────────────────────

async function fetchFromExplorer<T>(
  chainId: number,
  params: Record<string, string>,
  retries = 2,
): Promise<T[]> {
  const chain = getChain(chainId)
  const url = new URL(chain.explorerApiUrl)
  url.searchParams.set('chainid', String(chainId))
  url.searchParams.set('apikey', chain.explorerApiKey)

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
      if (attempt < retries && data.result.toLowerCase().includes('rate limit')) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      return []
    }

    return data.result
  }

  return []
}

// ── Public API ────────────────────────────────────────────────────

export async function fetchNormalTransactions(
  chainId: number,
  address: string,
  page = 1,
  offset = 50,
): Promise<RawNormalTx[]> {
  return fetchFromExplorer<RawNormalTx>(chainId, {
    module: 'account',
    action: 'txlist',
    address,
    startblock: '0',
    endblock: '99999999',
    page: String(page),
    offset: String(offset),
    sort: 'desc',
  })
}

export async function fetchInternalTransactions(
  chainId: number,
  address: string,
  page = 1,
  offset = 50,
): Promise<RawInternalTx[]> {
  return fetchFromExplorer<RawInternalTx>(chainId, {
    module: 'account',
    action: 'txlistinternal',
    address,
    startblock: '0',
    endblock: '99999999',
    page: String(page),
    offset: String(offset),
    sort: 'desc',
  })
}

export async function fetchERC20Transfers(
  chainId: number,
  address: string,
  page = 1,
  offset = 50,
): Promise<RawERC20Transfer[]> {
  return fetchFromExplorer<RawERC20Transfer>(chainId, {
    module: 'account',
    action: 'tokentx',
    address,
    startblock: '0',
    endblock: '99999999',
    page: String(page),
    offset: String(offset),
    sort: 'desc',
  })
}
