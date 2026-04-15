import { config } from '../config.js'

// Etherscan V2 API (unified endpoint for all chains)
const BASE_URL = 'https://api.etherscan.io/v2/api'
const CHAIN_ID = 100 // Gnosis Chain

function getApiKey(): string {
  return config.gnosisscanApiKey
}

interface GnosisscanResponse<T> {
  status: string
  message: string
  result: T
}

// --- Raw response types from Gnosisscan ---

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

async function fetchFromGnosisscan<T>(
  params: Record<string, string>,
  retries = 2,
): Promise<T[]> {
  const url = new URL(BASE_URL)
  url.searchParams.set('chainid', String(CHAIN_ID))
  url.searchParams.set('apikey', getApiKey())

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url.toString())

    if (!response.ok) {
      // Retry on rate limit (429) or server errors (5xx)
      if (attempt < retries && (response.status === 429 || response.status >= 500)) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      throw new Error(`Gnosisscan API error: ${response.status}`)
    }

    const data = (await response.json()) as GnosisscanResponse<T[] | string>

    // Gnosisscan returns rate limit messages as string results too
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

export async function fetchNormalTransactions(
  address: string,
  page = 1,
  offset = 50,
): Promise<RawNormalTx[]> {
  return fetchFromGnosisscan<RawNormalTx>({
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
  address: string,
  page = 1,
  offset = 50,
): Promise<RawInternalTx[]> {
  return fetchFromGnosisscan<RawInternalTx>({
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
  address: string,
  page = 1,
  offset = 50,
): Promise<RawERC20Transfer[]> {
  return fetchFromGnosisscan<RawERC20Transfer>({
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
