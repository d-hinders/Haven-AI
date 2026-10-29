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
 *
 * ## Every probe goes through the SSRF guard (#4281)
 *
 * A row's URL is not always one an operator chose. Since #4245, where
 * `CATALOG_DISCOVERY_ENABLED=true` the discovery cron inserts seller-listed
 * x402 Bazaar URLs (`source = 'bazaar'`), and the refresh re-probes every
 * non-delisted row. So the default transport here is `guardedCatalogFetch`:
 * the shared SSRF guard (`infra/http/ssrf-guard.ts`, #1712) classifies the
 * resolved address, pins the socket to it, and bounds the deadline, byte
 * count and redirects. The refresh gets a 15 s deadline, enough for a
 * sleeping merchant's cold start; a discovery candidate gets the ingestion
 * probe's 5 s. One rule for every row: no branch on `source` to keep
 * correct. A refusal is a failed probe, never a crash.
 */
// dep-lint-exempt: pool appears only as the default of the injectable QueryableLike executor (index.ts and tests inject their own); the probe-driven refresh/ingest updates it feeds await a catalog repository (beyond #999's ~100-line budget)
import pool from '../../db.js'
import { getChainData } from '@haven_ai/core'
import {
  normalizePaymentRequired,
  selectErc7710PaymentOption,
  selectStandardPaymentOption,
  selectX402SettlementScheme,
  x402AuthorizationAmount,
  type X402PaymentOption,
} from '@haven_ai/sdk'
import { safeRequest, type SafeFetchOptions } from '../../infra/http/ssrf-guard.js'

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
   * test fixture may predate migration 108.
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
  /**
   * #4245: who wrote the row — `'operator'` (migrations, scripts; the
   * column default) or `'bazaar'` (the discovery cron). Migration 117.
   * Optional because a test fixture may predate it.
   */
  source?: CatalogRowSource
  created_at: string
  updated_at: string
}

/** The closed vocabulary of `merchant_catalog.source` (migration 117's CHECK). */
export type CatalogRowSource = 'operator' | 'bazaar'

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
  network?: string
  payTo?: string
}

/**
 * The x402 network names the pay path can settle on, mapped to the chain id
 * the row records as CAIP-2: Base and Base Sepolia, each as CAIP-2 or as the
 * x402 short name. This is a copy of the SDK's `STANDARD_X402_NETWORKS`,
 * which `@haven_ai/sdk` does not export, so no test can compare the two maps
 * directly. Two things keep the copy honest instead: the parity test runs
 * every name listed here through the SDK selector and expects it settled,
 * and a selected option on a network missing from this map is a miss (see
 * `selectCatalogPaymentOption`), never a row on a guessed chain.
 */
const X402_NETWORK_CHAIN_ID: Record<string, number> = {
  'eip155:8453': 8453,
  base: 8453,
  'eip155:84532': 84532,
  'base-sepolia': 84532,
}

/**
 * A fixed envelope for `normalizePaymentRequired`, so the SDK applies its
 * per-option rule to an `accepts[]` on its own (discovery has only the
 * index's `accepts[]`, no envelope). The values are never read back: only
 * the normalized `accepts` is used.
 */
const OPTION_RULE_ENVELOPE = { x402Version: 2, resource: { url: 'urn:haven:catalog-option-rule' } }

/**
 * The `accepts[]` options the pay path keeps (#4389), normalized exactly as
 * it normalizes them. Every pay path first runs the 402 through the SDK's
 * `normalizePaymentRequired` (`parsePaymentRequired`,
 * `extractMcpPaymentRequired`), which drops an option whose scheme, network,
 * asset or `payTo` is not a string, whose amount is not a positive decimal
 * string, or whose `maxAmountRequired` is present but not one (null
 * included). The catalog calls that same function rather than copying its
 * rule, so the two cannot drift.
 *
 * Only the per-option rule is applied here. The envelope checks
 * (`x402Version`, a resource URL) are not: the envelope above satisfies them.
 *
 * Total: the merchant's 402 is untrusted shape, and a dropped option is
 * simply not an option. The SDK function does not throw on parsed JSON; the
 * catch keeps the verdict a miss if that ever changes, and logs it (#4341)
 * without the payload.
 */
function payPathOptions(payload: unknown): X402PaymentOption[] {
  const accepts = (payload as { accepts?: unknown } | null | undefined)?.accepts
  if (!Array.isArray(accepts)) return []
  try {
    return normalizePaymentRequired({ ...OPTION_RULE_ENVELOPE, accepts })?.accepts ?? []
  } catch (err) {
    console.warn(`[catalog] could not normalize a challenge's options: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/** What the catalog's payability verdict selected from a challenge (#4389). */
export interface CatalogPaymentSelection {
  option: X402PaymentOption
  scheme: 'erc7710' | 'eip3009'
  /** The selected option's chain, e.g. 8453. */
  chainId: number
  /** The same chain as CAIP-2, the form the row's `network` column holds. */
  network: string
  /** The asset's symbol from the chain registry (`@haven_ai/core`). */
  assetSymbol: string
  assetDecimals: number
}

/**
 * THE catalog payability verdict (#4389), shared by the refresh probe and
 * discovery so the catalog judges a 402 the way the pay path does.
 *
 * It keeps the options the pay path keeps (`payPathOptions`, the SDK's own
 * `normalizePaymentRequired` rule), then runs the pay path's own selector,
 * `selectX402SettlementScheme` from `@haven_ai/sdk`, over ALL of them, not
 * `accepts[0]`. The rail
 * half of that rule is fixed to `delegationRail: true`: the catalog has no
 * account in hand, every live account is on the delegation rail (the retired
 * rails answer 410, #1986), and `haven_quote_catalog_purchase` selects with
 * the rail it reads from the agent. So the row records the option a live
 * agent will actually be quoted: erc7710 where the merchant offers a payable
 * erc7710 entry, else the EIP-3009 bridge. `null` means no option is
 * payable, and the probe treats that as a miss.
 *
 * The asset is labelled from the chain registry, on the selected option's own
 * chain only. An asset the registry does not know on that chain is not
 * payable, never guessed. Here the catalog is deliberately STRICTER than the
 * SDK selector: the selector accepts either Base network's USDC address on
 * either Base network, so it selects Base USDC on a Base Sepolia option. The
 * backend's authorize step resolves the asset on the agent's own chain only
 * (`resolvePaymentToken(agent.chain_id, asset)`), so no agent on that
 * option's chain can pay it, and the catalog records a miss rather than a
 * USDC row nobody there can buy.
 */
export function selectCatalogPaymentOption(payload: unknown): CatalogPaymentSelection | null {
  const selection = selectX402SettlementScheme(payPathOptions(payload), { delegationRail: true })
  if (!selection) return null
  const chainId = X402_NETWORK_CHAIN_ID[selection.option.network]
  if (chainId === undefined) return null
  const token = registryToken(selection.option.asset, chainId)
  if (!token) return null
  return {
    option: selection.option,
    scheme: selection.scheme,
    chainId,
    network: `eip155:${chainId}`,
    assetSymbol: token.symbol,
    assetDecimals: token.decimals,
  }
}

/**
 * The registry's token for an asset address on the option's own chain, and
 * only there: the chain the authorize step resolves it on (see
 * `selectCatalogPaymentOption`).
 */
function registryToken(asset: string, chainId: number): { symbol: string; decimals: number } | undefined {
  const lowered = asset.toLowerCase()
  return getChainData(chainId).tokens.find((t) => t.address !== null && t.address.toLowerCase() === lowered)
}

/** True when an `accepts[]` entry is on the given chain, whichever name it uses. */
function onChain(entry: unknown, chainId: number): boolean {
  const network = (entry as X402Accept | null)?.network
  return typeof network === 'string' && X402_NETWORK_CHAIN_ID[network] === chainId
}

/**
 * The settlement schemes a merchant offers PAYABLY on the recorded chain
 * (#3386, #4389), in first-seen order: an option counts as `erc7710` when the
 * SDK's erc7710 selector accepts it, as `eip3009` when the standard selector
 * does, and not at all otherwise. Scanning every option on that chain still
 * matters — merchants keep the EIP-3009 option first for compatibility and add
 * `erc7710` alongside it — but an option on a different chain, or one the pay
 * path could not settle, says nothing about what a budget on this row can use.
 */
function collectAssetTransferMethods(payload: unknown, chainId: number): string[] | undefined {
  const methods: string[] = []
  for (const option of payPathOptions(payload)) {
    if (!onChain(option, chainId)) continue
    const method = selectErc7710PaymentOption([option])
      ? 'erc7710'
      : selectStandardPaymentOption([option])
        ? 'eip3009'
        : undefined
    if (method && !methods.includes(method)) methods.push(method)
  }
  return methods.length > 0 ? methods : undefined
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * The one `payTo` a challenge names, lowercased (#3331). Every `accepts[]`
 * option on the recorded chain must name a well-formed address and they must
 * all be the same one: a merchant-locked budget pins `transfer(to)` to this
 * address, so a challenge that names two (or one option that names none) has
 * not told us where "this merchant" is paid, and the answer is none rather
 * than the first one seen.
 */
function collectPayTo(payload: unknown, chainId: number): string | undefined {
  const accepts = (payload as { accepts?: unknown[] })?.accepts
  if (!Array.isArray(accepts)) return undefined
  // Only the options on the chain this row records (the selected option's,
  // the one the price is read from): a Base + Solana merchant names a base58
  // payTo on the other option, and a merchant may be paid at different
  // addresses on different chains. Neither says anything about where it is
  // paid HERE.
  let payTo: string | undefined
  for (const entry of accepts) {
    if (!onChain(entry, chainId)) continue
    const candidate = (entry as X402Accept | null)?.payTo
    if (typeof candidate !== 'string' || !EVM_ADDRESS.test(candidate)) return undefined
    const lowered = candidate.toLowerCase()
    if (payTo !== undefined && payTo !== lowered) return undefined
    payTo = lowered
  }
  return payTo
}

function formatPriceDisplay(atomic: string, assetSymbol: string, decimals = 6): string {
  const padded = atomic.padStart(decimals + 1, '0')
  const intPart = padded.slice(0, padded.length - decimals)
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '').padEnd(2, '0')
  // #1592: `<human amount> <asset code>`, no `$` prefix — the symbol plus the
  // code double-states the currency, and no catalog asset is actual USD.
  return `${intPart}.${frac} ${assetSymbol}`
}

/**
 * Total budget for one REFRESH probe, redirects included. The refresh
 * re-probes listed merchants hourly, and a sleeping one (Railway serverless,
 * e.g. the dev Demo-merchant) cold-starts on that probe: measured 3.8–5.0 s on
 * 2026-10-22. The budget sits well above that, but stays bounded.
 */
export const CATALOG_REFRESH_PROBE_TIMEOUT_MS = 15_000
/**
 * Total budget for one DISCOVERY probe of a Bazaar candidate. Kept at the
 * ingestion probe's leg budget (`probe.ts`, #1713): a candidate is an unknown,
 * seller-listed URL, the same kind of target that budget was set for.
 */
export const CATALOG_DISCOVERY_PROBE_TIMEOUT_MS = 5_000
/** Response cap for one catalog probe; a 402 challenge is a few KiB at most. */
export const CATALOG_PROBE_MAX_BYTES = 256 * 1024
/**
 * #4300: wall-clock budget for one whole refresh run. The refresh runs hourly
 * under a leader lock (`platform/leader-lock.ts`) that has no TTL, so an
 * unbounded run would hold it, and delay the next run, for as long as its
 * slowest rows take. 10 min leaves the hourly tick most of its hour, and fits
 * the 26 seeded rows even if every one of them used its full 15 s probe budget
 * (6.5 min). A probe is started only when its whole budget still fits, so a
 * run ends within this figure.
 */
export const CATALOG_REFRESH_RUN_BUDGET_MS = 10 * 60_000

export interface RefreshOptions {
  /** Wall-clock budget for the run. Defaults to `CATALOG_REFRESH_RUN_BUDGET_MS`. */
  runBudgetMs?: number
  /** The longest one probe can take. Defaults to `CATALOG_REFRESH_PROBE_TIMEOUT_MS`. */
  probeBudgetMs?: number
  /** Clock seam for tests. */
  now?: () => number
}

/**
 * Statuses a `Response` must be constructed without a body. The pinned
 * transport never returns a 1xx (Node handles informational responses before
 * the final one), so only these can arrive.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

/**
 * A `fetch`-shaped transport that sends every request through the SSRF guard
 * (#4281). Shaped like `fetch` so `probeCatalogEntry` reads one kind of
 * response whichever transport a caller injects. A guard refusal rejects, and
 * `probeCatalogEntry` turns the rejection into `{ ok: false }`.
 *
 * `options` is the guard's test seam (resolver, transport, budgets). In
 * production the defaults apply: system DNS and the pinned `node:https`
 * transport.
 */
export function createGuardedCatalogFetch(options: SafeFetchOptions = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // A `Request` carries its own method, headers and body; reading only its
    // URL would silently send something else. The probe never passes one.
    if (typeof input !== 'string' && !(input instanceof URL)) {
      throw new Error('guarded catalog probe takes a URL, not a Request')
    }
    const url = input.toString()
    const headers = new Headers(init?.headers)
    if (init?.body != null && typeof init.body !== 'string') {
      throw new Error('guarded catalog probe sends only a string body')
    }
    const result = await safeRequest(
      url,
      { method: init?.method ?? 'GET', body: init?.body ?? null, accept: headers.get('accept') ?? undefined },
      { timeoutMs: CATALOG_REFRESH_PROBE_TIMEOUT_MS, maxBytes: CATALOG_PROBE_MAX_BYTES, ...options },
    )
    if (!result.ok) throw new Error(`catalog probe refused: ${result.reason}`)
    return new Response(NULL_BODY_STATUSES.has(result.status) ? null : result.body, {
      status: result.status,
      headers: result.headers,
    })
  }) as typeof fetch
}

/** The production refresh transport: every request through the SSRF guard, refresh budget. */
export const guardedCatalogFetch: typeof fetch = createGuardedCatalogFetch({
  timeoutMs: CATALOG_REFRESH_PROBE_TIMEOUT_MS,
})

/** The production discovery-probe transport: the SSRF guard, ingestion budget. */
export const guardedDiscoveryProbeFetch: typeof fetch = createGuardedCatalogFetch({
  timeoutMs: CATALOG_DISCOVERY_PROBE_TIMEOUT_MS,
})

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
  fetchImpl: typeof fetch = guardedCatalogFetch,
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

  // #4300: the 402 is merchant-controlled. Since #4389 an option whose fields
  // are not strings is simply not an option, but anything that still throws
  // while reading the response must read as a miss like any other unusable
  // answer: escaping here would abort the refresh run, leave this row
  // unwritten and so oldest, and stop every later run at the same row.
  try {
    return await readProbeChallenge(entry, response)
  } catch (err) {
    // #4341: a throw here is a bug in our parsing or a challenge shape the
    // parsers did not anticipate, not a quiet miss — after three silent
    // hourly runs it would degrade the whole catalog with logs showing only
    // counts. Log it the way the write path logs: the row's URL and the
    // error message, and nothing from the merchant payload.
    console.warn(
      `[catalog] probe could not parse the challenge of ${entry.resource_url}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { ok: false }
  }
}

async function readProbeChallenge(
  entry: Pick<CatalogRow, 'rail'>,
  response: Response,
): Promise<ProbeResult> {
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
  // #4389: the pay path's own scheme selection over every option, not
  // accepts[0]. No payable option is a miss.
  const selected = selectCatalogPaymentOption(payload)
  if (!selected) return { ok: false }

  // #3769: a challenge that STRUCTUREDLY advertises its own method (a
  // `resource.method` on the 402) — Anchor's challenge only describes the
  // POST wrapper in its free-text resource description, which is never
  // parsed; a structured declaration is the only machine-readable one.
  const advertised = (payload as { resource?: { method?: unknown } })?.resource?.method
  const advertisedMethod = typeof advertised === 'string' && advertised.trim() ? advertised.trim().toUpperCase() : undefined

  const atomic = x402AuthorizationAmount(selected.option)
  return {
    ok: true,
    priceAtomic: atomic,
    priceDisplay: formatPriceDisplay(atomic, selected.assetSymbol, selected.assetDecimals),
    asset: selected.assetSymbol,
    network: selected.network,
    assetTransferMethods: collectAssetTransferMethods(payload, selected.chainId),
    payTo: collectPayTo(payload, selected.chainId),
    ...(advertisedMethod ? { advertisedMethod } : {}),
  }
}

/** Minimal queryable surface so tests can inject a fake pool. */
export interface QueryableLike {
  query: (text: string, values?: unknown[]) => Promise<{ rows: CatalogRow[] }>
}

/**
 * Probe non-delisted entries and persist each outcome, within a run budget.
 * Returns counts for observability. Failures on individual entries never
 * abort the run: the probe answers every failure as a miss, a row whose
 * VERIFIED write fails is recorded as a miss too (#4341 — a probe result the
 * database cannot store, e.g. a challenge carrying a NUL byte, would
 * otherwise leave the row unchanged forever), and only a row whose miss
 * write itself fails is logged and skipped (it keeps its old `updated_at`,
 * so it comes first again next run) without being counted.
 *
 * #4300: rows are taken least recently updated first, and a probe is started
 * only while its whole budget still fits in the run's. Rows the run does not
 * reach are left untouched, so they are neither counted as misses nor moved
 * toward `degraded`, and they come first next run. That rotation rests on
 * `updated_at`: both outcome writes below set it, and nothing else writes it
 * outside migrations.
 */
export async function refreshCatalog(
  db: QueryableLike = pool as unknown as QueryableLike,
  fetchImpl: typeof fetch = guardedCatalogFetch,
  options: RefreshOptions = {},
): Promise<{ verified: number; degraded: number; deferred: number }> {
  const runBudgetMs = options.runBudgetMs ?? CATALOG_REFRESH_RUN_BUDGET_MS
  const probeBudgetMs = options.probeBudgetMs ?? CATALOG_REFRESH_PROBE_TIMEOUT_MS
  const now = options.now ?? Date.now
  const started = now()
  const { rows } = await db.query(
    `SELECT * FROM merchant_catalog WHERE status != 'delisted' ORDER BY updated_at ASC, id ASC`,
  )

  let verified = 0
  let degraded = 0
  let deferred = 0
  for (const [index, entry] of rows.entries()) {
    if (now() - started + probeBudgetMs > runBudgetMs) {
      deferred = rows.length - index
      break
    }
    const result = await probeCatalogEntry(entry, fetchImpl)
    try {
      if (result.ok) {
        try {
          await persistVerified(db, entry, result)
          verified++
        } catch (verifiedErr) {
          // #4341: a probe result the database cannot store (the reviewer's
          // repro: a well-formed 402 whose string field carries a NUL byte —
          // Postgres rejects 0x00 in text) must not leave the row unchanged
          // forever. Unwritten, `consecutive_failures` never moves and the
          // status stays `active`, so the row is advertised forever and
          // budgets pinned to its old `pay_to` are never flagged stale —
          // against the #3331 doctrine that an unverifiable merchant
          // degrades. Record a miss instead, so the row degrades after the
          // usual streak.
          console.warn(
            `[catalog] refresh could not store the verified probe of ${entry.resource_url}; recording a miss instead: ${verifiedErr instanceof Error ? verifiedErr.message : String(verifiedErr)}`,
          )
          if (await persistMiss(db, entry)) degraded++
        }
      } else if (await persistMiss(db, entry)) {
        degraded++
      }
    } catch (err) {
      console.warn(
        `[catalog] refresh could not record the probe of ${entry.resource_url}; the row keeps its old updated_at: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return { verified, degraded, deferred }
}

async function persistVerified(db: QueryableLike, entry: CatalogRow, result: ProbeResult): Promise<void> {
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
}

/** Record one miss; true when it moved the row to `degraded`. */
async function persistMiss(db: QueryableLike, entry: CatalogRow): Promise<boolean> {
  // Hysteresis: count the miss, but only degrade after a sustained streak
  // so one flaky probe doesn't light up the whole catalog.
  const failures = (entry.consecutive_failures ?? 0) + 1
  const nextStatus = failures >= DEGRADE_AFTER_FAILURES ? 'degraded' : entry.status
  await db.query(
    `UPDATE merchant_catalog
     SET consecutive_failures = $2, status = $3, updated_at = now()
     WHERE id = $1`,
    [entry.id, failures, nextStatus],
  )
  return nextStatus === 'degraded'
}
