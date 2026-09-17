/**
 * Merchants — the sell side the catalog rows belong to (#3078, epic #3077).
 *
 * Read paths for the marketplace (`GET /merchants`, `GET /merchants/{slug}`)
 * and the ONE write path every catalog writer shares:
 * `findOrCreateMerchantByHost`. The Bazaar discovery cron and the ingestion
 * lifecycle both go through it, so `merchant_catalog.merchant_id NOT NULL`
 * (migration 088) holds by construction — a writer that forgot would throw
 * at the database, not list an orphan.
 *
 * The hostname is the find key: a merchant is whoever answers on that host.
 * A curated merchant seeded on two hosts (Ampersend, the demo store) is found
 * on either, and a third-party submission on a curated merchant's host joins
 * that merchant rather than founding a look-alike — the host proves the
 * seller and `verified_payable` proves the offer.
 */
import pool from '../../db.js'
import type { Executor } from '../transaction.js'
import { HOST_OF_URL_SQL, hostOfUrl } from '../../db/url-host.js'

export type MerchantListingStatus = 'live' | 'coming_soon'

/**
 * The merchant columns every catalog read joins onto a `merchant_catalog`
 * row (#3078). One SELECT fragment for the catalog list, the detail and the
 * merchant page, so the three cannot disagree about which columns make a
 * `merchant`. `LEFT JOIN`, not inner: the column is NOT NULL after
 * migration 088, but a test fixture or a mocked query may hand the
 * serializer a row without the joined fields, and the entry then carries
 * `merchant: null` rather than a crash.
 */
export const CATALOG_ROW_WITH_MERCHANT_SELECT = `
  SELECT mc.*,
         m.slug AS merchant_slug,
         m.name AS merchant_name,
         m.listing_status AS merchant_listing_status,
         m.is_test_merchant AS merchant_is_test_merchant
  FROM merchant_catalog mc
  LEFT JOIN merchants m ON m.id = mc.merchant_id`

/** A catalog row's joined merchant columns (absent on a bare row). */
export interface CatalogRowWithMerchant {
  merchant_id?: string | null
  merchant_slug?: string | null
  merchant_name?: string | null
  merchant_listing_status?: MerchantListingStatus | null
  merchant_is_test_merchant?: boolean | null
}

/**
 * A merchant's non-delisted operator offers on the given chains (`null` =
 * every chain), with the merchant columns joined — the operator half of
 * `GET /merchants/{slug}`.
 */
export async function listOperatorOffersForMerchant<Row extends CatalogRowWithMerchant>(
  merchantId: string,
  chainIds: number[] | null,
  db: Executor = pool,
): Promise<Row[]> {
  const conditions = [`mc.merchant_id = $1`, `mc.status != 'delisted'`]
  const values: unknown[] = [merchantId]
  if (chainIds !== null) {
    values.push(chainIds.map((id) => `eip155:${id}`))
    conditions.push(`mc.network = ANY($${values.length}::text[])`)
  }
  const result = await db.query<Row>(
    `${CATALOG_ROW_WITH_MERCHANT_SELECT}
     WHERE ${conditions.join(' AND ')}
     ORDER BY mc.status = 'active' DESC, mc.name ASC, mc.id ASC`,
    values,
  )
  return result.rows
}

export interface MerchantRow {
  id: string
  slug: string
  name: string
  description: string
  website: string | null
  logo_url: string | null
  category: string
  country: string | null
  listing_status: MerchantListingStatus
  is_test_merchant: boolean
  created_at: string
  updated_at: string
}

/** A merchant as the listing shows it: the row plus what its offers say. */
export interface MerchantListingRow extends MerchantRow {
  /** Non-delisted offers on the listed chains, both halves. */
  offer_count: number
  /** Distinct `network` values of those offers (ingestion rows carry none). */
  networks: string[]
  /** Any offer verified payable (operator: active + verified_at; ingestion: always). */
  verified_payable: boolean
}

/**
 * The lowercased host of a URL by the ONE rule the SQL side uses
 * (`db/url-host.ts`), or null when it will not parse. Not `new URL()`: its
 * `hostname` punycodes an IDN and drops userinfo the way the regex does not,
 * and two definitions of the find key found two merchants for one row.
 */
export function merchantHostOf(resourceUrl: string): string | null {
  return hostOfUrl(resourceUrl)
}

/** A URL-safe slug from a display name; never empty. */
export function slugifyMerchantName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'merchant'
}

/**
 * The chain filter every listing applies on the operator half: `null` means
 * "every chain" (no marketplace list and no deploy list configured — a test
 * environment must never return zero rows by accident); ingestion rows carry
 * `network: null` and are never chain-filtered (routes/catalog.ts documents
 * why: an x402 endpoint is self-describing at pay time).
 */
export type ChainScope = number[] | null

function networksOf(chainIds: ChainScope): string[] | null {
  return chainIds === null ? null : chainIds.map((id) => `eip155:${id}`)
}

const MERCHANT_COLUMNS = `
  m.id, m.slug, m.name, m.description, m.website, m.logo_url, m.category, m.country,
  m.listing_status, m.is_test_merchant, m.created_at, m.updated_at`

/**
 * Offer aggregates per merchant: operator rows on the listed chains that are
 * not delisted, plus verified_payable submissions (any chain). `$1` is the
 * network list or NULL for "every chain".
 */
const OFFER_AGGREGATES_SQL = `
  WITH operator AS (
    SELECT merchant_id,
           count(*)::int AS n,
           array_remove(array_agg(DISTINCT network), NULL) AS networks,
           bool_or(status = 'active' AND verified_at IS NOT NULL) AS any_verified
    FROM merchant_catalog
    WHERE status != 'delisted'
      AND ($1::text[] IS NULL OR network = ANY($1::text[]))
    GROUP BY merchant_id
  ),
  ingestion AS (
    SELECT merchant_id, count(*)::int AS n
    FROM catalog_submissions
    WHERE status = 'verified_payable' AND merchant_id IS NOT NULL
    GROUP BY merchant_id
  )`

const LIST_MERCHANTS_SQL = `
  ${OFFER_AGGREGATES_SQL}
  SELECT ${MERCHANT_COLUMNS},
         (COALESCE(o.n, 0) + COALESCE(i.n, 0)) AS offer_count,
         COALESCE(o.networks, ARRAY[]::text[]) AS networks,
         (COALESCE(o.any_verified, false) OR COALESCE(i.n, 0) > 0) AS verified_payable
  FROM merchants m
  LEFT JOIN operator o ON o.merchant_id = m.id
  LEFT JOIN ingestion i ON i.merchant_id = m.id
  WHERE (m.listing_status = 'live' AND (COALESCE(o.n, 0) + COALESCE(i.n, 0)) > 0)
     OR ($2::boolean AND m.listing_status = 'coming_soon')
  ORDER BY m.is_test_merchant ASC, m.listing_status ASC, m.name ASC, m.id ASC`

const GET_MERCHANT_BY_SLUG_SQL = `
  ${OFFER_AGGREGATES_SQL}
  SELECT ${MERCHANT_COLUMNS},
         (COALESCE(o.n, 0) + COALESCE(i.n, 0)) AS offer_count,
         COALESCE(o.networks, ARRAY[]::text[]) AS networks,
         (COALESCE(o.any_verified, false) OR COALESCE(i.n, 0) > 0) AS verified_payable
  FROM merchants m
  LEFT JOIN operator o ON o.merchant_id = m.id
  LEFT JOIN ingestion i ON i.merchant_id = m.id
  WHERE m.slug = $2
  LIMIT 1`

export interface ListMerchantsOptions {
  chainIds: ChainScope
  /** Include `coming_soon` rows (they have no offers by construction). */
  includeProspects: boolean
}

/**
 * Live merchants with at least one offer on a listed chain (or a verified
 * submission), plus prospects when asked. A live merchant whose only offers
 * sit on an unlisted chain is not listed — its offers are invisible on this
 * deployment, so a card would lead nowhere.
 */
export async function listMerchants(
  options: ListMerchantsOptions,
  db: Executor = pool,
): Promise<MerchantListingRow[]> {
  const result = await db.query<MerchantListingRow>(LIST_MERCHANTS_SQL, [
    networksOf(options.chainIds),
    options.includeProspects,
  ])
  return result.rows
}

/** One merchant by slug with its aggregates, or null. Visibility is the route's call. */
export async function getMerchantBySlug(
  slug: string,
  chainIds: ChainScope,
  db: Executor = pool,
): Promise<MerchantListingRow | null> {
  const result = await db.query<MerchantListingRow>(GET_MERCHANT_BY_SLUG_SQL, [networksOf(chainIds), slug])
  return result.rows[0] ?? null
}

/**
 * `m.listing_status = 'live'` is the zero-offers rule at the SQL level
 * (#3080): a `coming_soon` prospect has no offers by construction, so it can
 * never legitimately match through this join, but the filter is defense in
 * depth — a database where that invariant was ever violated by hand must
 * still not hand a writer a prospect to attach an offer to. Combined with
 * `assertMerchantAcceptsOffers` below (the application-level half, called on
 * every path this function returns through) so the rule holds even if one of
 * the two is ever edited without the other.
 */
const FIND_MERCHANT_BY_HOST_SQL = `
  SELECT ${MERCHANT_COLUMNS}
  FROM merchants m
  WHERE m.listing_status = 'live'
    AND m.id IN (
      SELECT merchant_id FROM merchant_catalog WHERE ${HOST_OF_URL_SQL} = $1
      UNION
      SELECT merchant_id FROM catalog_submissions WHERE merchant_id IS NOT NULL AND lower(hostname) = $1
    )
  ORDER BY m.created_at ASC, m.id ASC
  LIMIT 1`

/** The same columns, unqualified, for a statement with no alias. */
const MERCHANT_COLUMNS_BARE = `
  id, slug, name, description, website, logo_url, category, country,
  listing_status, is_test_merchant, created_at, updated_at`

const INSERT_MERCHANT_SQL = `
  INSERT INTO merchants (slug, name, description, website, category)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING ${MERCHANT_COLUMNS_BARE}`

export interface NewMerchantSeed {
  name: string
  description?: string | null
  website?: string | null
  category?: string
}

/** How many suffixed slugs to try before giving up — a defect, not a race. */
const MAX_SLUG_ATTEMPTS = 25

/**
 * Thrown by `assertMerchantAcceptsOffers` — a named error so a caller can
 * branch on it rather than string-matching a generic `Error` (#3080).
 */
export class ProspectMerchantWriteError extends Error {
  constructor(merchantId: string) {
    super(
      `merchant ${merchantId} is coming_soon and cannot receive an offer — ` +
        'a prospect becomes live only through the operator SQL in ' +
        'docs/product/marketplace.md § Prospects, never implicitly through a catalog write.',
    )
    this.name = 'ProspectMerchantWriteError'
  }
}

/**
 * The application-level half of the zero-offers rule (#3080): a cross-table
 * CHECK cannot express "this merchant has no rows in another table" without a
 * trigger, so this is the one place a writer proves it before attaching an
 * offer. Throws `ProspectMerchantWriteError` for a `coming_soon` merchant;
 * a merchant id that does not exist is a caller bug elsewhere and is left to
 * surface as a foreign-key violation, not swallowed here.
 */
export async function assertMerchantAcceptsOffers(merchantId: string, db: Executor = pool): Promise<void> {
  const { rows } = await db.query<{ listing_status: MerchantListingStatus }>(
    `SELECT listing_status FROM merchants WHERE id = $1`,
    [merchantId],
  )
  if (rows[0]?.listing_status === 'coming_soon') {
    throw new ProspectMerchantWriteError(merchantId)
  }
}

/**
 * The one write path. Finds the merchant that already owns `host` (through
 * an offer or a verified submission), else creates one from `seed` with a
 * slug from its name — suffixed `-2`, `-3`, … when the slug is taken by a
 * different merchant (a submission on `berget.ai` must not become the
 * prospect `berget-ai` seeded by #3080; it becomes `berget-ai-2`).
 *
 * `assertMerchantAcceptsOffers` guards every return so the zero-offers rule
 * holds even if `FIND_MERCHANT_BY_HOST_SQL`'s own `listing_status = 'live'`
 * filter is ever edited without this — defense in depth, not redundant dead
 * code: a newly created merchant is `live` by the table's own DEFAULT, so
 * this never fires on the creation path today, but it fires immediately if
 * that default is ever changed.
 */
export async function findOrCreateMerchantByHost(
  host: string,
  seed: NewMerchantSeed,
  db: Executor = pool,
): Promise<MerchantRow> {
  const key = host.trim().toLowerCase()
  if (!key) throw new Error('findOrCreateMerchantByHost: host is empty')
  const existing = await db.query<MerchantRow>(FIND_MERCHANT_BY_HOST_SQL, [key])
  if (existing.rows[0]) {
    await assertMerchantAcceptsOffers(existing.rows[0].id, db)
    return existing.rows[0]
  }

  const base = slugifyMerchantName(seed.name)
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`
    try {
      const inserted = await db.query<MerchantRow>(INSERT_MERCHANT_SQL, [
        slug,
        seed.name,
        seed.description ?? '',
        seed.website ?? null,
        seed.category ?? 'api',
      ])
      await assertMerchantAcceptsOffers(inserted.rows[0].id, db)
      return inserted.rows[0]
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err
      // Slug taken by another merchant: suffix. The re-find only helps when a
      // concurrent writer has ALSO written its catalog row by now (the host
      // is discoverable through rows alone); a writer that inserted the
      // merchant but not yet the row is invisible here, so two truly
      // simultaneous founders on one host would found two merchants. Both
      // writers today are leader-locked cron ticks (the Bazaar discovery
      // cron, the ingestion lifecycle), so the window is between two ticks
      // that never overlap — a host registry would close it for good
      // (review S3, left as a recorded residual).
      const again = await db.query<MerchantRow>(FIND_MERCHANT_BY_HOST_SQL, [key])
      if (again.rows[0]) {
        await assertMerchantAcceptsOffers(again.rows[0].id, db)
        return again.rows[0]
      }
    }
  }
  throw new Error(`findOrCreateMerchantByHost: no free slug for ${JSON.stringify(seed.name)} after ${MAX_SLUG_ATTEMPTS} attempts`)
}
