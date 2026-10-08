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
// dep-lint-exempt: pool appears only as the default of the injectable QueryableLike executor (index.ts and tests inject their own); the probe-driven refresh/ingest updates it feeds await a catalog repository (beyond #999's ~100-line budget)
import pool from '../../db.js'

export interface CatalogRow {
  id: string
  name: string
  description: string
  category: string
  resource_url: string
  rail: 'x402' | 'mpp'
  protocol: 'http' | 'mcp'
  tool_name: string | null
  tool_arguments: Record<string, unknown> | null
  price_display: string | null
  price_atomic: string | null
  asset: string | null
  network: string | null
  status: 'active' | 'degraded' | 'delisted'
  verified_at: string | null
  consecutive_failures: number
  /**
   * Comma-separated set of x402 `assetTransferMethod`s the merchant advertises
   * (e.g. `eip3009` or `eip3009,erc7710`). NULL until the first successful x402
   * probe; MPP entries (not an x402 rail) stay NULL. See migration 037.
   */
  asset_transfer_methods: string | null
  /**
   * The lowercased `payTo` the entry's x402 challenge names, when every
   * `accepts[]` option names the same well-formed one (#3331, migration 101).
   * NULL for MPP rows, before the first successful probe, and when the
   * challenge names none or disagrees with itself.
   */
  pay_to: string | null
  /**
   * #3769: the JSON Schema a per-call MCP tool's caller arguments must
   * satisfy (`haven_prepare_catalog_purchase` validates against it). NULL on
   * a fixed-SKU row — caller arguments are refused there. Optional because a
   * test fixture may predate migration 107.
   */
  tool_arguments_schema?: Record<string, unknown> | null
  /**
   * #3769: the HTTP method a plain-HTTP x402 resource needs (e.g. 'POST').
   * NULL means GET. Only meaningful for `protocol: 'http'` rows.
   */
  http_method?: string | null
  /** #3769: the body encoding of `body_example` — 'json' today, NULL when none. */
  body_type?: string | null
  /** #3769: an example body the row's probe and discovery hint carry. */
  body_example?: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/**
 * Consecutive failed probes before an entry is shown as degraded. A single
 * transient miss (cold start, network blip, MCP servers that want an
 * `initialize` before `tools/call`) should not alarm users — only a sustained
 * outage should.
 */
export const DEGRADE_AFTER_FAILURES = 3

export interface ProbeResult {
  ok: boolean
  priceAtomic?: string
  priceDisplay?: string
  asset?: string
  network?: string
  /**
   * Distinct x402 `assetTransferMethod`s advertised across all `accepts[]`
   * options on the recorded network, in first-seen order (e.g. `['eip3009',
   * 'erc7710']`). Undefined for non-x402 rails (MPP) and when the challenge
   * carries no `accepts[]`.
   */
  assetTransferMethods?: string[]
  /**
   * The lowercased `payTo` every `accepts[]` option agrees on (#3331).
   * Undefined for MPP and whenever there is no single well-formed one.
   */
  payTo?: string
  /**
   * #3769: an HTTP method the challenge itself advertises (a structured
   * `resource.method` on the 402), when present. The live 402 is
   * authoritative for how it is called, so `refreshCatalog` writes it back
   * onto the row — a row declaring GET whose challenge says POST is
   * corrected, not silently quoted with the wrong method.
   */
  advertisedMethod?: string
}

interface X402Accept {
  amount?: string
  maxAmountRequired?: string
  asset?: string
  network?: string
  payTo?: string
  extra?: { assetTransferMethod?: string }
}

/** x402 exact-EVM default when an `accepts[]` option omits the method. */
const DEFAULT_ASSET_TRANSFER_METHOD = 'eip3009'

/**
 * The distinct `assetTransferMethod`s a merchant advertises on the RECORDED
 * network (#3386) — `accepts[0]`'s, the same scoping `collectPayTo` already
 * uses and the one the row's own `network`/price columns are read from. Per
 * the x402 exact-EVM spec an omitted method means EIP-3009, so a plain
 * merchant reports `['eip3009']` and an ERC-7710-capable one that lists both
 * on that network reports `['eip3009', 'erc7710']`. Scanning every option ON
 * THAT NETWORK (not just the first) still matters — merchants keep the
 * EIP-3009 option first for compatibility and add `erc7710` alongside it —
 * but an option on a DIFFERENT network says nothing about what this row's
 * network accepts. Before this, a challenge listing EIP-3009 on one network
 * and ERC-7710 on another recorded the union on whichever network happened to
 * be `accepts[0]`'s, so a merchant-locked budget could be built for a network
 * the merchant never accepts ERC-7710 on there — stranding the budget, never
 * misdirecting money.
 */
function collectAssetTransferMethods(payload: unknown): string[] | undefined {
  const accepts = (payload as { accepts?: unknown[] })?.accepts
  if (!Array.isArray(accepts) || accepts.length === 0) return undefined
  const network = (accepts[0] as X402Accept | null)?.network
  const methods: string[] = []
  for (const entry of accepts) {
    if ((entry as X402Accept | null)?.network !== network) continue
    const method = (entry as X402Accept).extra?.assetTransferMethod ?? DEFAULT_ASSET_TRANSFER_METHOD
    if (!methods.includes(method)) methods.push(method)
  }
  return methods.length > 0 ? methods : undefined
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * The one `payTo` a challenge names, lowercased (#3331). Every `accepts[]`
 * option on the recorded network must name a well-formed address and they must all be the same one:
 * a merchant-locked budget pins `transfer(to)` to this address, so a
 * challenge that names two (or one option that names none) has not told us
 * where "this merchant" is paid, and the answer is none rather than the
 * first one seen.
 */
function collectPayTo(payload: unknown): string | undefined {
  const accepts = (payload as { accepts?: unknown[] })?.accepts
  if (!Array.isArray(accepts) || accepts.length === 0) return undefined
  // Only the options on the network this row records (accepts[0]'s, the one
  // the price is read from): a Base + Solana merchant names a base58 payTo on
  // the other option, and a merchant may be paid at different addresses on
  // different chains. Neither says anything about where it is paid HERE.
  const network = (accepts[0] as X402Accept | null)?.network
  let payTo: string | undefined
  for (const entry of accepts) {
    if ((entry as X402Accept | null)?.network !== network) continue
    const candidate = (entry as X402Accept | null)?.payTo
    if (typeof candidate !== 'string' || !EVM_ADDRESS.test(candidate)) return undefined
    const lowered = candidate.toLowerCase()
    if (payTo !== undefined && payTo !== lowered) return undefined
    payTo = lowered
  }
  return payTo
}

const TOKEN_DECIMALS: Record<string, number> = { USDC: 6 }

function formatPriceDisplay(atomic: string, assetSymbol: string): string {
  const decimals = TOKEN_DECIMALS[assetSymbol] ?? 6
  const padded = atomic.padStart(decimals + 1, '0')
  const intPart = padded.slice(0, padded.length - decimals)
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '').padEnd(2, '0')
  // #1592: `<human amount> <asset code>`, no `$` prefix — the symbol plus the
  // code double-states the currency, and no catalog asset is actual USD.
  return `${intPart}.${frac} ${assetSymbol}`
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
  entry: Pick<
    CatalogRow,
    'resource_url' | 'protocol' | 'tool_name' | 'tool_arguments' | 'rail' | 'http_method' | 'body_type' | 'body_example'
  >,
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
          params: { name: entry.tool_name ?? 'unknown', arguments: entry.tool_arguments ?? {} },
        }),
      })
    } else {
      // #3769: probe with the row's DECLARED call shape. The old GET-only
      // probe verified a request the merchant cannot answer usefully —
      // Anchor's POST price endpoint answers a GET 402 too (the challenge is
      // method-agnostic), but the paid call the row leads to is a POST with
      // a body, and that is the shape the verifier must exercise.
      const method = (entry.http_method ?? 'GET').toUpperCase()
      const init: RequestInit = { method }
      // Only JSON bodies are declared today; a body_example on a GET/HEAD row
      // is operator error and is simply not sent.
      if (entry.body_example != null && (entry.body_type ?? 'json') === 'json' && method !== 'GET' && method !== 'HEAD') {
        init.body = JSON.stringify(entry.body_example)
        init.headers = { 'Content-Type': 'application/json' }
      }
      response = await fetchImpl(entry.resource_url, init)
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
      priceDisplay: challenge.amount.display ? `${challenge.amount.display} ${symbol}` : formatPriceDisplay(challenge.amount.atomic, symbol),
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

  // #3769: a challenge that STRUCTUREDLY advertises its own method (a
  // `resource.method` on the 402) — Anchor's challenge only describes the
  // POST wrapper in its free-text resource description, which is never
  // parsed; a structured declaration is the only machine-readable one.
  const advertised = (payload as { resource?: { method?: unknown } })?.resource?.method
  const advertisedMethod = typeof advertised === 'string' && advertised.trim() ? advertised.trim().toUpperCase() : undefined

  const atomic = (accept.maxAmountRequired ?? accept.amount)!
  const symbol = assetSymbol(accept.asset)
  return {
    ok: true,
    priceAtomic: atomic,
    priceDisplay: formatPriceDisplay(atomic, symbol),
    asset: symbol,
    network: accept.network,
    assetTransferMethods: collectAssetTransferMethods(payload),
    payTo: collectPayTo(payload),
    ...(advertisedMethod ? { advertisedMethod } : {}),
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
      // Success always recovers the entry and clears the failure streak.
      await db.query(
        `UPDATE merchant_catalog
         SET price_atomic = $2, price_display = $3, asset = $4,
             network = COALESCE($5, network),
             asset_transfer_methods = COALESCE($6, asset_transfer_methods),
             pay_to = $7,
             http_method = COALESCE($8, http_method),
             status = 'active', verified_at = now(),
             consecutive_failures = 0, updated_at = now()
         WHERE id = $1`,
        [
          entry.id,
          result.priceAtomic,
          result.priceDisplay,
          result.asset,
          result.network ?? null,
          result.assetTransferMethods?.join(',') ?? null,
          // #3331: written as seen, NOT COALESCEd like the fields above — a
          // merchant that stops naming one payTo must lose its verified one
          // (the merchant-locked-budget action then disappears) rather than
          // keep pinning budgets to an address its own challenge no longer
          // names. A rotation lands here as a different value, which is what
          // flags the budgets pinned to the old one as stale.
          result.payTo ?? null,
          // #3769: a 402 that advertises its own method corrects the row —
          // the live challenge is authoritative for how it is called (the
          // same doctrine the price fields above follow). HTTP rows only: an
          // MCP row's challenge never advertises one, and a stray value must
          // not leak onto a row whose probe is a tools/call.
          entry.protocol === 'http' ? (result.advertisedMethod ?? null) : null,
        ],
      )
    } else {
      // Hysteresis: count the miss, but only degrade after a sustained streak
      // so one flaky probe doesn't light up the whole catalog.
      const failures = (entry.consecutive_failures ?? 0) + 1
      const nextStatus = failures >= DEGRADE_AFTER_FAILURES ? 'degraded' : entry.status
      if (nextStatus === 'degraded') degraded++
      await db.query(
        `UPDATE merchant_catalog
         SET consecutive_failures = $2, status = $3, updated_at = now()
         WHERE id = $1`,
        [entry.id, failures, nextStatus],
      )
    }
  }
  return { verified, degraded }
}
