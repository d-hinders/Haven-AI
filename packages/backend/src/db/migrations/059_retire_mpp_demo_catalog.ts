import type { PoolClient } from 'pg'

export const version = '059_retire_mpp_demo_catalog'

/**
 * Retire the legacy internal `mpp_demo` merchant flow (#1328). The seeded
 * "Haven MPP demo resource" catalog row (migration 019, url fixed by 057)
 * pointed agents at `POST /demo/mpp/*` — a route this same issue removes.
 * DELIST it (never delete — the catalog's status vocabulary already has a
 * word for "no longer offered", and `GET /catalog` / `refreshCatalog`
 * (`modules/catalog/merchant-catalog.ts`) both already filter on
 * `status != 'delisted'`, so this one UPDATE satisfies both halves of the
 * acceptance criterion: discovery stops returning it AND the periodic probe
 * stops re-verifying a route that no longer exists).
 *
 * Guarded by name AND rail so a hand-edited row is never clobbered and a
 * re-run matches nothing (idempotent, like every migration here — see 057).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    UPDATE merchant_catalog
       SET status = 'delisted', updated_at = now()
     WHERE name = 'Haven MPP demo resource'
       AND rail = 'mpp'
       AND status != 'delisted'
  `)
}

/** Restore the seeded row to 'active' — only meaningful for symmetry. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    UPDATE merchant_catalog
       SET status = 'active', updated_at = now()
     WHERE name = 'Haven MPP demo resource'
       AND rail = 'mpp'
       AND status = 'delisted'
  `)
}
