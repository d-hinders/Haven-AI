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
import { config } from '../config.js'
import { SUPPORTED_CHAIN_IDS } from './chains.js'
import {
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
  /** A candidate that did not answer a parsable 402. */
  failedProbe: number
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

  while (out.length < maxItems) {
    const url = `${config.catalogDiscoveryUrl}?type=http&limit=${PAGE_SIZE}&offset=${offset}`
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Bazaar discovery error: ${res.status}`)

    const page = (await res.json()) as BazaarPage
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
export async function ingestDiscoveredCatalog(
  db: QueryableLike,
  fetchImpl: typeof fetch = fetch,
  maxItems = DEFAULT_MAX_ITEMS,
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    scanned: 0,
    candidates: 0,
    ingested: 0,
    skippedExisting: 0,
    skippedUnsupported: 0,
    failedProbe: 0,
  }

  const resources = await fetchBazaarResources(fetchImpl, maxItems)
  result.scanned = resources.length
  if (resources.length === 0) return result

  // Dedupe against everything already curated, including delisted entries, so
  // discovery never resurrects a merchant an operator deliberately removed.
  const existingRows = await db.query(`SELECT resource_url FROM merchant_catalog`)
  const known = new Set(existingRows.rows.map((r) => r.resource_url))

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

    // Verify with the same read-only probe the refresh uses. Bazaar lists only
    // plain-HTTP x402 resources today, so probe as an x402 http merchant.
    const probe = await probeCatalogEntry(
      { resource_url: resourceUrl, protocol: 'http', tool_name: null, rail: 'x402' },
      fetchImpl,
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

    await db.query(
      `INSERT INTO merchant_catalog
         (name, description, category, resource_url, rail, protocol, tool_name,
          price_display, price_atomic, asset, network, status, verified_at)
       VALUES ($1, $2, $3, $4, 'x402', 'http', NULL, $5, $6, $7, $8, 'active', now())
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
      ],
    )
    known.add(resourceUrl)
    result.ingested += 1
  }

  return result
}
