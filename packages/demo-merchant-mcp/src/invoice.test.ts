import { describe, expect, it } from 'vitest'
import type { SettledPayment } from './x402.js'
import {
  RECEIPT_NUMBER_DIGITS,
  createInvoiceNumberer,
  generateInvoice,
  invoiceForPayment,
  receiptNumberForTransaction,
  renderInvoiceText,
  vatAmountsAtomic,
} from './invoice.js'
import { PRODUCTS, formatUsdc } from './products.js'

const BASE_PARAMS = {
  invoiceNumber: 'FAK-2026-00099',
  productId: 'storage_50gb' as const,
  buyerAddress: '0x2222222222222222222222222222222222222222',
  receivingAddress: '0x1111111111111111111111111111111111111111',
  authorizationNonce: `0x${'ab'.repeat(32)}`,
  txHash: `0x${'cd'.repeat(32)}` as const,
  settlement: 'settled_onchain' as const,
}

/**
 * #2960: the merchant only ever observes the address it verified the
 * payment FROM — the delegate EOA on `eip3009`, the delegate SMART account
 * (`delegator`) on `erc7710` — never the owner's treasury account, which
 * never appears in the x402 payload on either scheme (F1, quality scan
 * 2026-09-13). `payerRole` carries that distinction onto the invoice
 * instead of an unqualified "buyer".
 */
describe('generateInvoice — party role (#2960)', () => {
  it('eip3009: kopare.roll is agent_delegate', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate' })
    expect(invoice.json.kopare.roll).toBe('agent_delegate')
    expect(invoice.json.kopare.identifierare).toBe(BASE_PARAMS.buyerAddress)
  })

  it('erc7710: kopare.roll is agent_delegate_account', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate_account' })
    expect(invoice.json.kopare.roll).toBe('agent_delegate_account')
  })

  it('the Swedish bookkeeping render (#1550) is byte-for-byte UNCHANGED by the party-role field — no "roll" text appears in it', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate_account' })
    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    expect(sv).toContain('KÖPARE')
    expect(sv).not.toContain('Role:')
    expect(sv).not.toMatch(/agent[_ ]delegate/i)
  })

  it('the English render does NOT call a delegate-account payer "the buyer" (mutation target: reintroducing a bare BUYER header must fail this)', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate_account' })
    const en = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'en')
    expect(en).not.toContain('BUYER')
    expect(en).toContain('PAYER')
    expect(en).toContain('Role:')
    expect(en).toMatch(/agent delegate account/i)
  })

  it('the English render labels an eip3009 payer as the agent delegate, not the delegate account', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate' })
    const en = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'en')
    expect(en).not.toContain('BUYER')
    expect(en).toContain('agent delegate address (eip3009)')
    expect(en).not.toMatch(/agent delegate account/i)
  })
})

const ZERO_TX_HASH = `0x${'0'.repeat(64)}`

/**
 * #2969: `already_settled_earlier` and `settlement_unknown` are both
 * non-settled, but they are DIFFERENT facts and must render differently, and
 * neither may print the zero hash the caller still passes in `txHash`
 * (mirroring the real call site — `invoiceForPayment` always forwards
 * `payment.txHash`, which is `ZERO_TX_HASH` on both non-settled paths).
 */
describe('generateInvoice — settlement state (#2969)', () => {
  it('already_settled_earlier: no reference, its own status, no zero hash anywhere', () => {
    const invoice = generateInvoice({
      ...BASE_PARAMS,
      payerRole: 'agent_delegate',
      txHash: ZERO_TX_HASH,
      settlement: 'already_settled_earlier',
      locale: 'sv',
    })
    expect(invoice.json.blockkedje_referens).toBeNull()
    expect(invoice.json.status).toBe('Betald i tidigare transaktion — referens saknas')
    expect(invoice.json.status).not.toBe('Betald')
    expect(JSON.stringify(invoice.json)).not.toContain(ZERO_TX_HASH)
    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    const en = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'en')
    expect(sv).not.toContain('BLOCKKEDJEREFERENS')
    expect(sv).not.toContain(ZERO_TX_HASH)
    expect(en).not.toContain('BLOCKCHAIN REFERENCE')
    expect(en).not.toContain(ZERO_TX_HASH)
    expect(en).toContain('Paid in an earlier transaction')
  })

  it('settlement_unknown: keeps the #2970 "delivered, unconfirmed" status and omits the reference block', () => {
    const invoice = generateInvoice({
      ...BASE_PARAMS,
      payerRole: 'agent_delegate',
      txHash: ZERO_TX_HASH,
      settlement: 'settlement_unknown',
      locale: 'sv',
    })
    expect(invoice.json.blockkedje_referens).toBeNull()
    expect(invoice.json.status).toBe('Levererad — ej bekräftad på kedjan')
    expect(JSON.stringify(invoice.json)).not.toContain(ZERO_TX_HASH)
    // Distinct from already_settled_earlier's status string.
    expect(invoice.json.status).not.toBe('Betald i tidigare transaktion — referens saknas')
  })

  it('settled_onchain: still prints the real reference and "Betald" (unchanged behaviour)', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate', locale: 'sv' })
    expect(invoice.json.blockkedje_referens).toBe(`Tx: ${BASE_PARAMS.txHash}`)
    expect(invoice.json.status).toBe('Betald')
    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    expect(sv).toContain('BLOCKKEDJEREFERENS')
    expect(sv).toContain(BASE_PARAMS.txHash)
  })

  // #4980: one document per payment — a call in the other locale replays it
  // under its own headings, so the Swedish render of an English document is
  // Swedish labels around English values. Pinned so it is a decision, not drift.
  it('the Swedish render of an English document prints its values as they are', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate' })
    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    expect(sv).toContain('FAKTURA')
    expect(sv).toContain('  Status: Paid\n')
    expect(sv).toContain(`  Betalningssätt:   ${invoice.json.betalningssatt}\n`)
    expect(invoice.json.betalningssatt).toMatch(/^Cryptocurrency \(USDC on /)
  })

  // #4980: the default receipt states each settlement truth in English, in
  // the JSON as in the text — the same three strings the English render
  // always printed.
  it('the default (English) receipt states each settlement state in English', () => {
    for (const [settlement, status] of [
      ['settled_onchain', 'Paid'],
      ['already_settled_earlier', 'Paid in an earlier transaction — reference unavailable'],
      ['settlement_unknown', 'Delivered — not confirmed on-chain'],
    ] as const) {
      const invoice = generateInvoice({
        ...BASE_PARAMS,
        payerRole: 'agent_delegate',
        settlement,
        txHash: settlement === 'settled_onchain' ? BASE_PARAMS.txHash : ZERO_TX_HASH,
      })
      expect(invoice.json.status).toBe(status)
      expect(invoice.text).toContain(`  Status: ${status}\n`)
      expect(renderInvoiceText(invoice.json, 'CloudNest 50 GB', 'en')).toBe(invoice.text)
    }
  })
})

// #2988: two merchant processes started one second apart — the first having
// issued more invoices than seconds elapsed — must not re-issue each other's
// numbers. With the old seconds seed the second process's first number was
// the first process's second number.
describe('invoice numbering across restarts (#2988)', () => {
  it('a restart one second later does not re-issue numbers the previous process already used', () => {
    const t0 = Date.parse('2026-09-15T08:00:00.000Z')
    const first = createInvoiceNumberer(t0)
    const issuedBeforeRestart = new Set(Array.from({ length: 50 }, () => first()))

    const second = createInvoiceNumberer(t0 + 1_000)
    const issuedAfterRestart = Array.from({ length: 50 }, () => second())

    for (const n of issuedAfterRestart) expect(issuedBeforeRestart.has(n)).toBe(false)
    expect(issuedAfterRestart[0]).toMatch(/^FAK-\d{4}-\d+$/)
  })

  it('the default seed is the millisecond clock, not seconds', () => {
    const before = Date.now()
    const n = createInvoiceNumberer()()
    const seq = Number(n.split('-')[2])
    expect(seq).toBeGreaterThan(before) // seed + 1 ≥ now + 1
    expect(seq).toBeLessThanOrEqual(Date.now() + 1)
  })
})

/**
 * #3422: about nine in ten OCRs the merchant issued failed Luhn validation —
 * the check digit was computed with the VALIDATING form of the algorithm
 * (doubling from the second-to-last digit) instead of the generating form
 * (doubling from the last digit of the base). These assertions validate the OCR the executed
 * `generateInvoice` emitted, with an independent validator, not the helper's
 * own arithmetic.
 */
function passesLuhn(ocr: string): boolean {
  let sum = 0
  for (let i = 0; i < ocr.length; i++) {
    let d = Number(ocr[ocr.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

describe('OCR check digit (#3422)', () => {
  it('matches the textbook Luhn vector (79927398713)', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate_account', invoiceNumber: 'FAK-7992739871' })
    expect(invoice.json.ocr_nummer).toBe('79927398713')
  })

  it('reissues the four OCRs observed live on 2026-09-28 with valid check digits', () => {
    const observed: Array<[string, string]> = [
      ['FAK-2026-1790585044329', '202617905850443299'],
      ['FAK-2026-1790585044330', '202617905850443307'],
      ['FAK-2026-1790585044331', '202617905850443315'],
      ['FAK-2026-1790585044332', '202617905850443323'],
    ]
    for (const [invoiceNumber, expected] of observed) {
      expect(generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate_account', invoiceNumber }).json.ocr_nummer).toBe(expected)
    }
  })

  it('every OCR from a run of consecutive invoice numbers passes Luhn validation', () => {
    const next = createInvoiceNumberer(Date.parse('2026-09-28T12:00:00.000Z'))
    for (let i = 0; i < 200; i++) {
      const invoiceNumber = next()
      const { ocr_nummer } = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate_account', invoiceNumber }).json
      expect(ocr_nummer.startsWith(invoiceNumber.replace(/\D/g, ''))).toBe(true)
      expect(passesLuhn(ocr_nummer), `${invoiceNumber} → ${ocr_nummer}`).toBe(true)
    }
  })
})

// ── #4855: buyer declaration and VAT treatment ───────────────────────────────
// `storage_50gb` costs 500 atomic USDC. Under SE_25 that is 400 net + 100 VAT;
// under REVERSE_CHARGE the full 500 is net and the VAT amount is zero.
const SE_DECLARATION = {
  jurisdiction: 'SE',
  taxId: 'SE559412345601',
  taxableStatus: 'TAXABLE_PERSON',
  validUntil: Date.parse('2027-06-30T00:00:00.000Z'),
}
const DE_DECLARATION = {
  jurisdiction: 'DE',
  taxId: 'DE123456789',
  taxableStatus: 'TAXABLE_PERSON',
  validUntil: Date.parse('2027-06-30T00:00:00.000Z'),
}

describe('generateInvoice — buyer declaration and VAT treatment (#4855)', () => {
  it('an accepted Swedish declaration puts the buyer block on the receipt and keeps SE_25', () => {
    const invoice = generateInvoice({
      ...BASE_PARAMS,
      payerRole: 'agent_delegate',
      taxDeclaration: SE_DECLARATION,
    })

    expect(invoice.json.momsbehandling).toBe('SE_25')
    expect(invoice.json.kopare.deklaration).toEqual({
      land: 'SE',
      moms_nr: 'SE559412345601',
      status: 'TAXABLE_PERSON',
      giltig_till: '2027-06-30',
    })
    // The VAT lines are unchanged from today under SE_25.
    expect(invoice.json.belopp_exkl_moms).toBe('0.0004')
    expect(invoice.json.moms_procent).toBe(25)
    expect(invoice.json.moms_belopp).toBe('0.0001')
    expect(invoice.json.totalt_inkl_moms).toBe('0.0005')
    expect(invoice.json.rader[0].moms_procent).toBe(25)

    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    expect(sv).toContain('Land:             SE')
    expect(sv).toContain('Momsreg.nr:       SE559412345601')
    expect(sv).toContain('Status:           TAXABLE_PERSON')
    expect(sv).toContain('Deklaration giltig till: 2027-06-30')
    // SE_25 carries no reverse-charge note.
    expect(sv).not.toContain('Omvänd betalningsskyldighet')

    const en = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'en')
    expect(en).toContain('Country: SE')
    expect(en).toContain('VAT reg. no: SE559412345601')
    expect(en).toContain('Declaration valid until: 2027-06-30')
    expect(en).not.toContain('Reverse charge')
  })

  it('an accepted declaration from another EU country is REVERSE_CHARGE: net = total = price, 0% VAT, zero VAT amount', () => {
    const invoice = generateInvoice({
      ...BASE_PARAMS,
      payerRole: 'agent_delegate',
      taxDeclaration: DE_DECLARATION,
    })

    expect(invoice.json.momsbehandling).toBe('REVERSE_CHARGE')
    expect(invoice.json.belopp_exkl_moms).toBe('0.0005')
    expect(invoice.json.totalt_inkl_moms).toBe('0.0005')
    expect(invoice.json.moms_procent).toBe(0)
    expect(invoice.json.moms_belopp).toBe('0')
    expect(invoice.json.rader[0]).toMatchObject({
      apris_exkl_moms: '0.0005',
      moms_procent: 0,
      moms_belopp: '0',
      totalt_inkl_moms: '0.0005',
    })
    // The price itself does not change with the treatment.
    expect(invoice.json.totalt_inkl_moms).toBe(formatUsdc(PRODUCTS.storage_50gb.price_usdc))

    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    expect(sv).toContain('Omvänd betalningsskyldighet')
    expect(sv).toContain('Säljarens momsreg.nr: SE559412345601')
    expect(sv).toContain('Köparens momsreg.nr: DE123456789')

    const en = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'en')
    expect(en).toContain('Reverse charge')
    expect(en).toContain('Seller VAT reg. no: SE559412345601')
    expect(en).toContain('Buyer VAT reg. no: DE123456789')
  })

  it('a purchase without a declaration has no buyer block and is unchanged apart from the treatment field', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate' })

    expect(invoice.json.momsbehandling).toBe('SE_25')
    // No `deklaration` key at all — the buyer block keeps its exact shape.
    expect(Object.keys(invoice.json.kopare)).toEqual(['identifierare', 'typ', 'roll'])
    expect(invoice.json.kopare.deklaration).toBeUndefined()
    expect(invoice.json.belopp_exkl_moms).toBe('0.0004')
    expect(invoice.json.moms_procent).toBe(25)
    expect(invoice.json.moms_belopp).toBe('0.0001')
    expect(invoice.json.totalt_inkl_moms).toBe('0.0005')

    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    expect(sv).not.toContain('Land:')
    expect(sv).not.toContain('Deklaration giltig till')
    expect(sv).not.toContain('Omvänd betalningsskyldighet')
    const en = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'en')
    expect(en).not.toContain('Country:')
    expect(en).not.toContain('Reverse charge')
  })

  it('keeps the seller keys Haven accounting reads (name, org_nr, moms_nr) in every treatment', () => {
    for (const taxDeclaration of [null, SE_DECLARATION, DE_DECLARATION]) {
      const { json } = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate', taxDeclaration })
      expect(json.saljare.name).toBe('Haven Demo AB')
      expect(json.saljare.org_nr).toBe('559412-3456')
      expect(json.saljare.moms_nr).toBe('SE559412345601')
    }
  })

  it('leaves the rendered buyer block and VAT block byte-for-byte unchanged when there is no declaration', () => {
    const invoice = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate' })
    const sv = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'sv')
    // The two regions this change touches: the buyer block keeps its single
    // blank line, and the totals block keeps its exact SE_25 lines.
    expect(sv).toContain(`KÖPARE\n  Blockkedjeadress: ${BASE_PARAMS.buyerAddress}\n\n────`)
    expect(sv).toContain(
      '  Belopp exkl. moms:   0.0004 USDC\n' +
        '  Moms 25%:              0.0001 USDC\n' +
        '  TOTALT inkl. moms:   0.0005 USDC\n────',
    )

    const en = renderInvoiceText(invoice.json, 'Cloud Storage 50GB', 'en')
    expect(en).toContain(`PAYER\n  Blockchain address: ${BASE_PARAMS.buyerAddress}\n  Role: agent delegate address (eip3009)\n\n────`)
    expect(en).toContain(
      '  Amount excl. VAT:    0.0004 USDC\n' +
        '  VAT 25%:             0.0001 USDC\n' +
        '  TOTAL incl. VAT:     0.0005 USDC\n────',
    )
  })
})

/**
 * #4875: Haven's accounting reads the lines and VAT off this receipt by these
 * keys and types (`packages/backend/src/modules/accounting/receipt-statement.ts`,
 * `docs/operations/merchant-receipt-shape.md`). A rename here would turn every
 * demo purchase's lines into "not stated" with no other test failing.
 */
describe('generateInvoice — the keys Haven reads lines and VAT by (#4875)', () => {
  const DECIMAL = /^\d+(\.\d+)?$/
  for (const [name, taxDeclaration] of [
    ['SE_25', undefined],
    ['REVERSE_CHARGE', DE_DECLARATION],
  ] as const) {
    it(`${name}: rader, the totals, momsbehandling and valuta keep their keys and types`, () => {
      const { json } = generateInvoice({ ...BASE_PARAMS, payerRole: 'agent_delegate', taxDeclaration })
      const top = json as unknown as Record<string, unknown>
      for (const key of ['belopp_exkl_moms', 'moms_belopp', 'totalt_inkl_moms']) {
        expect(typeof top[key], key).toBe('string')
        expect(top[key]).toMatch(DECIMAL)
      }
      expect(typeof top.moms_procent).toBe('number')
      expect(top.valuta).toBe('USDC')
      expect(top.momsbehandling).toBe(name)
      expect(Array.isArray(top.rader)).toBe(true)
      expect(json.rader.length).toBeGreaterThan(0)
      for (const row of json.rader as unknown as Array<Record<string, unknown>>) {
        expect(typeof row.beskrivning).toBe('string')
        expect(typeof row.antal).toBe('number')
        for (const key of ['apris_exkl_moms', 'moms_belopp', 'totalt_inkl_moms']) {
          expect(typeof row[key], key).toBe('string')
          expect(row[key]).toMatch(DECIMAL)
        }
        expect(typeof row.moms_procent).toBe('number')
      }
    })
  }
})

// #4880: the receipt number of a payment settled on-chain comes from its
// transaction hash, so a restart and the reconciliation script give the same
// number. Any other payment keeps the counter.
describe('receipt number from the transaction hash (#4880)', () => {
  const TX = `0x${'cd'.repeat(32)}` as const

  it('is FAK- and the hash modulo 10^16, zero-padded to sixteen digits', () => {
    expect(RECEIPT_NUMBER_DIGITS).toBe(16)
    expect(receiptNumberForTransaction(TX)).toBe(`FAK-${(BigInt(TX) % 10n ** 16n).toString().padStart(16, '0')}`)
    expect(receiptNumberForTransaction(`0x${'00'.repeat(31)}01`)).toBe('FAK-0000000000000001')
    expect(receiptNumberForTransaction(TX)).toMatch(/^FAK-\d{16}$/)
  })

  it('differs for different transactions', () => {
    expect(receiptNumberForTransaction(`0x${'ab'.repeat(32)}`)).not.toBe(receiptNumberForTransaction(TX))
  })

  it('keeps the OCR reference a valid 17-digit Luhn number', () => {
    const { json } = generateInvoice({ ...BASE_PARAMS, invoiceNumber: receiptNumberForTransaction(TX), payerRole: 'agent_delegate' })
    expect(json.ocr_nummer).toMatch(/^\d{17}$/)
    expect(json.ocr_nummer.slice(0, 16)).toBe(json.fakturanummer.slice(4))
    // Validating Luhn over the whole number, check digit included.
    let sum = 0
    for (let i = 0; i < json.ocr_nummer.length; i++) {
      let d = Number(json.ocr_nummer[json.ocr_nummer.length - 1 - i])
      if (i % 2 === 1) d *= 2
      if (d > 9) d -= 9
      sum += d
    }
    expect(sum % 10).toBe(0)
  })

  const payment = (settlement: SettledPayment['settlement'], txHash: `0x${string}` = TX) =>
    ({
      productId: 'joke',
      settlementMethod: 'eip3009',
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
      value: 10_000n,
      nonce: `0x${'ab'.repeat(32)}`,
      txHash,
      settlement,
    }) as unknown as SettledPayment
  const opts = { receivingAddress: '0x1111111111111111111111111111111111111111' }

  it('a settled payment gets the same number however many times, and in however many processes, it is issued', () => {
    // Two payment objects for one transaction: what a restart and a replay look like.
    const first = invoiceForPayment(payment('settled_onchain'), 'joke', opts).json.fakturanummer
    const again = invoiceForPayment(payment('settled_onchain'), 'joke', opts).json.fakturanummer
    expect(first).toBe(receiptNumberForTransaction(TX))
    expect(again).toBe(first)
  })

  it('a payment with no transaction to key on keeps the counter', () => {
    const zero = `0x${'00'.repeat(32)}` as const
    for (const settlement of ['already_settled_earlier', 'settlement_unknown'] as const) {
      const { fakturanummer } = invoiceForPayment(payment(settlement, zero), 'joke', opts).json
      expect(fakturanummer).toMatch(/^FAK-\d{4}-\d+$/)
    }
  })
})

describe('vatAmountsAtomic (#4880)', () => {
  it('takes 25% out of a VAT-inclusive price under SE_25, and nothing under REVERSE_CHARGE', () => {
    expect(vatAmountsAtomic(10_000n, 'SE_25')).toEqual({ exclVat: 8_000n, vat: 2_000n, vatPercent: 25 })
    expect(vatAmountsAtomic(10_000n, 'REVERSE_CHARGE')).toEqual({ exclVat: 10_000n, vat: 0n, vatPercent: 0 })
  })

  it('is the split the receipt prints', () => {
    const { json } = generateInvoice({ ...BASE_PARAMS, productId: 'joke', payerRole: 'agent_delegate' })
    expect(json.moms_belopp).toBe(formatUsdc(vatAmountsAtomic(PRODUCTS.joke.price_usdc, 'SE_25').vat))
  })
})
