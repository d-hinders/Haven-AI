import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDiscoveryDocument } from '../merchant-products.js'

/**
 * #4987: the demo merchant's kit discovery document, read by the SAME parser
 * the Sales page's catalogue uses. The fixture is the demo merchant's own
 * builder output (`packages/demo-merchant-mcp/src/kit-discovery.ts`), pinned
 * byte for byte by `packages/demo-merchant-mcp/src/kit-discovery.test.ts`, so
 * a change on either side that breaks the other goes red here or there.
 */
const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/demo-merchant-x402.json', import.meta.url)), 'utf8')

describe('the demo merchant’s kit discovery document is read by Haven’s catalogue (#4987)', () => {
  it('parses as a version 1 kit document with every product understood', () => {
    const parsed = parseDiscoveryDocument(FIXTURE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.version).toBe(1)
    expect(parsed.document.network).toBe('eip155:84532')
    expect(parsed.document.payTo).toBe('0xabCDeF0123456789AbcdEf0123456789aBCDEF01')
    expect(parsed.document.asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
    expect(parsed.document.skippedProducts).toBe(0)
    expect(parsed.document.products.map((p) => [p.productId, p.name, p.priceAtomic])).toEqual([
      ['joke', 'Haven Joke', '10000'],
      ['field_notes', 'Haven Field Notes', '2500'],
    ])
  })
})
