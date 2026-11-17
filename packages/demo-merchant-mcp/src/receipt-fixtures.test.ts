import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateInvoice, renderInvoiceText } from './invoice.js'

/**
 * #4890: the two backend accounting fixtures are the demo merchant's receipt,
 * but no code produced them. This regenerates both from the demo merchant's
 * own builder and compares them byte for byte, so moving the builder to the
 * shared payment core cannot change a receipt Haven's accounting already
 * reads. The clock is injected at noon UTC so the dates do not depend on the
 * machine's time zone.
 */
const FIXTURES = fileURLToPath(
  new URL('../../backend/src/modules/accounting/__tests__/fixtures/merchant-receipts/', import.meta.url),
)

const PARAMS = {
  invoiceNumber: 'FAK-2026-00099',
  productId: 'storage_50gb' as const,
  buyerAddress: '0x2222222222222222222222222222222222222222',
  payerRole: 'agent_delegate_account' as const,
  receivingAddress: '0x1111111111111111111111111111111111111111',
  authorizationNonce: `0x${'ab'.repeat(32)}`,
  txHash: `0x${'cd'.repeat(32)}`,
  settlement: 'settled_onchain' as const,
  chainId: 8453,
  now: new Date('2026-11-17T12:00:00Z'),
}

function serialized(json: unknown): string {
  return `${JSON.stringify(json, null, 2)}\n`
}

describe('the backend receipt fixtures are the demo merchant builder output (#4890)', () => {
  it('reproduces demo-merchant-se25.json byte for byte', () => {
    const fixture = readFileSync(`${FIXTURES}demo-merchant-se25.json`, 'utf8')
    expect(serialized(generateInvoice({ ...PARAMS, taxDeclaration: null }).json)).toBe(fixture)
  })

  it('reproduces demo-merchant-reverse-charge.json byte for byte', () => {
    const fixture = readFileSync(`${FIXTURES}demo-merchant-reverse-charge.json`, 'utf8')
    const taxDeclaration = {
      jurisdiction: 'DE',
      taxId: 'DE123456789',
      taxableStatus: 'TAXABLE_PERSON',
      validUntil: Date.parse('2027-06-30T12:00:00Z'),
    }
    expect(serialized(generateInvoice({ ...PARAMS, taxDeclaration }).json)).toBe(fixture)
  })
})

/**
 * The rendered receipt text is part of the receipt too: the Swedish text is
 * `generateInvoice(...).text`, and the English one is what the MCP tool
 * shows. Both are pinned whole, per fixture, so a moved or edited renderer
 * cannot change a single character unnoticed. The pinned files were produced
 * by the pre-move builder and the moved one alike (#4890).
 */
describe('the rendered receipt text is pinned byte for byte (#4890)', () => {
  const declaration = {
    jurisdiction: 'DE',
    taxId: 'DE123456789',
    taxableStatus: 'TAXABLE_PERSON',
    validUntil: Date.parse('2027-06-30T12:00:00Z'),
  }
  for (const [name, taxDeclaration] of [
    ['se25', null],
    ['reverse-charge', declaration],
  ] as const) {
    it(`pins the Swedish and English text of the ${name} receipt`, async () => {
      const invoice = generateInvoice({ ...PARAMS, taxDeclaration })
      await expect(invoice.text).toMatchFileSnapshot(`./__snapshots__/receipt-${name}.sv.txt`)
      await expect(renderInvoiceText(invoice.json, 'CloudNest 50 GB', 'en', 8453)).toMatchFileSnapshot(
        `./__snapshots__/receipt-${name}.en.txt`,
      )
      expect(renderInvoiceText(invoice.json, 'CloudNest 50 GB', 'sv', 8453)).toBe(invoice.text)
    })
  }
})
