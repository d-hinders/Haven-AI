import type { PoolClient } from 'pg'

export const version = '057_fix_mpp_demo_catalog_url'

/**
 * The 019 seed pointed the "Haven MPP demo resource" catalog entry at
 * `/demo/mpp/resource` — a path that has NEVER existed. The demo router
 * (`routes/demo-mpp.ts`) serves `/demo/mpp/market-summary`, and always has.
 * Every agent that trusted the catalog got a 404 at the quote step; found
 * live on prod (2026-08-09) when the owner's first real test purchase died
 * exactly there.
 *
 * Guarded by the OLD url so a hand-corrected row is never clobbered, and a
 * re-run matches nothing (idempotent, like every migration here).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    UPDATE merchant_catalog
       SET resource_url = 'https://havenbackend-production-8a00.up.railway.app/demo/mpp/market-summary'
     WHERE resource_url = 'https://havenbackend-production-8a00.up.railway.app/demo/mpp/resource'
  `)
}

/** Restore the seeded (broken) url — only meaningful for symmetry. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    UPDATE merchant_catalog
       SET resource_url = 'https://havenbackend-production-8a00.up.railway.app/demo/mpp/resource'
     WHERE resource_url = 'https://havenbackend-production-8a00.up.railway.app/demo/mpp/market-summary'
  `)
}
