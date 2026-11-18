/**
 * The merchant's catalogue, read from its kit's discovery document (#4899,
 * epic #4885).
 *
 * The owner gives Haven the public address of their kit deployment for the
 * merchant account. This module reads `/.well-known/x402` from it (the document
 * #4891 serves, designed in `docs/architecture/12-merchant-kit.md` §4), keeps
 * the product list, and answers the two questions the rest of the feature asks:
 * "what does this account sell?" and "what is this product called?".
 *
 * ## It only labels
 *
 * Nothing here changes an amount, creates a sale, or names a recipient. The
 * document's `pay_to` is COMPARED against the merchant account's own address
 * and stored as a label on the source row; it is never used as a payment
 * destination. The product list lives in `merchant_products`, never in
 * `merchant_catalog` — that table's `pay_to` fills the recipient of a
 * merchant-locked budget and feeds the public catalogue, and neither may be
 * reachable from merchant-supplied data (migration 130 says why).
 *
 * ## The fetch is the shared guard, with redirects pinned to the host
 *
 * The document is public data read over the network from an address a merchant
 * supplied, so it goes through `infra/http/ssrf-guard.ts` — the same guard the
 * catalogue probe and the receipt fetch use, never a second fetcher. Two
 * controls matter here beyond the guard's defaults:
 *
 * - `sameHostOnly` (#4899): the guard follows up to three redirects ACROSS
 *   hosts by default. A merchant could use that to point Haven's read at a
 *   document it does not serve, and the owner would see products that are not
 *   their deployment's. With `sameHostOnly` a hop to another host is refused
 *   (`redirect_off_host`) before it is resolved or connected to; a same-host
 *   redirect is still followed and re-validated from scratch.
 * - The guard's own address classification refuses a host that resolves into
 *   private or local space, and pins the socket to the address it validated.
 *
 * ## A failed read leaves the last good list in place
 *
 * An unreachable, refused or malformed document writes the read OUTCOME and
 * nothing else: the products stay as they were, and `last_read_at` tells the
 * owner when Haven last tried. A document whose `pay_to` or `network` is not
 * the account's is a MISMATCH: recorded as such, and its products are not
 * written either — a document that is not this account's deployment must not
 * label this account's sales.
 *
 * ## A removed product is kept
 *
 * A product that disappears from the document is marked not offered and stays
 * in the table, so a past sale still names it (`labelSaleProduct` answers for
 * it whatever `offered` says).
 */
import { safeGetText, type SafeFetchResult, type SsrfRefusalReason } from '../../infra/http/ssrf-guard.js'
import type { Executor } from '../../infra/transaction.js'
import {
  findCatalogueProductName,
  findCatalogueSource,
  listCatalogueProducts,
  listCatalogueSources,
  recordCatalogueRead,
  replaceCatalogueProducts,
  type MerchantCatalogueReadStatus,
  type MerchantCatalogueSourceRow,
  type MerchantProductInput,
  type MerchantProductRow,
} from '../../infra/repositories/merchant-catalogue.js'

/** Total budget for one read of a merchant's discovery document. */
export const MERCHANT_CATALOGUE_TIMEOUT_MS = 5_000
/**
 * Response cap. The document is a product list — the kit's own example is a few
 * KiB — and the guard's 64 KiB default is generous for it; 256 KiB matches the
 * catalogue probe's cap and bounds a hostile deployment's answer.
 */
export const MERCHANT_CATALOGUE_MAX_BYTES = 256 * 1024
/**
 * How often the scheduled refresh reads every configured deployment. The
 * approved mockup (#4894) pins 15 minutes for an unreachable kit; the same tick
 * is the schedule for a reachable one, so there is one cadence rather than two
 * and a recovered kit is picked up on the same tick that retries a broken one.
 */
export const MERCHANT_CATALOGUE_REFRESH_INTERVAL_MS = 15 * 60 * 1000
/** The kit document version this reader knows (`12-merchant-kit.md` §4). */
export const MERCHANT_CATALOGUE_DOCUMENT_VERSION = 1
/**
 * The path the kit serves its discovery document at, and the ONLY path it
 * serves it at (`12-merchant-kit.md` §4; `packages/paywall-proxy/src/discovery.ts`
 * exports the same constant, and the proxy's handler routes this path and
 * nothing else — every other path is a 404). The read must target it: the
 * deployment root is not the document.
 */
export const MERCHANT_CATALOGUE_DISCOVERY_PATH = '/.well-known/x402'
/**
 * Safety cap on one document's product list. A products file is hand-written;
 * 500 products is far past any pilot deployment and bounds the write.
 */
export const MERCHANT_CATALOGUE_MAX_PRODUCTS = 500

/** The longest product id / name / description this reader keeps. */
const MAX_PRODUCT_ID_LENGTH = 128
const MAX_PRODUCT_TEXT_LENGTH = 300

/** One product, as the document spells it and this reader keeps it. */
export type ParsedDiscoveryProduct = MerchantProductInput

/** The fields of the document this slice reads. */
export interface ParsedDiscoveryDocument {
  version: number
  /** CAIP-2 identifier, e.g. `eip155:84532`. */
  network: string
  /** The receiving address the document names. */
  payTo: string
  /** The USDC contract the document names, when it names one. */
  asset: string | null
  name: string | null
  operatorName: string | null
  updated: string | null
  products: ParsedDiscoveryProduct[]
  /** Products the document listed that this reader could not understand. */
  skippedProducts: number
}

export type ParseResult =
  | { ok: true; document: ParsedDiscoveryDocument }
  | { ok: false; detail: string }

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const CAIP2_NETWORK_PATTERN = /^eip155:\d+$/
/** Atomic USDC units as a decimal string: digits only, never a float. */
const ATOMIC_PRICE_PATTERN = /^[0-9]{1,78}$/

function asTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.slice(0, maxLength)
}

/**
 * Parse one product. Returns null when the product cannot be understood — the
 * design's rule (§4, "How an older kit is treated"): a reader that cannot
 * understand a product simply does not offer it, rather than refusing the whole
 * catalogue.
 */
function parseProduct(raw: unknown): Omit<ParsedDiscoveryProduct, 'network'> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const product = raw as Record<string, unknown>

  const productId = asTrimmedString(product.id, MAX_PRODUCT_ID_LENGTH)
  if (productId === null) return null

  // The price is the one field a product cannot be understood without: it is
  // the merchant's own atomic amount, and a float or a dollar string is not it.
  const price = product.price
  if (typeof price !== 'string' || !ATOMIC_PRICE_PATTERN.test(price)) return null

  const cap = product.output_token_cap
  const outputTokenCap =
    typeof cap === 'number' && Number.isInteger(cap) && cap >= 0 && cap <= Number.MAX_SAFE_INTEGER ? cap : null

  return {
    productId,
    name: asTrimmedString(product.name, MAX_PRODUCT_TEXT_LENGTH),
    description: asTrimmedString(product.description, MAX_PRODUCT_TEXT_LENGTH),
    route: asTrimmedString(product.route, MAX_PRODUCT_TEXT_LENGTH),
    model: asTrimmedString(product.model, MAX_PRODUCT_TEXT_LENGTH),
    priceAtomic: price,
    outputTokenCap,
  }
}

/**
 * Parse the discovery document.
 *
 * `version` is required: a document without one is not a kit document (the demo
 * merchant's document has none and lacks the fields version 1 requires). A
 * HIGHER version is read for the fields this reader knows and its unknown
 * fields are ignored, per §4 — it is a catalogue, not an authority.
 *
 * `network` and `pay_to` are required because they are what the mismatch check
 * compares. `asset` is validated when present and not required: this slice
 * never charges the document's price, so a missing asset costs nothing, while a
 * malformed one is still a malformed document.
 */
export function parseDiscoveryDocument(body: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, detail: 'the document is not valid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, detail: 'the document is not a JSON object' }
  }
  const doc = parsed as Record<string, unknown>

  const version = doc.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, detail: 'the document carries no kit version, so it is not a kit document' }
  }

  const network = doc.network
  if (typeof network !== 'string' || !CAIP2_NETWORK_PATTERN.test(network)) {
    return { ok: false, detail: 'the document names no CAIP-2 network' }
  }

  const payTo = doc.pay_to
  if (typeof payTo !== 'string' || !ADDRESS_PATTERN.test(payTo)) {
    return { ok: false, detail: 'the document names no receiving address' }
  }

  const asset = doc.asset
  if (asset !== undefined && (typeof asset !== 'string' || !ADDRESS_PATTERN.test(asset))) {
    return { ok: false, detail: 'the document names a malformed asset address' }
  }

  const rawProducts = doc.products
  if (!Array.isArray(rawProducts)) {
    return { ok: false, detail: 'the document lists no products array' }
  }

  const products: ParsedDiscoveryProduct[] = []
  let skippedProducts = 0
  for (const raw of rawProducts.slice(0, MERCHANT_CATALOGUE_MAX_PRODUCTS)) {
    const product = parseProduct(raw)
    if (product === null) {
      skippedProducts += 1
      continue
    }
    products.push({ ...product, network })
  }
  // Products past the cap are not read at all; count them as skipped so the
  // number the owner sees is honest about what the document carried.
  skippedProducts += Math.max(0, rawProducts.length - MERCHANT_CATALOGUE_MAX_PRODUCTS)

  const operator = doc.operator
  const operatorName =
    operator !== null && typeof operator === 'object' && !Array.isArray(operator)
      ? asTrimmedString((operator as Record<string, unknown>).name, MAX_PRODUCT_TEXT_LENGTH)
      : null

  return {
    ok: true,
    document: {
      version,
      network,
      payTo,
      asset: typeof asset === 'string' ? asset : null,
      name: asTrimmedString(doc.name, MAX_PRODUCT_TEXT_LENGTH),
      operatorName,
      updated: asTrimmedString(doc.updated, 64),
      products,
      skippedProducts,
    },
  }
}

/**
 * Refusal reasons that mean "the address itself is not one Haven reads", as
 * opposed to "the read did not complete". The owner sees the difference: a
 * refused address is a mistake to fix, an unreachable one is a kit to start.
 */
const POLICY_REFUSAL_REASONS: ReadonlySet<SsrfRefusalReason> = new Set<SsrfRefusalReason>([
  'invalid_url',
  'scheme_not_https',
  'embedded_credentials',
  'non_default_port',
  'host_not_public',
  'address_not_public',
  'redirect_off_host',
])

/** The outcome of one read, as the route and the tick report it. */
export interface CatalogueReadOutcome {
  status: MerchantCatalogueReadStatus
  detail: string | null
  mismatch: boolean
  mismatchReason: string | null
  /** Products written. Zero unless the read was `ok`. */
  productsWritten: number
}

/** The production read: the shared guard, same-host redirects only. */
async function guardedDocumentFetch(url: string): Promise<SafeFetchResult> {
  return safeGetText(url, {
    timeoutMs: MERCHANT_CATALOGUE_TIMEOUT_MS,
    maxBytes: MERCHANT_CATALOGUE_MAX_BYTES,
    sameHostOnly: true,
  })
}

/**
 * The discovery document's URL for a saved deployment address.
 *
 * The document is served at `/.well-known/x402` and nowhere else, so the read
 * targets `<origin>/.well-known/x402` — never the address as pasted. An
 * absolute path replaces whatever path the base carried, so a row saved before
 * the route normalized the address (or written by hand) still reads the
 * document rather than the path it happens to carry.
 *
 * Null when the saved address is not a parseable absolute URL: the caller
 * records that as a refusal instead of throwing.
 */
export function discoveryDocumentUrl(deploymentUrl: string): string | null {
  try {
    return new URL(MERCHANT_CATALOGUE_DISCOVERY_PATH, deploymentUrl).toString()
  } catch {
    return null
  }
}

/**
 * Read one merchant account's discovery document and keep what it says.
 *
 * The order is deliberate: the products are written BEFORE the read is recorded
 * as `ok`, so a failed write cannot leave a source row claiming a list it does
 * not have. Every failure path records the outcome and touches no product.
 */
export async function readMerchantCatalogue(params: {
  merchantAccountId: string
  deploymentUrl: string
  /** The merchant account's own address — what the document's `pay_to` must be. */
  accountAddress: string
  /** The merchant account's chain — what the document's `network` must be. */
  chainId: number
  db?: Executor
  /** Test seam: the guarded read. Defaults to `safeGetText` with `sameHostOnly`. */
  fetchText?: (url: string) => Promise<SafeFetchResult>
  /** Clock seam for tests. */
  now?: () => Date
}): Promise<CatalogueReadOutcome> {
  const db = params.db
  const fetchText = params.fetchText ?? guardedDocumentFetch
  const readAt = (params.now ?? (() => new Date()))()

  // The document is served at `/.well-known/x402` and nowhere else, so the read
  // targets that path on the saved deployment — never the address as pasted.
  const documentUrl = discoveryDocumentUrl(params.deploymentUrl)
  if (documentUrl === null) {
    const detail = 'invalid_url: the saved deployment address is not a parseable URL'
    await recordCatalogueRead(
      {
        merchantAccountId: params.merchantAccountId,
        deploymentUrl: params.deploymentUrl,
        readAt,
        status: 'refused',
        detail,
        mismatch: false,
        mismatchReason: null,
      },
      db,
    )
    return { status: 'refused', detail, mismatch: false, mismatchReason: null, productsWritten: 0 }
  }

  const fetched = await fetchText(documentUrl)
  if (!fetched.ok) {
    const status: MerchantCatalogueReadStatus = POLICY_REFUSAL_REASONS.has(fetched.reason)
      ? 'refused'
      : 'unreachable'
    const detail = `${fetched.reason}: ${fetched.detail}`
    await recordCatalogueRead(
      {
        merchantAccountId: params.merchantAccountId,
        deploymentUrl: params.deploymentUrl,
        readAt,
        status,
        detail,
        mismatch: false,
        mismatchReason: null,
      },
      db,
    )
    return { status, detail, mismatch: false, mismatchReason: null, productsWritten: 0 }
  }

  const parsed = parseDiscoveryDocument(fetched.body)
  if (!parsed.ok) {
    await recordCatalogueRead(
      {
        merchantAccountId: params.merchantAccountId,
        deploymentUrl: params.deploymentUrl,
        readAt,
        status: 'malformed',
        detail: parsed.detail,
        mismatch: false,
        mismatchReason: null,
      },
      db,
    )
    return { status: 'malformed', detail: parsed.detail, mismatch: false, mismatchReason: null, productsWritten: 0 }
  }

  const document = parsed.document
  const expectedNetwork = `eip155:${params.chainId}`
  const reasons: string[] = []
  if (document.network !== expectedNetwork) {
    reasons.push(`the document's network is ${document.network}, not ${expectedNetwork}`)
  }
  if (document.payTo.toLowerCase() !== params.accountAddress.toLowerCase()) {
    reasons.push("the document's receiving address is not the merchant account's")
  }
  if (reasons.length > 0) {
    const mismatchReason = reasons.join('; ')
    await recordCatalogueRead(
      {
        merchantAccountId: params.merchantAccountId,
        deploymentUrl: params.deploymentUrl,
        readAt,
        status: 'mismatch',
        detail: mismatchReason,
        mismatch: true,
        mismatchReason,
      },
      db,
    )
    return { status: 'mismatch', detail: mismatchReason, mismatch: true, mismatchReason, productsWritten: 0 }
  }

  const written = await replaceCatalogueProducts(
    { merchantAccountId: params.merchantAccountId, deploymentUrl: params.deploymentUrl, products: document.products, readAt },
    db,
  )
  if (!written) {
    // The owner saved another deployment while this read was in flight: this
    // document is the old address's, so nothing of it is written — not the
    // products and not the read record (#4945 review S1).
    return {
      status: 'refused',
      detail: 'superseded: the deployment address changed while it was being read; nothing was written',
      mismatch: false,
      mismatchReason: null,
      productsWritten: 0,
    }
  }
  const detail =
    parsed.document.skippedProducts > 0
      ? `${parsed.document.skippedProducts} product(s) in the document could not be read and were not offered`
      : null
  await recordCatalogueRead(
    {
      merchantAccountId: params.merchantAccountId,
      deploymentUrl: params.deploymentUrl,
      readAt,
      status: 'ok',
      detail,
      mismatch: false,
      mismatchReason: null,
      document: {
        payTo: document.payTo,
        network: document.network,
        name: document.name,
        operatorName: document.operatorName,
        updated: document.updated,
      },
    },
    db,
  )
  return {
    status: 'ok',
    detail,
    mismatch: false,
    mismatchReason: null,
    productsWritten: document.products.length,
  }
}

/** What one scheduled pass did, for the job log. */
export interface CatalogueRefreshReport {
  /** Sources the pass read. */
  read: number
  /** Reads that ended `ok`. */
  ok: number
  /** Reads that ended `mismatch`. */
  mismatch: number
  /** Reads that ended `unreachable`, `malformed` or `refused`. */
  failed: number
}

/**
 * Read every configured deployment once — the scheduled refresh (#4899).
 *
 * One source's failure never stops the pass: each read is caught and counted,
 * and the next tick retries it. The tick is leader-locked
 * (`LEADER_LOCK_KEYS.merchantCatalogueRefresh`), so two replicas do not read
 * the same deployment at once.
 */
export async function refreshAllMerchantCatalogues(
  db?: Executor,
  options: { fetchText?: (url: string) => Promise<SafeFetchResult>; now?: () => Date } = {},
): Promise<CatalogueRefreshReport> {
  const report: CatalogueRefreshReport = { read: 0, ok: 0, mismatch: 0, failed: 0 }
  const sources = await listCatalogueSources(db)
  for (const source of sources) {
    report.read += 1
    try {
      const outcome = await readMerchantCatalogue({
        merchantAccountId: source.merchant_account_id,
        deploymentUrl: source.deployment_url,
        accountAddress: source.account_address,
        chainId: Number(source.chain_id),
        db,
        ...(options.fetchText !== undefined ? { fetchText: options.fetchText } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      })
      if (outcome.status === 'ok') report.ok += 1
      else if (outcome.status === 'mismatch') report.mismatch += 1
      else report.failed += 1
    } catch {
      // A write failure on one source is that source's problem; the pass goes
      // on and the next tick retries it.
      report.failed += 1
    }
  }
  return report
}

/**
 * The name a sale's product should be shown under (#4899, for #4897's reads).
 *
 * The catalogue's name when the product id is known there — whether or not the
 * product is still offered, so a past sale keeps its name — and otherwise the
 * name the sale record carried. Null when neither knows one.
 */
export async function labelSaleProduct(params: {
  merchantAccountId: string
  productId: string | null
  recordName: string | null
  db?: Executor
}): Promise<string | null> {
  if (params.productId !== null) {
    const catalogueName = await findCatalogueProductName(params.merchantAccountId, params.productId, params.db)
    if (catalogueName !== null) return catalogueName
  }
  return params.recordName
}

/** The account's catalogue as the owner's screens read it (#4900). */
export interface MerchantCatalogueView {
  source: MerchantCatalogueSourceRow | null
  products: MerchantProductRow[]
}

/** The source row and the product list, in one read. */
export async function readMerchantCatalogueView(
  merchantAccountId: string,
  db?: Executor,
): Promise<MerchantCatalogueView> {
  const [source, products] = await Promise.all([
    findCatalogueSource(merchantAccountId, db),
    listCatalogueProducts(merchantAccountId, db),
  ])
  return { source, products }
}
