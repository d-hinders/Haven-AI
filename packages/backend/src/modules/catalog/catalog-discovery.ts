/**
 * Merchant-catalog auto-discovery from the x402 Bazaar (#473).
 *
 * The Bazaar (`/v2/x402/discovery/resources`) is the ecosystem's read-only
 * index of x402-payable resources. Rather than hand-curate the catalog forever,
 * we pull candidates from it, keep only the ones on a chain we can actually pay
 * on, and **probe each one before persisting** — reusing the same read-only 402
 * probe that the hourly refresh uses (`probeCatalogEntry`). So discovery never
 * advertises an offer Haven hasn't independently verified, and a bad candidate
 * is simply skipped rather than inserted.
 *
 * Sourcing only; trust still comes from the probe. Network calls and inserts
 * are gated behind `config.catalogDiscoveryEnabled` by the caller.
 */
import { config } from '../../config.js'
import type { Executor } from '../../infra/transaction.js'
import { findOrCreateMerchantByHost, merchantHostOf } from '../../infra/repositories/merchants.js'
import { SUPPORTED_CHAIN_IDS } from '../../domain/chains.js'
import {
  CATALOG_DISCOVERY_PROBE_TIMEOUT_MS,
  guardedDiscoveryProbeFetch,
  probeCatalogEntry,
  type CatalogRow,
  type QueryableLike,
} from './merchant-catalog.js'

/** CAIP-2 ids for the chains Haven can settle on, e.g. `eip155:8453`. */
const SUPPORTED_NETWORKS = new Set(SUPPORTED_CHAIN_IDS.map((id) => `eip155:${id}`))

/** Default category for discovered resources (BAS-mapped in bas-accounts.ts). */
const DEFAULT_DISCOVERY_CATEGORY = 'api'

/**
 * Map a Bazaar resource's `tags` to a catalog category that has a BAS expense
 * account (`lib/bas-accounts.ts`), so discovered spend classifies into the right
 * account instead of always landing on the default (#473 bookkeeping tie-in).
 * Conservative: the first clearly-matching tag wins; otherwise `api`.
 */
const TAG_CATEGORY_RULES: Array<{ category: string; keywords: string[] }> = [
  { category: 'search', keywords: ['search', 'web-search', 'serp'] },
  { category: 'ai', keywords: ['ai', 'llm', 'inference', 'model', 'gpt', 'completion', 'embedding'] },
  { category: 'media', keywords: ['image', 'audio', 'video', 'media', 'music', 'tts', 'speech', 'vision'] },
  { category: 'compute', keywords: ['compute', 'code', 'sandbox', 'execution', 'runtime'] },
  { category: 'data', keywords: ['data', 'weather', 'market', 'finance', 'crypto', 'enrichment', 'lookup'] },
]

function categoryFromTags(tags: string[] | undefined): string {
  if (!tags?.length) return DEFAULT_DISCOVERY_CATEGORY
  const lower = tags.map((t) => t.toLowerCase())
  for (const { category, keywords } of TAG_CATEGORY_RULES) {
    if (lower.some((tag) => keywords.some((kw) => tag.includes(kw)))) return category
  }
  return DEFAULT_DISCOVERY_CATEGORY
}

/** Safety cap so one run never probes thousands of endpoints. */
const DEFAULT_MAX_ITEMS = 50
const PAGE_SIZE = 100
/**
 * #4300: the Bazaar index read. Its URL is operator-configured
 * (`CATALOG_DISCOVERY_URL`), so it keeps the caller's `fetch`, but one page
 * may take at most this long and be at most this large, and a run reads at
 * most this many pages. Before #4300 none of the three was bounded.
 */
export const DISCOVERY_INDEX_PAGE_TIMEOUT_MS = 15_000
export const DISCOVERY_INDEX_PAGE_MAX_BYTES = 2 * 1024 * 1024
export const DISCOVERY_INDEX_MAX_PAGES = 5
/**
 * #4300: wall-clock budget for probing one run's candidates. With the 5 s
 * candidate probe budget that is at least 24 probes a run. A candidate the run
 * does not reach is not in the catalog yet, so the next run considers it
 * again. Failed candidates are not remembered and the index is read in the
 * same order each run, so if the candidates ahead of it keep using their full
 * probe budget, a late candidate can be deferred run after run. Discovery is
 * opt-in and off by default.
 */
export const DISCOVERY_RUN_BUDGET_MS = 2 * 60_000

export interface DiscoveryOptions {
  /** Wall-clock budget for the candidate probes. Defaults to `DISCOVERY_RUN_BUDGET_MS`. */
  runBudgetMs?: number
  /** The longest one candidate probe can take. Defaults to `CATALOG_DISCOVERY_PROBE_TIMEOUT_MS`. */
  probeBudgetMs?: number
  /** Clock seam for tests. */
  now?: () => number
}

/** Read a response body as text, refusing past `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      throw new Error(`Bazaar discovery page exceeded ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

interface BazaarAccept {
  scheme?: string
  network?: string
  amount?: string
  asset?: string
  payTo?: string
}

interface BazaarResource {
  resource?: string
  type?: string
  accepts?: BazaarAccept[]
  /** Current Bazaar shape: name/description/tags live at the top level. */
  serviceName?: string
  description?: string
  tags?: string[]
  /** Older Bazaar shape — kept as a fallback. */
  metadata?: { name?: string; description?: string }
  lastUpdated?: string
}

interface BazaarPage {
  items?: BazaarResource[]
  pagination?: { limit: number; offset: number; total: number }
}

export interface DiscoveryResult {
  /** Resources returned by the Bazaar (after the maxItems cap). */
  scanned: number
  /** On a supported network and not already in the catalog. */
  candidates: number
  /** Probed OK and inserted. */
  ingested: number
  /** Already present in the catalog (any status — respects operator delisting). */
  skippedExisting: number
  /** On an unsupported network (e.g. Solana) — can't pay, never probed. */
  skippedUnsupported: number
  /** #3078: a resource whose URL host the merchant rule cannot read — never inserted. */
  skippedUnparseableHost: number
  /** A candidate that did not answer a parsable 402. */
  failedProbe: number
  /**
   * #4341: a candidate the run could not WRITE (the merchant upsert or the
   * insert threw — e.g. an index entry whose name carries a NUL byte, which
   * Postgres rejects in text). The run moves on to the later candidates
   * instead of stopping at this one; the next run considers it again.
   */
  failedWrite: number
  /** #4300: a candidate the run budget did not reach; the next run considers it again. */
  deferred: number
}

/** A title-cased name derived from the resource host when none is provided. */
function deriveName(resource: string): string {
  try {
    return new URL(resource).hostname.replace(/^www\./, '')
  } catch {
    return resource
  }
}

/** Fetch resources from the Bazaar, paginating up to `maxItems`. */
export async function fetchBazaarResources(
  fetchImpl: typeof fetch = fetch,
  maxItems = DEFAULT_MAX_ITEMS,
): Promise<BazaarResource[]> {
  const out: BazaarResource[] = []
  let offset = 0

  for (let pageNumber = 0; out.length < maxItems && pageNumber < DISCOVERY_INDEX_MAX_PAGES; pageNumber += 1) {
    const url = `${config.catalogDiscoveryUrl}?type=http&limit=${PAGE_SIZE}&offset=${offset}`
    // The signal bounds the whole page, body read included.
    const signal = AbortSignal.timeout(DISCOVERY_INDEX_PAGE_TIMEOUT_MS)
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal })
    if (!res.ok) throw new Error(`Bazaar discovery error: ${res.status}`)

    const page = JSON.parse(await readCapped(res, DISCOVERY_INDEX_PAGE_MAX_BYTES)) as BazaarPage
    const items = page.items ?? []
    if (items.length === 0) break

    out.push(...items)
    offset += items.length

    const total = page.pagination?.total
    if (typeof total === 'number' && offset >= total) break
  }

  return out.slice(0, maxItems)
}

/**
 * Discover x402 resources from the Bazaar and ingest the verified, payable,
 * not-yet-known ones into the catalog. Idempotent: existing resource URLs are
 * skipped, and the insert is `ON CONFLICT DO NOTHING` as a second guard.
 */
/**
 * The merchant writer the cron goes through (#3078). Injectable so the unit
 * test's fake db does not have to answer the repository's SQL; production
 * uses the real `findOrCreateMerchantByHost`.
 */
export interface DiscoveryMerchantWriter {
  findOrCreateMerchantByHost: (
    host: string,
    seed: { name: string; description?: string | null; category?: string },
    db: QueryableLike,
  ) => Promise<{ id: string }>
}

const defaultMerchantWriter: DiscoveryMerchantWriter = {
  findOrCreateMerchantByHost: (host, seed, db) =>
    findOrCreateMerchantByHost(host, seed, db as unknown as Executor),
}

export async function ingestDiscoveredCatalog(
  db: QueryableLike,
  fetchImpl: typeof fetch = fetch,
  maxItems = DEFAULT_MAX_ITEMS,
  merchants: DiscoveryMerchantWriter = defaultMerchantWriter,
  // #4281: candidates are seller-listed URLs, so they are probed through the
  // SSRF guard, never through `fetchImpl`. That one reads only the Bazaar
  // index, whose URL is operator-configured (`CATALOG_DISCOVERY_URL`).
  probeFetch: typeof fetch = guardedDiscoveryProbeFetch,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const runBudgetMs = options.runBudgetMs ?? DISCOVERY_RUN_BUDGET_MS
  const probeBudgetMs = options.probeBudgetMs ?? CATALOG_DISCOVERY_PROBE_TIMEOUT_MS
  const now = options.now ?? Date.now
  const result: DiscoveryResult = {
    scanned: 0,
    candidates: 0,
    ingested: 0,
    skippedExisting: 0,
    skippedUnsupported: 0,
    skippedUnparseableHost: 0,
    failedProbe: 0,
    failedWrite: 0,
    deferred: 0,
  }

  const resources = await fetchBazaarResources(fetchImpl, maxItems)
  result.scanned = resources.length
  if (resources.length === 0) return result

  // Dedupe against everything already in merchant_catalog, including delisted
  // entries, so discovery never resurrects a merchant an operator deliberately
  // removed.
  const existingRows = await db.query(`SELECT resource_url FROM merchant_catalog`)
  const known = new Set(existingRows.rows.map((r) => r.resource_url))
  const started = now()

  for (const item of resources) {
    const resourceUrl = item.resource
    if (!resourceUrl) continue

    const network = item.accepts?.[0]?.network
    if (!network || !SUPPORTED_NETWORKS.has(network)) {
      result.skippedUnsupported += 1
      continue
    }
    if (known.has(resourceUrl)) {
      result.skippedExisting += 1
      continue
    }

    result.candidates += 1
    if (now() - started + probeBudgetMs > runBudgetMs) {
      result.deferred += 1
      continue
    }

    // Verify with the same read-only probe the refresh uses. Bazaar lists only
    // plain-HTTP x402 resources today, so probe as an x402 http merchant.
    const probe = await probeCatalogEntry(
      { resource_url: resourceUrl, protocol: 'http', tool_name: null, tool_arguments: null, rail: 'x402' },
      probeFetch,
    )
    if (!probe.ok) {
      result.failedProbe += 1
      continue
    }

    const name = item.serviceName?.trim() || item.metadata?.name?.trim() || deriveName(resourceUrl)
    const description =
      item.description?.trim() ||
      item.metadata?.description?.trim() ||
      `x402 resource discovered via the Bazaar (${name}).`
    const category = categoryFromTags(item.tags)

    // #3078: every catalog writer sets the merchant — the column is NOT NULL.
    // The host is the find key, so a second resource on a host already in
    // the catalog joins its merchant rather than founding another.
    const host = merchantHostOf(resourceUrl)
    if (host === null) {
      result.skippedUnparseableHost += 1
      continue
    }
    // #4341: a candidate whose write fails (the reviewer's repro: an index
    // entry whose name carries a NUL byte — Postgres rejects 0x00 in text)
    // must not stop the run from reaching later candidates. Before, the
    // throw escaped `ingestDiscoveredCatalog` and every run after it died at
    // the same candidate. Count it and go on; the next run considers it
    // again.
    try {
      const merchant = await merchants.findOrCreateMerchantByHost(host, { name, description, category }, db)

      await db.query(
        // #4245: `source = 'bazaar'` — the row's name and description are the
        // seller's own words, and the listing must not present them as an
        // operator's. Every other writer gets the column's `'operator'` default.
        `INSERT INTO merchant_catalog
           (name, description, category, resource_url, rail, protocol, tool_name,
            price_display, price_atomic, asset, network, asset_transfer_methods, status, verified_at, merchant_id,
            pay_to, source)
         VALUES ($1, $2, $3, $4, 'x402', 'http', NULL, $5, $6, $7, $8, $9, 'active', now(), $10, $11, 'bazaar')
         ON CONFLICT DO NOTHING`,
        [
          name,
          description,
          category,
          resourceUrl,
          probe.priceDisplay ?? null,
          probe.priceAtomic ?? null,
          probe.asset ?? null,
          probe.network ?? network,
          probe.assetTransferMethods?.join(',') ?? null,
          merchant.id,
          // #3331: the same probe's payTo the hourly refresh records.
          probe.payTo ?? null,
        ],
      )
    } catch (err) {
      console.warn(
        `[catalog] discovery could not record ${resourceUrl}; skipping it for this run: ${err instanceof Error ? err.message : String(err)}`,
      )
      result.failedWrite += 1
      continue
    }
    known.add(resourceUrl)
    result.ingested += 1
  }

  return result
}
