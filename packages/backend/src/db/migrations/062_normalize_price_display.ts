import type { PoolClient } from 'pg'

export const version = '062_normalize_price_display'

/**
 * Normalize `merchant_catalog.price_display` to `<human amount> <asset code>`
 * (#1592, epic #1585). Seeded rows (migrations 019/035/058) carried
 * `'$0.0015 USDC'` — the `$` prefix plus the `USDC` suffix double-states the
 * currency, and the 2026-08-18 external tester flagged it as confusing. A `$`
 * prefix is only correct when the asset is actual USD, which no row is today.
 *
 * Scoped to rows matching `^\$.+ USDC$` (the exact seeded shape, per the
 * issue's acceptance criteria) so an already-normalized row — or a future
 * genuinely-USD display — is never touched, and a re-run matches nothing
 * (idempotent, like every migration here — see 057/059).
 *
 * The writers stop emitting the prefix in the same PR
 * (`modules/catalog/merchant-catalog.ts`), so nothing recreates the old form.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    UPDATE merchant_catalog
       SET price_display = substring(price_display from 2), updated_at = now()
     WHERE price_display ~ '^\\$.+ USDC$'
  `)
}

/**
 * Restore the seeded `$` prefix — only meaningful for symmetry. NOTE: after
 * `up()` has run in production, rows written by the fixed writers are also
 * unprefixed and indistinguishable from migrated ones, so a late `down()`
 * would prefix those too. Acceptable: rolling back a shipped display
 * normalization after new data accumulated is not an expected path.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    UPDATE merchant_catalog
       SET price_display = '$' || price_display, updated_at = now()
     WHERE price_display ~ '^[^$].* USDC$'
  `)
}
