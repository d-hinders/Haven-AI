/**
 * #4532 — the transaction-kind classifier.
 *
 * The acceptance criterion this file exists for: the three Bitrefill routes
 * measured on production 2026-10-29 (`POST /x402/invoice/create`,
 * `POST /x402/invoice/pay`, `GET /x402/invoice/status`) pin to `api_fee`,
 * `purchase`, `api_fee` respectively. Everything else here pins the ladder's
 * other rungs and the "never guessed" rule.
 */
import { describe, expect, it } from 'vitest'
import {
  TRANSACTION_KINDS,
  deriveTransactionKind,
  merchantDocumentShape,
  transactionDescription,
  type TransactionKindSignals,
} from '../transaction-kind.js'

/** A settled outbound payment with no signal beyond its route. */
function signals(over: Partial<TransactionKindSignals> = {}): TransactionKindSignals {
  return {
    direction: 'out',
    resourceUrl: null,
    mcpToolName: null,
    merchantReceiptJson: null,
    deliveryReference: null,
    ...over,
  }
}

describe('the three Bitrefill routes (#4532 acceptance)', () => {
  // The exact URLs measured on production during the #4497 rehearsal: one
  // BikBok gift-card purchase settled three payments, and only the middle one
  // is the purchase.
  const ROUTES = [
    { url: 'https://api.bitrefill.com/x402/invoice/create', kind: 'api_fee' },
    { url: 'https://api.bitrefill.com/x402/invoice/pay', kind: 'purchase' },
    { url: 'https://api.bitrefill.com/x402/invoice/status', kind: 'api_fee' },
  ] as const

  for (const route of ROUTES) {
    it(`${route.url} → ${route.kind}`, () => {
      const verdict = deriveTransactionKind(signals({ resourceUrl: route.url }))
      expect(verdict.kind).toBe(route.kind)
      expect(verdict.basis).toBe('route')
    })
  }

  it('CONTROL: the three routes really do differ, so the assertions above can fail', () => {
    const kinds = ROUTES.map((r) => deriveTransactionKind(signals({ resourceUrl: r.url })).kind)
    expect(new Set(kinds).size).toBe(2)
    expect(kinds).not.toEqual(['purchase', 'purchase', 'purchase'])
  })

  it('the route label keeps the last two segments, so the description names the call', () => {
    expect(deriveTransactionKind(signals({ resourceUrl: ROUTES[1].url })).route).toBe('invoice/pay')
    expect(deriveTransactionKind(signals({ resourceUrl: ROUTES[0].url })).route).toBe('invoice/create')
  })
})

describe('the signal ladder', () => {
  it('an inbound payment is a refund — the feed direction contract', () => {
    const verdict = deriveTransactionKind(signals({ direction: 'in', resourceUrl: 'https://m.example/pay' }))
    expect(verdict.kind).toBe('refund')
    expect(verdict.basis).toBe('direction')
  })

  it('a merchant invoice outranks the route verb — a product was sold', () => {
    const verdict = deriveTransactionKind(
      signals({
        resourceUrl: 'https://api.bitrefill.com/x402/invoice/create',
        merchantReceiptJson: { fakturanummer: 'FAK-1', saljare: { name: 'Haven Demo AB' } },
      }),
    )
    expect(verdict.kind).toBe('purchase')
    expect(verdict.basis).toBe('merchant_document')
  })

  it('a bare acknowledgement outranks the route verb — the paid call delivered nothing', () => {
    const verdict = deriveTransactionKind(
      signals({
        resourceUrl: 'https://api.bitrefill.com/x402/invoice/pay',
        merchantReceiptJson: { ok: true },
      }),
    )
    expect(verdict.kind).toBe('api_fee')
    expect(verdict.basis).toBe('merchant_document')
  })

  it('a named deliverable is a purchase, whatever the route says', () => {
    const verdict = deriveTransactionKind(
      signals({
        resourceUrl: 'https://api.bitrefill.com/x402/invoice/status',
        deliveryReference: 'Bik Bok 5 SEK, order 6ac7',
      }),
    )
    expect(verdict.kind).toBe('purchase')
    expect(verdict.basis).toBe('delivery_reference')
  })

  it('an MCP tool call is the paid deliverable — the resource URL names nothing', () => {
    const verdict = deriveTransactionKind(
      signals({ resourceUrl: 'https://mcp.soundside.ai/mcp', mcpToolName: 'create_text' }),
    )
    expect(verdict.kind).toBe('purchase')
    expect(verdict.basis).toBe('mcp_tool')
    expect(verdict.route).toBe('create_text')
  })

  it('a transfer verb is a transfer, not a purchase', () => {
    const verdict = deriveTransactionKind(signals({ resourceUrl: 'https://m.example/v1/transfer' }))
    expect(verdict.kind).toBe('transfer')
    expect(verdict.basis).toBe('route')
  })

  it('no derivable signal is `unknown` — never a guess', () => {
    const verdict = deriveTransactionKind(signals({ resourceUrl: 'https://api.example/v1/thing' }))
    expect(verdict.kind).toBe('unknown')
    expect(verdict.basis).toBe('none')
  })

  it('an ambiguous verb stays unknown — `price` is a paid data call, not a fee', () => {
    // https://api.anchor-x402.com/v1/price/token: the OUTPUT is the price, so
    // the verb cannot decide between purchase and fee.
    const verdict = deriveTransactionKind(signals({ resourceUrl: 'https://api.anchor-x402.com/v1/price/token' }))
    expect(verdict.kind).toBe('unknown')
  })

  it('an unparseable or absent resource URL is unknown, not a crash', () => {
    expect(deriveTransactionKind(signals({ resourceUrl: 'not a url' })).kind).toBe('unknown')
    expect(deriveTransactionKind(signals({ resourceUrl: null })).kind).toBe('unknown')
    expect(deriveTransactionKind(signals({ resourceUrl: 'https://api.example/' })).kind).toBe('unknown')
  })

  it('an empty delivery reference is not a signal', () => {
    const verdict = deriveTransactionKind(
      signals({ resourceUrl: 'https://api.example/v1/status', deliveryReference: '   ' }),
    )
    expect(verdict.kind).toBe('api_fee')
    expect(verdict.basis).toBe('route')
  })
})

describe('an agent cannot set the kind', () => {
  it('a transactionKind smuggled onto the signals object is ignored', () => {
    // The derivation reads five named facts and nothing else. A caller that
    // passes a kind of its own changes nothing — this is the executable form
    // of "derived server-side; an agent cannot set it".
    const smuggled = {
      ...signals({ resourceUrl: 'https://api.bitrefill.com/x402/invoice/create' }),
      transactionKind: 'purchase',
      kind: 'purchase',
    } as TransactionKindSignals
    expect(deriveTransactionKind(smuggled).kind).toBe('api_fee')
  })

  it('every kind the classifier can return is in the closed enum', () => {
    const produced = [
      deriveTransactionKind(signals({ direction: 'in' })),
      deriveTransactionKind(signals({ resourceUrl: 'https://m.example/pay' })),
      deriveTransactionKind(signals({ resourceUrl: 'https://m.example/status' })),
      deriveTransactionKind(signals({ resourceUrl: 'https://m.example/transfer' })),
      deriveTransactionKind(signals({ resourceUrl: 'https://m.example/thing' })),
    ].map((v) => v.kind)
    for (const kind of produced) expect(TRANSACTION_KINDS).toContain(kind)
    expect(new Set(produced)).toEqual(new Set(TRANSACTION_KINDS))
  })
})

describe('merchantDocumentShape', () => {
  it('reads an invoice flat or one level nested', () => {
    expect(merchantDocumentShape({ fakturanummer: 'FAK-1' })).toBe('invoice')
    expect(merchantDocumentShape({ data: { invoice_number: 'INV-1' } })).toBe('invoice')
    expect(merchantDocumentShape({ invoiceNumber: 'INV-1' })).toBe('invoice')
  })

  it('reads a body with no invoice marker as a bare acknowledgement', () => {
    expect(merchantDocumentShape({ ok: true })).toBe('acknowledgement')
    expect(merchantDocumentShape({ status: 'accepted' })).toBe('acknowledgement')
  })

  it('reads nothing at all as no signal', () => {
    expect(merchantDocumentShape(null)).toBeNull()
    expect(merchantDocumentShape(undefined)).toBeNull()
    expect(merchantDocumentShape({})).toBeNull()
    expect(merchantDocumentShape('a string')).toBeNull()
    expect(merchantDocumentShape([{ invoice: 'x' }])).toBeNull()
  })
})

describe('transactionDescription', () => {
  it('names the merchant host, the route and the kind', () => {
    expect(
      transactionDescription('purchase', null, 'https://api.bitrefill.com/x402/invoice/pay', 'invoice/pay'),
    ).toBe('api.bitrefill.com - invoice/pay (purchase)')
    expect(
      transactionDescription('api_fee', null, 'https://api.bitrefill.com/x402/invoice/create', 'invoice/create'),
    ).toBe('api.bitrefill.com - invoice/create (API fee)')
  })

  it('prefers the counterparty name when the entry carries one', () => {
    expect(transactionDescription('purchase', 'Bitrefill', 'https://api.bitrefill.com/x/pay', 'x/pay')).toBe(
      'Bitrefill - x/pay (purchase)',
    )
  })

  it('falls back to the kind alone when there is no route', () => {
    expect(transactionDescription('unknown', null, null, null)).toBe('Unknown merchant (unclassified)')
  })

  it('is ASCII only — the PDF renderer folds everything else to ?', () => {
    const line = transactionDescription('purchase', 'Bik Bok — gift cards', 'https://m.example/pay', 'pay')
    expect(line).toMatch(/^[\x20-\x7e]+$/)
    expect(line).toContain('Bik Bok ? gift cards')
  })
})
