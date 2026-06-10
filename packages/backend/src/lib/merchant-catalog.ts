/**
 * Merchant catalog verification (#348).
 *
 * The catalog's trust depends on prices being current. Each entry is
 * periodically probed against the live merchant: a request to the resource
 * URL is expected to return HTTP 402 with a parsable payment challenge. On
 * success the entry's price fields and `verified_at` are refreshed; when a
 * merchant stops answering 402 (or stops responding entirely) the entry is
 * flipped to `degraded` so the dashboard and `haven_discover_tools` can warn
 * instead of advertising stale offers.
 *
 * The probe is read-only — it never pays, signs, or follows the challenge.
 */
import pool from '../db.js'

export interface CatalogRow {
  id: string
  name: string
  description: string
  category: string
  resource_url: string
  rail: 'x402' | 'mpp'
  protocol: 'http' | 'mcp'
  tool_name: string | null
  price_display: string | null
  price_atomic: string | null
  asset: string | null
  network: string | null
  status: 'active' | 'degraded' | 'delisted'
  verified_at: string | null
  created_at: string
  updated_at: string
}

export interface ProbeResult {
  ok: boolean
  priceAtomic?: string
  priceDisplay?: string
  asset?: string
  network?: string
}

interface X402Accept {
  amount?: string
  maxAmountRequired?: string
  asset?: string
  network?: string
}

const TOKEN_DECIMALS: Record<string, number> = { USDC: 6, EURe: 18 }

function formatPriceDisplay(atomic: string, assetSymbol: string): string {
  const decimals = TOKEN_DECIMALS[assetSymbol] ?? 6
  const padded = atomic.padStart(decimals + 1, '0')
  const intPart = padded.slice(0, padded.length - decimals)
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '').padEnd(2, '0')
  return `$${intPart}.${frac} ${assetSymbol}`
}

function parseAccepts(payload: unknown): X402Accept | null {
  const accepts = (payload as { accepts?: unknown[] })?.accepts
  if (!Array.isArray(accepts) || accepts.length === 0) return null
  const first = accepts[0] as X402Accept
  const amount = first.maxAmountRequired ?? first.amount
  if (!amount || !/^[0-9]+$/.test(amount)) return null
  return first
}

/** Resolve a known asset address to a display symbol; pass symbols through. */
function assetSymbol(asset: string | undefined): string {
  if (!asset) return 'USDC'
  if (!asset.startsWith('0x')) return asset
  const known: Record<string, string> = {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
    '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0': 'USDC.e',
    '0xcb444e90d8198415266c6a2724b7900fb12fc56e': 'EURe',
  }
  return known[asset.toLowerCase()] ?? 'USDC'
}

/**
 * Probe one catalog entry. MCP merchants are probed with a JSON-RPC
 * tools/call POST (x402-gated MCP servers reply 402 to unpaid calls); plain
 * HTTP merchants with a GET. A challenge parsable from the PAYMENT-REQUIRED
 * header, MACHINE-PAYMENT-CHALLENGE header, or JSON body counts as verified.
 */
export async function probeCatalogEntry(
  entry: Pick<CatalogRow, 'resource_url' | 'protocol' | 'tool_name' | 'rail'>,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let response: Response
  try {
    if (entry.protocol === 'mcp') {
      response = await fetchImpl(entry.resource_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: entry.tool_name ?? 'unknown', arguments: {} },
        }),
      })
    } else {
      response = await fetchImpl(entry.resource_url, { method: 'GET' })
    }
  } catch {
    return { ok: false }
  }

  if (response.status !== 402) return { ok: false }

  if (entry.rail === 'mpp') {
    // MPP challenges carry display + atomic amounts directly.
    const header = response.headers.get('MACHINE-PAYMENT-CHALLENGE')
    let challenge: { amount?: { display?: string; atomic?: string }; asset?: { symbol?: string }; network?: { chainId?: number } } | undefined
    if (header) {
      try { challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) } catch { /* body fallback */ }
    }
    if (!challenge) {
      try { challenge = ((await response.json()) as { challenge?: typeof challenge }).challenge } catch { /* unparsable */ }
    }
    if (!challenge?.amount?.atomic) return { ok: false }
    const symbol = challenge.asset?.symbol ?? 'USDC'
    return {
      ok: true,
      priceAtomic: challenge.amount.atomic,
      priceDisplay: challenge.amount.display ? `$${challenge.amount.display} ${symbol}` : formatPriceDisplay(challenge.amount.atomic, symbol),
      asset: symbol,
      network: challenge.network?.chainId ? `eip155:${challenge.network.chainId}` : undefined,
    }
  }

  // x402: PAYMENT-REQUIRED header (base64 JSON) or JSON body with accepts[].
  let payload: unknown
  const header = response.headers.get('PAYMENT-REQUIRED')
  if (header) {
    try { payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) } catch { /* body fallback */ }
  }
  if (!payload) {
    try { payload = await response.json() } catch { return { ok: false } }
  }
  const accept = parseAccepts(payload)
  if (!accept) return { ok: false }

  const atomic = (accept.maxAmountRequired ?? accept.amount)!
  const symbol = assetSymbol(accept.asset)
  return {
    ok: true,
    priceAtomic: atomic,
    priceDisplay: formatPriceDisplay(atomic, symbol),
    asset: symbol,
    network: accept.network,
  }
}

/** Minimal queryable surface so tests can inject a fake pool. */
export interface QueryableLike {
  query: (text: string, values?: unknown[]) => Promise<{ rows: CatalogRow[] }>
}

/**
 * Probe every non-delisted entry and persist the outcome. Returns counts for
 * observability. Failures on individual entries never abort the run.
 */
export async function refreshCatalog(
  db: QueryableLike = pool as unknown as QueryableLike,
  fetchImpl: typeof fetch = fetch,
): Promise<{ verified: number; degraded: number }> {
  const { rows } = await db.query(
    `SELECT * FROM merchant_catalog WHERE status != 'delisted'`,
  )

  let verified = 0
  let degraded = 0
  for (const entry of rows) {
    const result = await probeCatalogEntry(entry, fetchImpl)
    if (result.ok) {
      verified++
      await db.query(
        `UPDATE merchant_catalog
         SET price_atomic = $2, price_display = $3, asset = $4,
             network = COALESCE($5, network),
             status = 'active', verified_at = now(), updated_at = now()
         WHERE id = $1`,
        [entry.id, result.priceAtomic, result.priceDisplay, result.asset, result.network ?? null],
      )
    } else {
      degraded++
      await db.query(
        `UPDATE merchant_catalog
         SET status = 'degraded', updated_at = now()
         WHERE id = $1`,
        [entry.id],
      )
    }
  }
  return { verified, degraded }
}
