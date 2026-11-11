/**
 * Real-Postgres proof for migration 125 — the Anchor calldata-decode row's
 * call semantics (#4755). No mocks — #1219's rule.
 *
 * Pins:
 *   - `up()` sets `http_method = 'POST'`, `body_type = 'json'`, the merchant's
 *     own `body_example` from its 402 (verbatim, `chain: "ethereum"` — the
 *     decoder selector, not the settlement network) and the corrected
 *     description on the ONE row whose `resource_url` is the calldata-decode
 *     endpoint;
 *   - the sibling Anchor token-price row, seeded with the values migration 108
 *     wrote, is unchanged field-by-field INCLUDING `updated_at` — the fixture
 *     that catches an `UPDATE` without its `WHERE`;
 *   - a second `up()` changes nothing at all (idempotent, `updated_at`
 *     included);
 *   - `down()` puts the three columns back to NULL and restores 035's
 *     description, and touches only a row that still carries every value
 *     `up()` wrote.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../125_anchor_calldata_call_semantics.js'

const RESOURCE_URL = 'https://api.anchor-x402.com/v1/decode/calldata'
const TOKEN_PRICE_URL = 'https://api.anchor-x402.com/v1/price/token'

const SEEDED_DESCRIPTION = 'Decode EVM calldata against an ABI. Pay per decode.'
const DESCRIPTION =
  'Decode raw EVM calldata into a named function call with typed parameters (4-byte selector lookup via openchain.xyz). Pay per decode.'
const BODY_EXAMPLE = {
  chain: 'ethereum',
  calldata_hex:
    '0xa9059cbb000000000000000000000000ab5801a7d398351b8be11c439e05c5b3259aec9b0000000000000000000000000000000000000000000000000de0b6b3a7640000',
}

interface CatalogRow {
  id: string
  name: string
  description: string
  category: string
  resource_url: string
  rail: string
  protocol: string
  tool_name: string | null
  price_display: string | null
  asset: string | null
  network: string | null
  status: string
  http_method: string | null
  body_type: string | null
  body_example: unknown
  updated_at: string
}

// `updated_at` is IN this SELECT deliberately: a sibling comparison that omits
// it cannot see a write that leaves the call-semantics columns alone but still
// touches the row.
const SELECT_ROW = `
  SELECT id, name, description, category, resource_url, rail, protocol, tool_name,
         price_display, asset, network, status, http_method, body_type,
         body_example, updated_at
    FROM merchant_catalog WHERE id = $1
`

async function seedMerchant(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchants (slug, name) VALUES ('m125-test-merchant', 'M125 test merchant')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  )
  return rows[0].id
}

/** Seeds the exact row migration 035 seeds: Anchor calldata decode, no call semantics. */
async function seedTargetRow(merchantId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name,
        price_display, asset, network, status, merchant_id)
     VALUES
       ('Anchor — calldata decode', $1, 'compute', $2, 'x402', 'http', NULL,
        '$0.001 USDC', 'USDC', 'eip155:8453', 'active', $3)
     RETURNING id`,
    [SEEDED_DESCRIPTION, RESOURCE_URL, merchantId],
  )
  return rows[0].id
}

/**
 * The sibling Anchor token-price row as migration 108 left it: POST / json /
 * `{"symbol":"BTC"}` and 035's description. A `WHERE`-less UPDATE would rewrite
 * this row too, which is exactly what the field-by-field comparison catches.
 */
async function seedTokenPriceRow(merchantId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name,
        price_display, asset, network, status, http_method, body_type,
        body_example, merchant_id)
     VALUES
       ('Anchor — token price', 'Per-call token price and market data in USD. Pay per lookup.',
        'data', $1, 'x402', 'http', NULL, '$0.001 USDC', 'USDC', 'eip155:8453',
        'active', 'POST', 'json', '{"symbol":"BTC"}'::jsonb, $2)
     RETURNING id`,
    [TOKEN_PRICE_URL, merchantId],
  )
  return rows[0].id
}

async function fetchRow(id: string): Promise<CatalogRow> {
  const { rows } = await db.query<CatalogRow>(SELECT_ROW, [id])
  return rows[0]
}

describeDb('migration 125: Anchor calldata-decode call semantics (#4755)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // #2616: this file hand-drives up()/down() and nothing else undoes it if a
  // revert is left unrestored — fail here rather than letting the next file on
  // this worker inherit an off-head schema. 125 is data-only, so this is
  // uniformity, not a guard-visible fix.
  afterAll(assertWorkerSchemaAtHead)

  beforeEach(async () => {
    await resetDb()
  })

  it('names itself', () => {
    expect(version).toBe('125_anchor_calldata_call_semantics')
  })

  it('sets POST + json + the merchant body + the corrected description on the calldata row only', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId)
    const tokenPriceId = await seedTokenPriceRow(merchantId)

    const tokenPriceBefore = await fetchRow(tokenPriceId)

    await up(db as never)

    const target = await fetchRow(targetId)
    expect(target.http_method).toBe('POST')
    expect(target.body_type).toBe('json')
    expect(target.body_example).toEqual(BODY_EXAMPLE)
    expect(target.description).toBe(DESCRIPTION)
    // The row's identity and money fields are untouched.
    expect(target.name).toBe('Anchor — calldata decode')
    expect(target.resource_url).toBe(RESOURCE_URL)
    expect(target.price_display).toBe('$0.001 USDC')
    expect(target.network).toBe('eip155:8453')

    // The sibling token-price row is unchanged field-by-field, `updated_at`
    // included — an UPDATE without its WHERE would rewrite it.
    expect(await fetchRow(tokenPriceId)).toEqual(tokenPriceBefore)
  })

  it('is idempotent — a second run changes nothing, not even updated_at', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId)

    await up(db as never)
    const afterFirst = await fetchRow(targetId)
    expect(afterFirst.http_method).toBe('POST')

    await up(db as never) // re-run
    const afterSecond = await fetchRow(targetId)

    expect(afterSecond).toEqual(afterFirst)
  })

  it('down() restores the NULLs and 035 description, and leaves the sibling row alone', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId)
    const tokenPriceId = await seedTokenPriceRow(merchantId)

    await up(db as never)
    const tokenPriceAfterUp = await fetchRow(tokenPriceId)

    await down(db as never)

    const target = await fetchRow(targetId)
    expect(target.http_method).toBeNull()
    expect(target.body_type).toBeNull()
    expect(target.body_example).toBeNull()
    expect(target.description).toBe(SEEDED_DESCRIPTION)

    expect(await fetchRow(tokenPriceId)).toEqual(tokenPriceAfterUp)
  })

  it('down() touches only a row that still carries every value up() wrote', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId)

    await up(db as never)
    // Someone else edits the row after up() ran — down() must not sweep it up.
    await db.query(`UPDATE merchant_catalog SET description = 'edited by hand' WHERE id = $1`, [targetId])
    const edited = await fetchRow(targetId)

    await down(db as never)

    expect(await fetchRow(targetId)).toEqual(edited)
  })
})

describe('migration 125 registration', () => {
  it('exports up and down', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
  })
})
