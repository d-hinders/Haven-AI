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
import { getChain } from '../domain/chains.js'

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
// is { items, next_page_params }, and `next_page_params` is the cursor for
// the following page. `fetchFromV2` walks that cursor up to
// EXPLORER_MAX_PAGES pages per read (#2884).

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

async function fetchFromV2<T>(
  chainId: number,
  resource: string,
  query: Record<string, string> = {},
): Promise<{ items: T[]; hasNextPage: boolean }> {
  const chain = getChain(chainId)
  // explorerApiUrl ends in /api/v2. The caller owns the address, so the
  // caller passes `addresses/${addr}/${resource}`.
  const url = new URL(`${chain.explorerApiUrl.replace(/\/$/, '')}/${resource}`)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)

  const items: T[] = []
  // #2884: follow the provider's own cursor until it is absent (exhausted)
  // or the page budget is spent. `hasNextPage` stays honest about WHICH way
  // the loop ended: a spent budget with the provider still offering a cursor
  // is a capped read, an absent cursor is a complete one.
  for (let page = 0; page < EXPLORER_MAX_PAGES; page++) {
    const response = await fetch(url.toString())
    if (!response.ok) {
      throw new Error(`Blockscout v2 error (chain ${chainId}): ${response.status}`)
    }
    const data = (await response.json()) as V2Page<T>
    items.push(...(data.items ?? []))
    // The explorer's own answer, not an inference from how many rows it sent.
    const next = data.next_page_params
    if (next === null || next === undefined) {
      return { items, hasNextPage: false }
    }
    // Blockscout echoes next-page query params; they replace this page's
    // query wholesale. Same query object each hop — the cursor carries the
    // position (block_number/index for transactions, token-transfer cursor).
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
      url.searchParams.set(k, String(v))
    }
  }
  return { items, hasNextPage: true }
}

function isoToUnix(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '0' : String(Math.floor(ms / 1000))
}

/**
 * Rows one leg requests per page. On the Etherscan-shaped v1 legs it is sent
 * as the `offset` query parameter, so it is a genuine page size the provider
 * honours. On the Blockscout v2 legs (Base, the default chain) the provider
 * takes no page-size parameter and returns its own page; the value is only
 * the historical size of the local slice there, and the page COUNT is the
 * budget instead (`EXPLORER_MAX_PAGES`).
 */
export const EXPLORER_PAGE_SIZE = 50

/**
 * Pages one leg may read per call, the #2884 pagination budget.
 *
 * A fixed per-leg page cap, deliberately, and the same on every read path:
 *
 * - A row budget shared across legs would couple them — a token-heavy
 *   account would starve the native leg — and a time box is not
 *   deterministic enough to test the loop's shape. Pages are.
 * - Worst case is 4 pages x 3 legs = 12 explorer requests per account per
 *   uncached read, against 3 before. Both providers rate-limit, but the
 *   fetchers retry 429/5xx with linear backoff, and the legs run sequentially
 *   per account behind a 30-second per-account cache, which is what keeps the
 *   dashboard fan-out (every account on every uncached load) inside the
 *   free-tier budgets. Paginating only the export path would still put the
 *   fan-out behind the dashboard's own Load more button, so the budget is
 *   paid on the list route too and both paths see the same rows.
 *
 * When the budget is spent the leg reports `hasMore: true` — a capped read
 * surfaces as `truncated` upstream (#2882) instead of silently claiming a
 * completeness it did not check.
 */
export const EXPLORER_MAX_PAGES = 4

/**
 * The Etherscan-compatible legs have no cursor: the provider answers
 * `page`/`offset` requests, and the only completion signal is a page that
 * comes back SHORT — `offset` is requested explicitly, so exactly
 * `offset` rows means "more exist". Walk pages until a short page or the
 * budget; a full page at the budget is a capped read (`hasMore: true`).
 *
 * This replaces #2882's count-only hedge ("a full page MIGHT have more").
 * The hedge existed because the first window was all the leg ever read;
 * with pagination the short page is a real answer, and the flag errs the
 * other way only once — exactly at the budget, where more provably remains.
 */
async function paginateEtherscanLeg<T>(
  fetchPage: (page: number) => Promise<T[]>,
): Promise<{ rows: T[]; hasMore: boolean }> {
  const rows: T[] = []
  for (let page = 1; page <= EXPLORER_MAX_PAGES; page++) {
    const pageRows = await fetchPage(page)
    rows.push(...pageRows)
    if (pageRows.length < EXPLORER_PAGE_SIZE) {
      return { rows, hasMore: false }
    }
  }
  return { rows, hasMore: true }
}

/**
 * One leg's rows plus whether the read was capped before the source ran out
 * (#2882, paginated by #2884).
 *
 * `hasMore` is NOT `rows.length >= EXPLORER_PAGE_SIZE`, and the difference
 * matters on the default chain. Blockscout v2 takes no page-size parameter —
 * it returns its own page — so a count test there measures Blockscout's
 * default rather than anything Haven asked for, and would start lying the
 * day that default changed. Blockscout hands back `next_page_params` when
 * there is another page, so that is what is read: the cursor followed to
 * exhaustion or to `EXPLORER_MAX_PAGES`. The Etherscan-shaped v1 legs have
 * no cursor, so the loop pages until a short page — the only honest
 * completion signal where `offset` is requested explicitly — and reports
 * `hasMore` only when the budget is spent on a full page.
 */
export interface ExplorerLeg<T> {
  rows: T[]
  hasMore: boolean
}

// ── Public fetchers (provider-aware) ──────────────────────────────

export async function fetchNormalTransactions(
  chainId: number,
  address: string,
  _page = 1,
  offset = EXPLORER_PAGE_SIZE,
): Promise<ExplorerLeg<RawNormalTx>> {
  const chain = getChain(chainId)
  if (chain.explorerApiProvider === 'blockscout-v2') {
    const { items, hasNextPage } = await fetchFromV2<V2Transaction>(
      chainId,
      `addresses/${address}/transactions`,
    )
    const rows = items.map((tx) => ({
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
    // No local slice: the page budget lives in `fetchFromV2` now, and the
    // provider's cursor is the only "more exist" signal that means anything
    // on a provider that sets its own page size.
    return { rows, hasMore: hasNextPage }
  }
  const { rows, hasMore } = await paginateEtherscanLeg<RawNormalTx>((page) =>
    fetchFromV1<RawNormalTx>(chainId, {
      module: 'account',
      action: 'txlist',
      address,
      startblock: '0',
      endblock: '99999999',
      page: String(page),
      offset: String(offset),
      sort: 'desc',
    }),
  )
  return { rows, hasMore }
}

export async function fetchInternalTransactions(
  chainId: number,
  address: string,
  _page = 1,
  offset = EXPLORER_PAGE_SIZE,
): Promise<ExplorerLeg<RawInternalTx>> {
  const chain = getChain(chainId)
  if (chain.explorerApiProvider === 'blockscout-v2') {
    // Base Blockscout's v2 internal-transactions endpoint is unreliable
    // (times out with 524). Internal txs on fresh Safes are rare and also
    // surface via the normal tx list, so skipping here is the pragmatic
    // tradeoff to keep the overall request fast. Skipped, not truncated —
    // this leg must not make the feed claim a capped read.
    return { rows: [], hasMore: false }
  }
  type BlockscoutInternal = RawInternalTx & { transactionHash?: string }
  const { rows: raw, hasMore } = await paginateEtherscanLeg<BlockscoutInternal>((page) =>
    fetchFromV1<BlockscoutInternal>(chainId, {
      module: 'account',
      action: 'txlistinternal',
      address,
      startblock: '0',
      endblock: '99999999',
      page: String(page),
      offset: String(offset),
      sort: 'desc',
    }),
  )
  return {
    rows: raw.map((tx) => ({ ...tx, hash: tx.hash || tx.transactionHash || '' })),
    hasMore,
  }
}

export async function fetchERC20Transfers(
  chainId: number,
  address: string,
  _page = 1,
  offset = EXPLORER_PAGE_SIZE,
): Promise<ExplorerLeg<RawERC20Transfer>> {
  const chain = getChain(chainId)
  if (chain.explorerApiProvider === 'blockscout-v2') {
    const { items, hasNextPage } = await fetchFromV2<V2TokenTransfer>(
      chainId,
      `addresses/${address}/token-transfers`,
      { type: 'ERC-20' },
    )
    const rows = items.map((t) => ({
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
    return { rows, hasMore: hasNextPage }
  }
  const { rows, hasMore } = await paginateEtherscanLeg<RawERC20Transfer>((page) =>
    fetchFromV1<RawERC20Transfer>(chainId, {
      module: 'account',
      action: 'tokentx',
      address,
      startblock: '0',
      endblock: '99999999',
      page: String(page),
      offset: String(offset),
      sort: 'desc',
    }),
  )
  return { rows, hasMore }
}
