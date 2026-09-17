/**
 * Merchants — the marketplace's sell side (#3078, epic #3077).
 *
 * Read-only, like `routes/catalog.ts`, and sharing its auth door: live
 * merchants are readable without a credential (#2530's reasoning — a
 * discovery surface must not require the onboarding it leads to), with the
 * offers narrowed to the public catalog shape for a credential-less reader.
 *
 * Prospects (`listing_status: coming_soon`, seeded by #3080) are the one
 * thing NOT public: they are listed only to an authenticated dashboard user,
 * only when `HAVEN_MARKETPLACE_PROSPECTS` is on and no mainnet chain is
 * listed (`modules/catalog/marketplace-scope.ts`), and `GET /merchants/{slug}`
 * answers 404 — not 403 — to every other caller, so the URL does not confirm
 * the row exists (epic decision 12).
 *
 * Nothing here creates payments, signatures, or any state change.
 */
import { FastifyInstance } from 'fastify'
import { marketplaceChainIds, prospectsVisibleTo, type CatalogRow } from '../modules/catalog/index.js'
import {
  getMerchantBySlug,
  listMerchants,
  listOperatorOffersForMerchant,
  type CatalogRowWithMerchant,
  type MerchantListingRow,
} from '../infra/repositories/merchants.js'
import { listVerifiedCatalogSubmissionsForMerchant } from '../infra/repositories/catalog-submissions.js'
import { eitherAuth, isPublicCatalogRead, serialize, serializeIngestion, toPublicListing } from './catalog.js'
import type { CatalogListingEntry } from './catalog.js'

/** The wire shape of a merchant: the row plus what its offers say. */
export function serializeMerchant(row: MerchantListingRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    website: row.website,
    logo_url: row.logo_url,
    category: row.category,
    country: row.country,
    listing_status: row.listing_status,
    is_test_merchant: row.is_test_merchant,
    offer_count: row.offer_count,
    networks: row.networks,
    verified_payable: row.verified_payable,
  }
}

/** A slug as the URL carries it; anything else is a 404 before the DB. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export default async function merchantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', eitherAuth)

  // GET /merchants — every live merchant with an offer on a listed chain
  // (an agent: its own chain, the same alternative-not-conjunction rule the
  // catalog applies — the grid and the page must agree for an agent too),
  // plus prospects for a caller allowed to see them.
  app.get('/', async (request) => {
    const merchants = await listMerchants({
      chainIds: request.agent ? [request.agent.chain_id] : marketplaceChainIds(),
      includeProspects: prospectsVisibleTo(request),
    })
    return { merchants: merchants.map(serializeMerchant) }
  })

  // GET /merchants/:slug — the merchant and its offers on the listed chains
  // (an agent: its own chain). A prospect is 404 to anyone who may not see it.
  app.get<{ Params: { slug: string } }>('/:slug', async (request, reply) => {
    const slug = request.params.slug
    if (!SLUG.test(slug)) return reply.code(404).send({ error: 'Merchant not found' })

    const chainIds = request.agent ? [request.agent.chain_id] : marketplaceChainIds()
    const merchant = await getMerchantBySlug(slug, chainIds)
    if (!merchant) return reply.code(404).send({ error: 'Merchant not found' })
    if (merchant.listing_status === 'coming_soon' && !prospectsVisibleTo(request)) {
      return reply.code(404).send({ error: 'Merchant not found' })
    }
    // A live merchant with nothing to show on this deployment's chains is
    // not listed, so its page is not served either — the grid and the page
    // agree (an agent's own chain counts as listed for it).
    if (merchant.listing_status === 'live' && merchant.offer_count === 0) {
      return reply.code(404).send({ error: 'Merchant not found' })
    }

    const operator = await listOperatorOffersForMerchant<CatalogRow & CatalogRowWithMerchant>(merchant.id, chainIds)
    const offers: CatalogListingEntry[] = operator.map((row) =>
      serialize(row),
    )
    // The ingestion half: verified submissions attached to this merchant,
    // never chain-filtered (routes/catalog.ts says why).
    const ingestion = await listVerifiedCatalogSubmissionsForMerchant(merchant.id)
    offers.push(...ingestion.map(serializeIngestion))

    const body = {
      merchant: serializeMerchant(merchant),
      offers: isPublicCatalogRead(request)
        ? offers.map((o) => toPublicListing(o as unknown as Record<string, unknown>))
        : offers,
    }
    return body
  })
}
