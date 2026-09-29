import type { PoolClient } from 'pg'

export const version = '102_delist_skip_settle_catalog_row'

/**
 * Delist the Sepolia CloudNest 50 GB catalog row (#3421), following the
 * precedent of migration 059.
 *
 * The spec review on #3421 found this row — seeded by migration 058 as
 * `CloudNest 50 GB — demo merchant (Base Sepolia)`, `buy_cloud_storage`
 * `{"tier":"50gb"}` on `eip155:84532` at the dev demo-merchant's `/mcp` — is
 * the SAME product the dev merchant's `MERCHANT_SKIP_SETTLE_PRODUCT` QA hook
 * (`storage_50gb`, `x402.ts` `isSkipSettleProduct`, chain-gated to Base
 * Sepolia) hands out without ever settling on-chain. The merchant's own
 * discovery document (`/.well-known/haven-demo-merchant`) already marks that
 * product `qa_fixture: {kind: "skip_settle", settles_on_chain: false}`, but
 * nothing stopped the SAME product from also being catalog-discoverable —
 * an agent that reached it through `GET /catalog` rather than the merchant
 * directly would fund a purchase whose settlement never lands.
 *
 * Owner decision (#3421, 2026-09-28): DELIST, not relabel. Migration 064's
 * relabel precedent (Minifetch) applies when the owner wants a fixture to
 * stay catalog-reachable; this fixture must not be — it stays reachable only
 * by calling the merchant directly. `GET /catalog` and `refreshCatalog`
 * (`modules/catalog/merchant-catalog.ts`) both already filter on
 * `status != 'delisted'` (see `routes/catalog.ts`), so this one UPDATE
 * satisfies discovery on its own; the companion qa-dev tripwire in
 * `x402-catalog-guided-purchase` is what keeps it from silently drifting
 * back.
 *
 * Matched on the row's FULL unique key (`idx_merchant_catalog_resource_tool_
 * args` from migration 058: `resource_url`, `tool_name`, `tool_arguments`)
 * PLUS `network`, so this can only ever touch the one Sepolia row — never the
 * Base-mainnet CloudNest 50 GB row, which settles normally and is not this
 * hook's fixture, and never a hand-edited row with a different `tool_
 * arguments`. `status != 'delisted'` keeps a re-run idempotent (the read-only
 * verification query is below and in the CASP shard).
 *
 * `down()` always restores `status = 'active'` with a fresh `updated_at` —
 * the same unconditional restore 059's `down()` uses, not a lookup of
 * whatever status the row held before `up()` ran. It leaves `verified_at`
 * alone (the next probe refreshes it) and does NOT restore a prior
 * `degraded` status: a row delisted from `degraded` comes back `active`, and
 * the next probe re-degrades it if the merchant is still failing, so
 * `down()`'s job is symmetry with `up()`, not a general-purpose undo for
 * every possible prior state.
 *
 * The `network` predicate is redundant TODAY against 058's own unique index
 * (`resource_url`, `tool_name`, `md5(tool_arguments::text)` — no `network`
 * column): two rows sharing this migration's `resource_url`/`tool_name`/
 * `tool_arguments` cannot even coexist, so `resource_url` alone already
 * disambiguates the Sepolia row from the Base-mainnet row (they seed under
 * DIFFERENT hosts). It stays in the `WHERE` anyway — matching the spec's
 * "full unique key plus network" instruction exactly, rather than a narrower
 * predicate that happens to work today — because it costs nothing and does
 * not depend on that index shape never changing.
 *
 * Read-only verification query (before AND after `up`), also recorded in
 * `docs/regulatory/casp-changelog/2026-09-28-3421.md`:
 *
 *   SELECT id, status, network FROM merchant_catalog
 *    WHERE resource_url = 'https://demo-merchant-dev-84e4.up.railway.app/mcp'
 *      AND tool_name = 'buy_cloud_storage'
 *      AND tool_arguments = '{"tier":"50gb"}'::jsonb
 *      AND network = 'eip155:84532';
 *
 * Expected before: one row, status = 'active' (or 'degraded' if the probe has
 * recently failed). Expected after: the same row, status = 'delisted'. Every
 * other `merchant_catalog` row is untouched.
 */
const RESOURCE_URL = 'https://demo-merchant-dev-84e4.up.railway.app/mcp'
const TOOL_NAME = 'buy_cloud_storage'
const TOOL_ARGUMENTS = '{"tier":"50gb"}'
const NETWORK = 'eip155:84532'

export async function up(client: PoolClient): Promise<void> {
  await client.query(
    `
    UPDATE merchant_catalog
       SET status = 'delisted', updated_at = now()
     WHERE resource_url = $1
       AND tool_name = $2
       AND tool_arguments = $3::jsonb
       AND network = $4
       AND status != 'delisted'
    `,
    [RESOURCE_URL, TOOL_NAME, TOOL_ARGUMENTS, NETWORK],
  )
}

/** Restore the row to 'active' — only meaningful for symmetry, same as 059's down(). */
export async function down(client: PoolClient): Promise<void> {
  await client.query(
    `
    UPDATE merchant_catalog
       SET status = 'active', updated_at = now()
     WHERE resource_url = $1
       AND tool_name = $2
       AND tool_arguments = $3::jsonb
       AND network = $4
       AND status = 'delisted'
    `,
    [RESOURCE_URL, TOOL_NAME, TOOL_ARGUMENTS, NETWORK],
  )
}
