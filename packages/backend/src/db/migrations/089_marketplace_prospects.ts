import type { PoolClient } from 'pg'

/**
 * 089 — Berget AI and Redpine, seeded `coming_soon` (#3080, slice 3 of epic
 * #3077). 087 belongs to #3054 (refusals epic #3056, specced first); 088 is
 * slice 1's merchant layer (epic decision 13).
 *
 * Two prospects we are talking to, shown on dev only as "Coming soon" —
 * never an agreement, never on prod (owner decision 2 on the epic). Opper is
 * deliberately NOT seeded here: it has no CRM record yet (decision 8); adding
 * it later is one seed row plus that record (`docs/product/marketplace.md`
 * § Prospects says so).
 *
 * Copy is taken from each company's public site only — nothing from the CRM
 * records — and is guardrail-tested against `PROSPECT_COPY_BANNED_WORDS`
 * (`modules/catalog/prospect-copy.ts`) so neither description can drift into
 * language ("partner", "customer", "integration", "planned", "pilot") that
 * outruns the CRM ceiling (decision 9). No logo — a monogram only (decision 7).
 *
 * These rows carry ZERO offers by construction: `merchants.listing_status`
 * only ever leaves `coming_soon` through the operator SQL in the runbook,
 * never through this migration or through a catalog writer
 * (`findOrCreateMerchantByHost` refuses to attach an offer to either row —
 * `infra/repositories/merchants.ts`).
 */
export const version = '089_marketplace_prospects'

export interface ProspectSeed {
  slug: string
  name: string
  description: string
  website: string
  category: string
  country: string
}

export const PROSPECT_SEEDS: readonly ProspectSeed[] = [
  {
    slug: 'berget-ai',
    name: 'Berget AI',
    description:
      'Sovereign Swedish inference — open models on Swedish data centres, OpenAI-compatible API',
    website: 'https://berget.ai',
    category: 'ai',
    country: 'SE',
  },
  {
    slug: 'redpine',
    name: 'Redpine',
    description: 'Grounding API for licensed, non-public data — API, MCP and CLI',
    website: 'https://redpine.ai',
    category: 'data',
    country: 'SE',
  },
]

export async function up(client: PoolClient): Promise<void> {
  for (const seed of PROSPECT_SEEDS) {
    await client.query(
      `INSERT INTO merchants (slug, name, description, website, category, country, listing_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'coming_soon')
       ON CONFLICT (slug) DO NOTHING`,
      [seed.slug, seed.name, seed.description, seed.website, seed.category, seed.country],
    )
  }
}

/**
 * Structural down (#1139), narrowed to what this migration itself created:
 * exactly the two seeded slugs, and only while they are still untouched —
 * still `coming_soon` and still carrying zero offers. An operator who has
 * already flipped one `live` (the promotion path in the runbook) has turned
 * it into a real merchant with real offers; silently deleting that on a
 * rollback would drop live inventory, so this refuses LOUDLY instead,
 * naming which slug and why, rather than deleting a subset and calling it done.
 */
export async function down(client: PoolClient): Promise<void> {
  const slugs = PROSPECT_SEEDS.map((s) => s.slug)
  // Offers on BOTH halves: operator rows and verified submissions (a
  // submission attached to the merchant is an offer on the wire, and its FK
  // would abort the delete with a raw constraint error otherwise — review).
  const { rows } = await client.query<{ slug: string; listing_status: string; offer_count: string }>(
    `SELECT m.slug, m.listing_status,
            ((SELECT count(*) FROM merchant_catalog mc WHERE mc.merchant_id = m.id)
             + (SELECT count(*) FROM catalog_submissions cs WHERE cs.merchant_id = m.id))::text AS offer_count
     FROM merchants m
     WHERE m.slug = ANY($1::text[])`,
    [slugs],
  )
  for (const row of rows) {
    if (row.listing_status !== 'coming_soon' || Number(row.offer_count) > 0) {
      throw new Error(
        `089_marketplace_prospects: refusing to remove merchant "${row.slug}" — ` +
          `listing_status is "${row.listing_status}" and it has ${row.offer_count} offer(s). ` +
          'This migration only ever seeded it as coming_soon with zero offers; it has since ' +
          'been promoted through the operator path (docs/product/marketplace.md § Prospects) ' +
          'and this down() will not delete a real merchant. Remove it by hand if that is truly intended.',
      )
    }
  }
  await client.query(
    `DELETE FROM merchants WHERE slug = ANY($1::text[]) AND listing_status = 'coming_soon'`,
    [slugs],
  )
}
