import type { PoolClient } from 'pg'

export const version = '125_anchor_calldata_call_semantics'

/**
 * #4755 — the Anchor calldata-decode catalog row declares no call semantics.
 *
 * Migration 035 seeded `Anchor — calldata decode`
 * (`https://api.anchor-x402.com/v1/decode/calldata`) with a GET-shaped row:
 * `http_method`, `body_type` and `body_example` are all NULL. Migration 108
 * added those columns and pinned the sibling Anchor token-price row, but left
 * this one NULL. The hosted `haven_discover_tools` therefore turns the row
 * into `suggested_arguments { url }` only, and an agent that follows it quotes
 * and pays a bodiless GET.
 *
 * The merchant's own documents say the paid call is a POST with a JSON body:
 *
 *   - its OpenAPI has only `post` on `/v1/decode/calldata`, with
 *     `CalldataDecodeRequest` requiring `chain` and `calldata_hex`;
 *   - its 402 to an unpaid POST carries
 *     `extensions.bazaar.info.input = {type: http, method: POST,
 *     bodyType: json, body: {…}}`;
 *   - the unpaid GET's 402 carries no `input` and calls itself a "GET
 *     wrapper".
 *
 * So this migration pins the call shape the merchant can actually answer, in
 * the shape of 108's token-price UPDATE:
 *
 *   - `http_method = 'POST'`;
 *   - `body_type = 'json'`;
 *   - `body_example` = the merchant's own example from its 402, verbatim.
 *     `chain: "ethereum"` is the merchant's EVM decoder selector (an enum of
 *     `ethereum|solana`), NOT the settlement network — it must not be
 *     "corrected" to `base`;
 *   - `description` — 035's "against an ABI" is wrong: `contract_address` is
 *     "reserved … currently unused", and the response's `source` is
 *     `openchain.xyz`.
 *
 * `updated_at` is left alone, as 108 does. It only affects the order in which
 * `refreshCatalog` probes rows (`merchant-catalog.ts:574`).
 *
 * Nothing overwrites the update:
 *
 *   - the refresh probe writes `http_method = COALESCE($8, http_method)`
 *     (`merchant-catalog.ts:626`), and `$8` is only set from a structured
 *     `resource.method`, which this merchant's 402 does not carry
 *     (`:526-538`);
 *   - bazaar discovery inserts with `ON CONFLICT DO NOTHING` and never
 *     updates (`catalog-discovery.ts:202-205`, `:326-331`);
 *   - there is no admin edit path.
 *
 * The `WHERE` is the row's `resource_url` alone — the same predicate 108's
 * token-price UPDATE uses, and the one that names exactly one row. The
 * `IS DISTINCT FROM` guard makes a re-run touch nothing at all, so `up()` is
 * idempotent without moving `updated_at`.
 *
 * Read-only verification query (before AND after `up`), also recorded in
 * `docs/regulatory/casp-changelog/2026-11-10-4755.md`:
 *
 *   SELECT id, http_method, body_type, body_example, description
 *     FROM merchant_catalog
 *    WHERE resource_url = 'https://api.anchor-x402.com/v1/decode/calldata';
 *
 * Expected before: one row, all three call-semantics columns NULL, description
 * "Decode EVM calldata against an ABI. Pay per decode.". Expected after: the
 * same row, POST / json / the merchant's example body, and the corrected
 * description. Every other `merchant_catalog` row is untouched.
 */
const RESOURCE_URL = 'https://api.anchor-x402.com/v1/decode/calldata'
const HTTP_METHOD = 'POST'
const BODY_TYPE = 'json'
const BODY_EXAMPLE =
  '{"chain":"ethereum","calldata_hex":"0xa9059cbb000000000000000000000000ab5801a7d398351b8be11c439e05c5b3259aec9b0000000000000000000000000000000000000000000000000de0b6b3a7640000"}'
const DESCRIPTION =
  'Decode raw EVM calldata into a named function call with typed parameters (4-byte selector lookup via openchain.xyz). Pay per decode.'
/** 035's seeded description, restored by `down()`. */
const SEEDED_DESCRIPTION = 'Decode EVM calldata against an ABI. Pay per decode.'

export async function up(client: PoolClient): Promise<void> {
  await client.query(
    `
    UPDATE merchant_catalog
       SET http_method = $2,
           body_type = $3,
           body_example = $4::jsonb,
           description = $5
     WHERE resource_url = $1
       AND (http_method IS DISTINCT FROM $2
         OR body_type IS DISTINCT FROM $3
         OR body_example IS DISTINCT FROM $4::jsonb
         OR description IS DISTINCT FROM $5)
    `,
    [RESOURCE_URL, HTTP_METHOD, BODY_TYPE, BODY_EXAMPLE, DESCRIPTION],
  )
}

/**
 * Restore the row 035 seeded: the three call-semantics columns back to NULL and
 * the 035 description. Matches only a row that still carries every value
 * `up()` wrote, so a row someone else has since edited is left alone — the
 * same "only the rows this migration changed" rule 102's `down()` follows.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(
    `
    UPDATE merchant_catalog
       SET http_method = NULL,
           body_type = NULL,
           body_example = NULL,
           description = $2
     WHERE resource_url = $1
       AND http_method = $3
       AND body_type = $4
       AND body_example = $5::jsonb
       AND description = $6
    `,
    [RESOURCE_URL, SEEDED_DESCRIPTION, HTTP_METHOD, BODY_TYPE, BODY_EXAMPLE, DESCRIPTION],
  )
}
