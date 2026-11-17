import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateInvoice, renderInvoiceText } from './invoice.js'
import type { SekRate } from './sek-rate.js'

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

/**
 * #4856, characterization: the receipt for the Stripe-recorded product (the
 * joke) as it is when no Stripe context is passed. Pinned before the Stripe
 * reference and SEK blocks were added, so a receipt built without them stays
 * byte for byte what it was — the blocks appear only when the caller says
 * Stripe will record the payment.
 */
describe('the joke receipt without a Stripe context is unchanged (#4856)', () => {
  const JOKE = {
    ...PARAMS,
    productId: 'joke' as const,
    payerRole: 'agent_delegate' as const,
    receivingAddress: '0x3333333333333333333333333333333333333333',
    chainId: 84532,
    taxDeclaration: null,
  }

  it('pins the joke receipt JSON and its Swedish and English text', async () => {
    const invoice = generateInvoice(JOKE)
    await expect(serialized(invoice.json)).toMatchFileSnapshot('./__snapshots__/receipt-joke.json')
    await expect(invoice.text).toMatchFileSnapshot('./__snapshots__/receipt-joke.sv.txt')
    await expect(renderInvoiceText(invoice.json, 'Haven Joke', 'en', 84532)).toMatchFileSnapshot(
      './__snapshots__/receipt-joke.en.txt',
    )
  })
})

/**
 * #4856: the joke receipt WITH a Stripe context is the characterization
 * above plus exactly the two new blocks — `stripe_referens` and `belopp_sek`
 * appended to the JSON, and their two sections inserted before the closing
 * frame of the text. Nothing else in the receipt moves.
 */
describe('the Stripe product receipt changes only by the new blocks (#4856)', () => {
  const JOKE = {
    ...PARAMS,
    productId: 'joke' as const,
    payerRole: 'agent_delegate' as const,
    receivingAddress: '0x3333333333333333333333333333333333333333',
    chainId: 84532,
    taxDeclaration: null,
  }
  const RATE: SekRate = { rate: 10.0742, source: 'coingecko_spot', fetchedAt: new Date('2026-11-17T11:55:00Z') }
  const SNAP = fileURLToPath(new URL('./__snapshots__/', import.meta.url))

  for (const [name, sekRate] of [
    ['with-rate', RATE],
    ['no-rate', undefined],
  ] as const) {
    it(`${name}: the JSON is the pinned joke receipt plus the two blocks`, () => {
      const base = JSON.parse(readFileSync(`${SNAP}receipt-joke.json`, 'utf8')) as Record<string, unknown>
      const json = generateInvoice({ ...JOKE, stripe: { sekRate } }).json as unknown as Record<string, unknown>
      const { stripe_referens, belopp_sek, ...rest } = json
      expect(rest).toEqual(base)
      expect(Object.keys(json)).toEqual([...Object.keys(base), 'stripe_referens', 'belopp_sek'])
      expect(stripe_referens).toEqual({
        status: 'Väntar',
        sok_med: { fakturanummer: 'FAK-2026-00099', transaktions_hash: PARAMS.txHash },
      })
      expect(belopp_sek).toEqual(
        sekRate
          ? { tillganglig: true, belopp: '0.10', kurs: '10.0742', kalla: 'coingecko_spot', tidpunkt: '2026-11-17T11:55:00.000Z' }
          : { tillganglig: false, status: 'Ej tillgängligt vid köptillfället' },
      )
    })

    it(`${name}: the text is the pinned joke text with the sections inserted before the closing frame`, async () => {
      const invoice = generateInvoice({ ...JOKE, stripe: { sekRate } })
      const sv = invoice.text
      const en = renderInvoiceText(invoice.json, 'Haven Joke', 'en', 84532)
      await expect(sv).toMatchFileSnapshot(`./__snapshots__/receipt-joke-stripe-${name}.sv.txt`)
      await expect(en).toMatchFileSnapshot(`./__snapshots__/receipt-joke-stripe-${name}.en.txt`)
      for (const [text, file] of [
        [sv, 'receipt-joke.sv.txt'],
        [en, 'receipt-joke.en.txt'],
      ] as const) {
        const base = readFileSync(`${SNAP}${file}`, 'utf8')
        // Removing the inserted sections gives back the pinned text exactly.
        const start = text.search(/^(STRIPE-REFERENS|STRIPE REFERENCE)$/m)
        const end = text.indexOf('═'.repeat(60), start)
        expect(start).toBeGreaterThan(0)
        expect(text.slice(0, start) + text.slice(end)).toBe(base)
      }
      // The Swedish render from the JSON is the receipt's own text.
      expect(renderInvoiceText(invoice.json, 'Haven Joke', 'sv', 84532)).toBe(sv)
    })
  }

  it('a payment not settled on chain gets no Stripe block, even with a Stripe context', () => {
    const json = generateInvoice({ ...JOKE, settlement: 'settlement_unknown', stripe: { sekRate: RATE } }).json
    expect(json).not.toHaveProperty('stripe_referens')
    expect(json).not.toHaveProperty('belopp_sek')
  })
})
