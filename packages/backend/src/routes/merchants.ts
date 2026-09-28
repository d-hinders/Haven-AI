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
 * only when `HAVEN_MARKETPLACE_PROSPECTS` is on and `HAVEN_MARKETPLACE_CHAIN_IDS`
 * itself names a testnet (`modules/catalog/marketplace-scope.ts`; decision 12
 * as amended by decision 14), and `GET /merchants/{slug}` answers 404 — not
 * 403 — to every other caller, so the URL does not confirm the row exists.
 *
 * `funding` on the detail (#3331) is where the merchant is paid on each
 * listed chain — the verified payTo a merchant-locked budget pins to — and
 * `GET /merchants/{slug}/budgets` is the owner's own merchant-locked budgets
 * with what is left of each this period. Both are reads.
 *
 * Nothing here creates payments, signatures, or any state change.
 */
import { FastifyInstance } from 'fastify'
import { marketplaceChainIds, prospectsVisibleTo, type CatalogRow } from '../modules/catalog/index.js'
import {
  getMerchantBySlug,
  listMerchantFundingTargets,
  listMerchants,
  listOperatorOffersForMerchant,
  type CatalogRowWithMerchant,
  type MerchantFundingTarget,
  type MerchantListingRow,
} from '../infra/repositories/merchants.js'
import {
  listActiveMerchantBudgetsForUser,
  listDelegationJsonByIds,
  type MerchantBudgetRow,
} from '../infra/repositories/delegation-budgets.js'
import { readRemainingBudget } from '../infra/chain/delegation-budget-reader.js'
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

/**
 * A merchant-locked budget's pin against the merchant's CURRENT verified
 * payTo on its chain (#3331): `current` when they agree, `stale` when the
 * merchant now names a different address (a rotation — payments to the new
 * address fall to the agent's open budget, the pinned one pays only the old
 * address), `unverified` when the merchant names no single payTo there now,
 * `not_erc7710` when the payTo still matches but not every offer there
 * advertises ERC-7710 any more — a pinned budget pays only through ERC-7710,
 * so it cannot pay this merchant until it does.
 */
export type MerchantPinStatus = 'current' | 'stale' | 'unverified' | 'not_erc7710'

export function merchantPinStatus(
  recipientAddress: string,
  target: MerchantFundingTarget | undefined,
): MerchantPinStatus {
  if (!target || target.pay_to === null) return 'unverified'
  if (target.pay_to !== recipientAddress.toLowerCase()) return 'stale'
  return target.erc7710 ? 'current' : 'not_erc7710'
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

    // #3331: where this merchant is paid on each listed chain. Public like
    // the rest of the page — a payTo is what the merchant's own 402 already
    // hands every caller.
    const funding = await listMerchantFundingTargets(merchant.id, chainIds)

    const body = {
      merchant: serializeMerchant(merchant),
      funding,
      offers: isPublicCatalogRead(request)
        ? offers.map((o) => toPublicListing(o as unknown as Record<string, unknown>))
        : offers,
    }
    return body
  })
  // GET /merchants/:slug/budgets — the dashboard user's own merchant-locked
  // budgets for this merchant (#3331), each with what is left this period
  // (the ERC20PeriodTransferEnforcer's own storage, the #1145 read) and its
  // pin against the merchant's current payTo. A dashboard read: an agent key
  // gets 403 — an agent's authority report is GET /allowances.
  app.get<{ Params: { slug: string } }>('/:slug/budgets', async (request, reply) => {
    if (request.agent) return reply.code(403).send({ error: 'Dashboard session required' })
    const { sub } = request.user as { sub: string }
    const slug = request.params.slug
    if (!SLUG.test(slug)) return reply.code(404).send({ error: 'Merchant not found' })
    const merchant = await getMerchantBySlug(slug, marketplaceChainIds())
    if (!merchant || merchant.listing_status !== 'live') {
      return reply.code(404).send({ error: 'Merchant not found' })
    }

    const rows = await listActiveMerchantBudgetsForUser(sub, merchant.id)
    // Every chain, not the listed ones: a budget the owner signed stays
    // theirs to see even if this deployment stops listing its chain.
    const targets = await listMerchantFundingTargets(merchant.id, null)
    const targetByChain = new Map(targets.map((t) => [t.chain_id, t]))
    const delegationJson = await listDelegationJsonByIds(rows.map((r) => r.id))
    const budgets = await Promise.all(rows.map(async (row: MerchantBudgetRow) => {
      const json = delegationJson.get(row.id)
      const { remainingAtomic, fromChain } = json
        ? await readRemainingBudget(row.chain_id, json, row.budget_atomic)
        : { remainingAtomic: row.budget_atomic, fromChain: false }
      return {
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        chain_id: row.chain_id,
        token_address: row.token_address,
        recipient_address: row.recipient_address,
        delegation_hash: row.delegation_hash,
        budget_atomic: row.budget_atomic,
        period_seconds: row.period_seconds,
        expires_at: String(row.expires_at),
        remaining_atomic: remainingAtomic,
        // #1319's provenance: false = the enforcer read failed and this is
        // the full configured budget, never a fabricated zero.
        remaining_is_from_chain: fromChain,
        pin_status: merchantPinStatus(row.recipient_address, targetByChain.get(row.chain_id)),
      }
    }))
    return { budgets }
  })
}
