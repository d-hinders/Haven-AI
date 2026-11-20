import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MERCHANT_CATALOGUE_MAX_BYTES, parseDiscoveryDocument } from '../merchant-products.js'

/**
 * #4990: the merchant kit's discovery document, read by the SAME parser the
 * Sales page's catalogue uses. The fixture is the proxy's own builder output
 * (`packages/paywall-proxy/src/discovery.ts`) over the largest example products
 * file the kit ships, pinned byte for byte by
 * `packages/paywall-proxy/src/discovery-fixtures.test.ts`, so a change on
 * either side that breaks the other goes red here or there.
 *
 * The document gained fields in #4990 (`price_usdc`, `network_name`, `testnet`,
 * `asset_symbol`, `asset_decimals`, `terms`, `payment`, per-product
 * `output_schema`). The reader reads only named fields and needs `price` as an
 * atomic string, so the additions must not change what it reads.
 */
const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/kit-merchant-x402.json', import.meta.url)), 'utf8')

describe('the merchant kit’s discovery document is read by Haven’s catalogue (#4990)', () => {
  it('parses as a version 1 kit document with every product understood, at the same prices', () => {
    const parsed = parseDiscoveryDocument(FIXTURE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.version).toBe(1)
    expect(parsed.document.network).toBe('eip155:84532')
    expect(parsed.document.payTo).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
    expect(parsed.document.asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
    expect(parsed.document.skippedProducts).toBe(0)
    expect(parsed.document.products.map((p) => [p.productId, p.name, p.priceAtomic])).toEqual([
      ['gpt-5-mini-1k', 'GPT-5 mini, 1,000 output tokens', '10000'],
      ['ministral-3b-2k', 'Ministral 3B, 2,000 output tokens', '5000'],
    ])
  })

  it('stays under the reader’s response cap, with the largest example products file (#4990)', () => {
    expect(Buffer.byteLength(FIXTURE, 'utf8')).toBeLessThan(MERCHANT_CATALOGUE_MAX_BYTES)
  })
})
