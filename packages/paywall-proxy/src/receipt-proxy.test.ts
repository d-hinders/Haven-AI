/**
 * #4913 end to end: a paid call through the proxy returns the merchant kit's
 * receipt as the `x-receipt-json` response header
 * (docs/architecture/12-merchant-kit.md §11). A real proxy over a real SQLite
 * file, a mocked facilitator, chain reader and upstream, and a buyer that
 * signs real EIP-3009 authorizations and real tax declarations.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { receiptNumberForTransaction } from '@haven_ai/merchant-payments'
import { MAX_RECEIPT_HEADER_CHARS } from './receipt.js'
import {
  CHAT_BODY,
  CHAT_PATH,
  chatRequest,
  newBuyer,
  startHarness,
  type Buyer,
  type Harness,
} from './test-harness.js'

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const TX = `0x${'1'.repeat(64)}`
const PUBLIC = 'https://proxy.test'
const RESOURCE = `${PUBLIC}${CHAT_PATH}`

/** The deployment's receipt settings (§11). */
const RECEIPT_ENV = {
  PUBLIC_BASE_URL: PUBLIC,
  VAT_RULE: 'SE_25_WITH_EU_REVERSE_CHARGE',
  SELLER_NAME: 'Kit Merchant AB',
  SELLER_ADDRESS: 'Sveavägen 10, 111 57 Stockholm',
  SELLER_ORG_NR: '559123-4567',
  SELLER_VAT_NR: 'SE559123456701',
  SELLER_IBAN: 'SE35 5000 0000 0549 1000 0003',
  SELLER_BIC: 'ESSESESS',
  SELLER_SUPPORT_CONTACT: 'support@kit-merchant.example',
}

function receiptOf(res: Response): Record<string, any> | null {
  const header = res.headers.get('x-receipt-json')
  if (header === null) return null
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Record<string, any>
}

async function paidChat(buyer: Buyer, extra: Record<string, string> = {}) {
  const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
  const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header, ...extra }))
  return { res, paid }
}

describe('the receipt on a paid call (#4913)', () => {
  it('with the Swedish rule, a paid call returns x-receipt-json with the shared shape and the merchant’s seller block', async () => {
    h = await startHarness({ env: RECEIPT_ENV })
    const buyer = newBuyer()
    const { res } = await paidChat(buyer)
    expect(res.status).toBe(200)

    const receipt = receiptOf(res)!
    expect(receipt).toMatchObject({
      fakturanummer: receiptNumberForTransaction(TX as `0x${string}`),
      saljare: {
        name: 'Kit Merchant AB',
        address: 'Sveavägen 10, 111 57 Stockholm',
        org_nr: '559123-4567',
        moms_nr: 'SE559123456701',
        iban: 'SE35 5000 0000 0549 1000 0003',
        bic: 'ESSESESS',
        crypto_address: h.proxy.config.payTo,
      },
      kopare: { identifierare: buyer.address, typ: 'blockkedjeadress', roll: 'agent_delegate' },
      rader: [
        {
          beskrivning: 'Chat, 1,000 output tokens — One chat completion on openai/gpt-6-sol, up to 1,000 output tokens.',
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
    // No key of the canonical shape is renamed, and the buyer block keeps its
    // exact shape when the request carried no declaration.
    expect(Object.keys(receipt).sort()).toEqual(
      [
        'belopp_exkl_moms',
        'betalningssatt',
        'blockkedje_referens',
        'fakturadatum',
        'fakturanummer',
        'forfallodatum',
        'kopare',
        'moms_belopp',
        'moms_procent',
        'momsbehandling',
        'ocr_nummer',
        'rader',
        'saljare',
        'status',
        'totalt_inkl_moms',
        'valuta',
      ].sort(),
    )
    expect(receipt.kopare).not.toHaveProperty('deklaration')
    // The encoded header stays under the limit the SDK drops and the backend refuses.
    expect(res.headers.get('x-receipt-json')!.length).toBeLessThanOrEqual(MAX_RECEIPT_HEADER_CHARS)
    expect(h.logs.find((l) => l.event === 'started')).toMatchObject({ receipt: 'on' })
  })

  it('with no VAT rule configured, no x-receipt-json header is sent', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const { res } = await paidChat(buyer)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-receipt-json')).toBeNull()
    expect(h.logs.find((l) => l.event === 'started')).toMatchObject({ receipt: 'off (no VAT_RULE)' })
  })

  it('an accepted declaration from another EU country gives reverse charge, with both VAT numbers and a VAT of zero', async () => {
    h = await startHarness({ env: RECEIPT_ENV })
    const buyer = newBuyer()
    const declaration = buyer.signTaxDeclaration({ jurisdiction: 'DE', taxId: 'DE123456789' })
    const { res } = await paidChat(buyer, { 'x-tax-declaration': declaration })
    expect(res.status).toBe(200)

    const receipt = receiptOf(res)!
    expect(receipt.momsbehandling).toBe('REVERSE_CHARGE')
    expect(receipt.moms_procent).toBe(0)
    expect(receipt.moms_belopp).toBe('0')
    expect(receipt.belopp_exkl_moms).toBe('0.01')
    expect(receipt.totalt_inkl_moms).toBe('0.01')
    expect(receipt.saljare.moms_nr).toBe('SE559123456701')
    expect(receipt.kopare.deklaration).toMatchObject({ land: 'DE', moms_nr: 'DE123456789' })
  })

  it('an accepted Swedish declaration keeps 25% VAT included in the price', async () => {
    h = await startHarness({ env: RECEIPT_ENV })
    const buyer = newBuyer()
    const declaration = buyer.signTaxDeclaration({ jurisdiction: 'SE', taxId: 'SE559412345601' })
    const { res } = await paidChat(buyer, { 'x-tax-declaration': declaration })
    const receipt = receiptOf(res)!
    expect(receipt.momsbehandling).toBe('SE_25')
    expect(receipt.moms_procent).toBe(25)
    expect(receipt.kopare.deklaration).toMatchObject({ land: 'SE', moms_nr: 'SE559412345601' })
  })

  it('a declaration that fails any check is treated as absent and the call still succeeds', async () => {
    h = await startHarness({ env: RECEIPT_ENV })
    const buyer = newBuyer()
    const { res } = await paidChat(buyer, { 'x-tax-declaration': 'not-a-declaration' })
    expect(res.status).toBe(200)
    expect((await res.json()).choices).toBeDefined()
    const receipt = receiptOf(res)!
    expect(receipt.momsbehandling).toBe('SE_25')
    expect(receipt.kopare).not.toHaveProperty('deklaration')
  })

  it('removes the upstream’s own x-receipt-json and x-receipt-url, so an upstream cannot pass off its own receipt', async () => {
    h = await startHarness({
      env: RECEIPT_ENV,
      upstream: { headers: { 'content-type': 'application/json', 'x-receipt-json': 'dXBzdHJlYW0=', 'x-receipt-url': 'https://upstream.example/receipt' } },
    })
    const buyer = newBuyer()
    const { res } = await paidChat(buyer)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-receipt-url')).toBeNull()
    expect(receiptOf(res)!.saljare.name).toBe('Kit Merchant AB')
  })

  it('is sent with the response headers of a delivered call, including a 3xx/4xx the proxy wraps into a 200', async () => {
    h = await startHarness({ env: RECEIPT_ENV, upstream: { status: 400, body: '{"error":"bad prompt"}' } })
    const buyer = newBuyer()
    const { res } = await paidChat(buyer)
    expect(res.status).toBe(200)
    expect((await res.json()).error).toBe('upstream_answered')
    expect(receiptOf(res)!.fakturanummer).toBe(receiptNumberForTransaction(TX as `0x${string}`))
  })

  it('a receipt that cannot be built never fails a settled call: the header is left out and the failure is logged', async () => {
    // A seller name long enough to push the document past the 64 KiB limit.
    h = await startHarness({ env: { ...RECEIPT_ENV, SELLER_NAME: 'x'.repeat(70_000) } })
    const buyer = newBuyer()
    const { res } = await paidChat(buyer)
    expect(res.status).toBe(200)
    expect((await res.json()).choices).toBeDefined()
    expect(res.headers.get('x-receipt-json')).toBeNull()
    expect(h.logs.some((l) => l.event === 'receipt_failed')).toBe(true)
  })

  it('keeps the receipt number for the same settled transaction after a restart, because the store keeps the hash', async () => {
    h = await startHarness({ env: RECEIPT_ENV, upstream: { status: 503 } })
    const buyer = newBuyer()
    const { res: failed, paid } = await paidChat(buyer)
    expect((await failed.json()).error).toBe('upstream_failed_after_settlement')
    expect(failed.headers.get('x-receipt-json')).toBeNull()

    h.upstream.behaviour.status = 200
    await h.restart()
    const challenge = (await (await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))).json())
      .sign_in_with_x
    const proof = await buyer.signIn(challenge, RESOURCE)
    const served = await fetch(
      `${h.base}${CHAT_PATH}`,
      chatRequest({ 'payment-signature': paid.header, 'sign-in-with-x': proof }),
    )
    expect(served.status).toBe(200)
    expect((await served.json()).choices).toBeDefined()
    expect(receiptOf(served)!.fakturanummer).toBe(receiptNumberForTransaction(TX as `0x${string}`))
    expect(receiptOf(served)!.blockkedje_referens).toBe(`Tx: ${TX}`)
  })

  it('#5033 — after a price change and a restart, the receipt for an earlier settled call states the price that settled', async () => {
    h = await startHarness({ env: RECEIPT_ENV, upstream: { status: 503 } })
    const buyer = newBuyer()
    const { res: failed, paid } = await paidChat(buyer)
    expect((await failed.json()).error).toBe('upstream_failed_after_settlement')
    const settledValue = (paid.payload.payload as { authorization: { value: string } }).authorization.value

    // The merchant raises the price in the products file, then restarts.
    const productsFile = join(h.dir, 'products.json')
    const doc = JSON.parse(readFileSync(productsFile, 'utf8')) as { products: Array<{ price: string }> }
    const raised = (BigInt(doc.products[0]!.price) * 3n).toString()
    doc.products[0]!.price = raised
    writeFileSync(productsFile, JSON.stringify(doc))
    h.upstream.behaviour.status = 200
    await h.restart()

    const challenge = (await (await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))).json())
      .sign_in_with_x
    const proof = await buyer.signIn(challenge, RESOURCE)
    const served = await fetch(
      `${h.base}${CHAT_PATH}`,
      chatRequest({ 'payment-signature': paid.header, 'sign-in-with-x': proof }),
    )
    expect(served.status).toBe(200)
    const receipt = receiptOf(served)!
    // The settled amount in whole USDC (6 decimals), as the receipt writes it.
    const settledUsdc = (Number(settledValue) / 1_000_000).toString()
    expect(receipt.totalt_inkl_moms).toBe(settledUsdc)
    expect(receipt.totalt_inkl_moms).not.toBe((Number(raised) / 1_000_000).toString())
  })
})
