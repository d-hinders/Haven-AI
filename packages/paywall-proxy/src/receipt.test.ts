import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { InvoiceJson } from '@haven_ai/merchant-payments'
import {
  buildSignedTaxDeclaration,
  encodeTaxDeclarationHeader,
} from '@haven_ai/sdk/edge'
import { PROXY_CHAINS } from './chains.js'
import type { Product } from './products.js'
import {
  MAX_RECEIPT_HEADER_CHARS,
  MAX_RECEIPT_JSON_BYTES,
  buildReceiptForPayment,
  encodeReceiptHeader,
  type ReceiptParams,
  type ReceiptSettings,
} from './receipt.js'

/**
 * #4913: the proxy's receipt is the shared core's `buildReceipt` document,
 * assembled from the deployment's settings, the products-file line and the
 * settled payment. These tests pin what the proxy supplies and what it does
 * NOT do: no VAT computation, no receipt-number derivation and no declaration
 * verification live here — the core owns all three.
 */

const CHAIN = PROXY_CHAINS['eip155:84532']!
const PAY_TO = '0x1111111111111111111111111111111111111111'
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const OTHER_KEY = `0x${'02'.repeat(32)}` as const
const PAYER = privateKeyToAccount(PAYER_KEY).address
const TX = `0x${'cd'.repeat(32)}`
const SETTLED_AT = '2026-11-18T12:00:00Z'
const FUTURE = Date.parse('2027-06-30T12:00:00Z')

const PRODUCT: Product = {
  id: 'chat-1k',
  name: 'Chat, 1,000 output tokens',
  method: 'POST',
  path: '/v1/chat/completions',
  route: 'POST /v1/chat/completions',
  price: 10000n,
  description: 'One chat completion on your-provider/your-model, up to 1,000 output tokens.',
}

const SETTINGS: ReceiptSettings = {
  vatRule: 'SE_25_WITH_EU_REVERSE_CHARGE',
  seller: {
    name: 'Kit Merchant AB',
    address: 'Sveavägen 10, 111 57 Stockholm',
    org_nr: '559123-4567',
    moms_nr: 'SE559123456701',
    iban: 'SE35 5000 0000 0549 1000 0003',
    bic: 'ESSESESS',
  },
  supportContact: 'support@kit-merchant.example',
}

const PARAMS: ReceiptParams = {
  settings: SETTINGS,
  product: PRODUCT,
  settledAmountAtomic: PRODUCT.price,
  chain: CHAIN,
  payTo: PAY_TO,
  payer: PAYER,
  txHash: TX,
  settledAt: SETTLED_AT,
}

/** A correctly signed declaration header, with the knobs each refusal needs. */
function declarationHeader(
  content: { jurisdiction: string; taxId: string },
  opts: { key?: string; network?: string } = {},
): string {
  return encodeTaxDeclarationHeader(
    buildSignedTaxDeclaration({
      content: {
        version: 'x402-tax-1',
        jurisdiction: content.jurisdiction,
        taxableStatus: 'TAXABLE_PERSON',
        taxId: content.taxId,
        validUntil: FUTURE,
      },
      network: opts.network ?? `eip155:${CHAIN.chainId}`,
      delegateKey: opts.key ?? PAYER_KEY,
    }),
  )
}

describe('buildReceiptForPayment (#4913)', () => {
  it('builds the shared document from the deployment, the product line and the payment', () => {
    const json = buildReceiptForPayment(PARAMS)
    expect(json).toMatchObject({
      fakturanummer: expect.stringMatching(/^FAK-\d{16}$/),
      fakturadatum: '2026-11-18',
      forfallodatum: '2026-12-18',
      saljare: {
        name: 'Kit Merchant AB',
        address: 'Sveavägen 10, 111 57 Stockholm',
        org_nr: '559123-4567',
        moms_nr: 'SE559123456701',
        iban: 'SE35 5000 0000 0549 1000 0003',
        bic: 'ESSESESS',
        crypto_address: PAY_TO,
      },
      kopare: { identifierare: PAYER, typ: 'blockkedjeadress', roll: 'agent_delegate' },
      rader: [
        {
          beskrivning: 'Chat, 1,000 output tokens — One chat completion on your-provider/your-model, up to 1,000 output tokens.',
          antal: 1,
          apris_exkl_moms: '0.008',
          moms_procent: 25,
          moms_belopp: '0.002',
          totalt_inkl_moms: '0.01',
        },
      ],
      belopp_exkl_moms: '0.008',
      moms_procent: 25,
      moms_belopp: '0.002',
      totalt_inkl_moms: '0.01',
      momsbehandling: 'SE_25',
      valuta: 'USDC',
      betalningssatt: 'Kryptovaluta (USDC på Base Sepolia testnät)',
      blockkedje_referens: `Tx: ${TX}`,
      status: 'Betald',
    })
    // No declaration: the buyer block keeps its exact shape.
    expect(json.kopare).not.toHaveProperty('deklaration')
  })

  it('an accepted Swedish declaration keeps 25% VAT included in the price', () => {
    const json = buildReceiptForPayment({
      ...PARAMS,
      taxDeclarationHeader: declarationHeader({ jurisdiction: 'SE', taxId: 'SE559412345601' }),
    })
    expect(json.momsbehandling).toBe('SE_25')
    expect(json.moms_procent).toBe(25)
    expect(json.moms_belopp).toBe('0.002')
    expect(json.kopare.deklaration).toEqual({
      land: 'SE',
      moms_nr: 'SE559412345601',
      status: 'TAXABLE_PERSON',
      giltig_till: '2027-06-30',
    })
  })

  it('an accepted declaration from another EU country gives reverse charge, both VAT numbers and a VAT of zero', () => {
    const json = buildReceiptForPayment({
      ...PARAMS,
      taxDeclarationHeader: declarationHeader({ jurisdiction: 'DE', taxId: 'DE123456789' }),
    })
    expect(json.momsbehandling).toBe('REVERSE_CHARGE')
    expect(json.moms_procent).toBe(0)
    expect(json.moms_belopp).toBe('0')
    expect(json.belopp_exkl_moms).toBe('0.01')
    expect(json.totalt_inkl_moms).toBe('0.01')
    expect(json.rader[0]).toMatchObject({ moms_procent: 0, moms_belopp: '0', apris_exkl_moms: '0.01' })
    // Both VAT numbers are on the receipt.
    expect(json.saljare.moms_nr).toBe('SE559123456701')
    expect(json.kopare.deklaration?.moms_nr).toBe('DE123456789')
  })

  it('treats a declaration that fails any check as absent, and the receipt is still built', () => {
    const cases: Array<[string, string]> = [
      ['not base64url JSON', 'not-a-declaration'],
      ['signed by another key', declarationHeader({ jurisdiction: 'DE', taxId: 'DE123456789' }, { key: OTHER_KEY })],
      ['naming another chain', declarationHeader({ jurisdiction: 'DE', taxId: 'DE123456789' }, { network: 'eip155:8453' })],
    ]
    for (const [name, header] of cases) {
      const json = buildReceiptForPayment({ ...PARAMS, taxDeclarationHeader: header })
      expect(json.momsbehandling, name).toBe('SE_25')
      expect(json.kopare, name).not.toHaveProperty('deklaration')
    }
  })

  it('numbers the receipt from the transaction hash alone, so the same transaction gives the same number', () => {
    const first = buildReceiptForPayment(PARAMS)
    // A retry on a later day: the wall clock moves, the payment's settledAt does not.
    const again = buildReceiptForPayment({ ...PARAMS, now: Date.parse('2026-12-01T09:00:00Z') })
    expect(again.fakturanummer).toBe(first.fakturanummer)
    expect(again.ocr_nummer).toBe(first.ocr_nummer)
    // The dates are the payment's, so a retry on a later day gives the same receipt.
    expect(again.fakturadatum).toBe(first.fakturadatum)
    expect(again.forfallodatum).toBe(first.forfallodatum)
    expect(buildReceiptForPayment({ ...PARAMS, txHash: `0x${'ab'.repeat(32)}` }).fakturanummer).not.toBe(
      first.fakturanummer,
    )
  })

  it('#5033 — prices the line at the amount that settled, never the products file\'s current price', () => {
    // The products file now says 30000; the payment settled at 10000.
    const repriced = buildReceiptForPayment({ ...PARAMS, product: { ...PRODUCT, price: 30000n }, settledAmountAtomic: 10000n })
    expect(repriced.totalt_inkl_moms).toBe(buildReceiptForPayment(PARAMS).totalt_inkl_moms)
    expect(repriced.totalt_inkl_moms).toBe('0.01')
    expect(repriced.rader[0]).toMatchObject({ totalt_inkl_moms: '0.01' })
  })

  it('uses the product id when the products file has no name, and no billing period for a per-call product', () => {
    const json = buildReceiptForPayment({ ...PARAMS, product: { ...PRODUCT, name: undefined } })
    expect(json.rader[0].beskrivning).toBe(
      'chat-1k — One chat completion on your-provider/your-model, up to 1,000 output tokens.',
    )
    expect(json.rader[0].beskrivning).not.toMatch(/\((1 månad|engångsköp)\)$/)
  })

  it('names no Haven address or contact: the seller block is the merchant’s', () => {
    const json = buildReceiptForPayment(PARAMS)
    const text = JSON.stringify(json)
    expect(text).not.toContain('haven.xyz')
    expect(text).not.toContain('Haven Demo AB')
    expect(json.saljare.name).toBe('Kit Merchant AB')
    expect(json.saljare.crypto_address).toBe(PAY_TO)
  })
})

describe('encodeReceiptHeader (#4913)', () => {
  /** A receipt document whose JSON is exactly `bytes` bytes (the padding is ASCII). */
  function documentOfBytes(bytes: number): InvoiceJson {
    const base = buildReceiptForPayment(PARAMS)
    const empty = { ...base, saljare: { ...base.saljare, name: '' } }
    const pad = bytes - Buffer.byteLength(JSON.stringify(empty), 'utf8')
    const json = { ...base, saljare: { ...base.saljare, name: 'x'.repeat(pad) } }
    expect(Buffer.byteLength(JSON.stringify(json), 'utf8')).toBe(bytes)
    return json
  }

  it('base64-encodes the document so the header stays ASCII-safe, under the SDK’s encoded limit', () => {
    const json = buildReceiptForPayment(PARAMS)
    const header = encodeReceiptHeader(json)
    expect(header).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(JSON.parse(Buffer.from(header, 'base64').toString('utf8'))).toEqual(json)
    expect(header.length).toBeLessThanOrEqual(MAX_RECEIPT_HEADER_CHARS)
    expect(Buffer.from(header, 'base64').length).toBeLessThanOrEqual(MAX_RECEIPT_JSON_BYTES)
  })

  it('refuses a document over the limit the SDK drops and the backend refuses', () => {
    const json = buildReceiptForPayment(PARAMS)
    const oversized = { ...json, saljare: { ...json.saljare, name: 'x'.repeat(MAX_RECEIPT_JSON_BYTES) } }
    expect(() => encodeReceiptHeader(oversized)).toThrow(/the limit is 87382/)
  })

  it('refuses a document of exactly 64 KiB decoded: its base64 is 87384 characters, over the SDK’s 87382', () => {
    const json = documentOfBytes(MAX_RECEIPT_JSON_BYTES)
    expect(Buffer.from(JSON.stringify(json), 'utf8').toString('base64').length).toBe(87384)
    expect(() => encodeReceiptHeader(json)).toThrow(/the limit is 87382/)
  })

  it('accepts the largest document the SDK keeps: 65535 decoded bytes encode to 87380 characters', () => {
    const json = documentOfBytes(MAX_RECEIPT_JSON_BYTES - 1)
    const header = encodeReceiptHeader(json)
    expect(header.length).toBe(87380)
    expect(header.length).toBeLessThanOrEqual(MAX_RECEIPT_HEADER_CHARS)
    expect(Buffer.from(header, 'base64').length).toBe(MAX_RECEIPT_JSON_BYTES - 1)
  })
})
