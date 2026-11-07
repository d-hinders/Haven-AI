/**
 * #4723 (epic #4718): the demo merchant as the first (advisory) passport
 * consumer.
 *
 * The settle path is untouched by this feature: the check runs after
 * settlement, is cached per payment, and never refuses anything. These tests
 * pin the three surfaces the issue names — the advertised extension, the
 * purchase response, and the copy — plus the no-env case that must stay
 * byte-identical to today.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEMO_MERCHANT_EXTENSIONS,
  buildPaymentRequired,
  demoMerchantExtensions,
  type PassportVerifierConfig,
  type SettledPayment,
} from './x402.js'
import {
  buildPurchaseSummary,
  passportSummaryFor,
  renderPassportLine,
  type PassportSummary,
} from './server.js'
import { PRODUCTS } from './products.js'
import type { Invoice } from './invoice.js'
import type { CheckPassportOptions, PassportCheckResult } from '@haven_ai/sdk'

const MERCHANT = '0x1111111111111111111111111111111111111111' as const
const PAYER = '0x2222222222222222222222222222222222222222' as const
const TX_HASH = `0x${'aa'.repeat(32)}` as const
const UID = `0x${'ab'.repeat(32)}`
const CHAIN_ID = 84532

const PASSPORT_CONFIG: PassportVerifierConfig = {
  baseUrl: 'https://haven.test',
  issuer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
}

function fakeSettledPayment(overrides: Partial<SettledPayment> = {}): SettledPayment {
  return {
    productId: 'storage_50gb',
    settlementMethod: 'eip3009',
    from: PAYER,
    to: MERCHANT,
    value: PRODUCTS.storage_50gb.price_usdc,
    nonce: `0x${'aa'.repeat(32)}`,
    txHash: TX_HASH,
    paymentResponse: {
      success: true,
      payer: PAYER,
      transaction: TX_HASH,
      network: 'eip155:8453',
      amount: PRODUCTS.storage_50gb.price_usdc.toString(),
    },
    paymentResponseHeader: 'irrelevant',
    settlement: 'settled_onchain',
    passportReference: { attestation_uid: UID, chain_id: CHAIN_ID },
    ...overrides,
  }
}

function fakeInvoice(): Invoice {
  return {
    json: {
      fakturanummer: 'FAK-2026-00042',
      fakturadatum: '2026-11-07',
      förfallodatum: '2026-12-07',
      säljare: { namn: 'Haven Demo Merchant', adress: 'Testgatan 1', organisationsnummer: '559000-0000' },
      köpare: { namn: 'Test Agent', adress: 'Testvägen 2' },
      rader: [],
      summa: 0,
      moms: 0,
      totalt: 0,
      valuta: 'USDC',
    },
  } as unknown as Invoice
}

function checkResult(overrides: Partial<PassportCheckResult> = {}): PassportCheckResult {
  return {
    ok: true,
    standing: 'active',
    reason: null,
    checked_at: '2026-11-07T11:00:00.000Z',
    ...overrides,
  }
}

describe('the advertised extensions (#4723)', () => {
  // Spec-review finding 6: `toEqual(DEMO_MERCHANT_EXTENSIONS)` compares against
  // the constant the code emits, so folding `haven-passport` into it would keep
  // the test green. Pin a LITERAL instead.
  it('with no passport config advertises exactly haven-demo', () => {
    expect(Object.keys(demoMerchantExtensions())).toEqual(['haven-demo'])
    expect(Object.keys(demoMerchantExtensions(null))).toEqual(['haven-demo'])
  })

  it('with a passport config advertises haven-passport as { info: {} }', () => {
    const extensions = demoMerchantExtensions(PASSPORT_CONFIG)
    expect(Object.keys(extensions)).toEqual(['haven-demo', 'haven-passport'])
    expect(extensions['haven-passport']).toEqual({ info: {} })
    // The base block is untouched — the echo rule deep-compares it.
    expect(extensions['haven-demo']).toEqual(DEMO_MERCHANT_EXTENSIONS['haven-demo'])
  })

  it('buildPaymentRequired advertises only haven-demo without a config', () => {
    const pr = buildPaymentRequired({
      merchantAddress: MERCHANT,
      amountUsdc: 1_000n,
      resource: 'https://merchant.test/mcp',
      description: 'test',
    })
    expect(Object.keys(pr.extensions as Record<string, unknown>)).toEqual(['haven-demo'])
  })

  it('buildPaymentRequired advertises haven-passport with a config', () => {
    const pr = buildPaymentRequired({
      merchantAddress: MERCHANT,
      amountUsdc: 1_000n,
      resource: 'https://merchant.test/mcp',
      description: 'test',
      passport: PASSPORT_CONFIG,
    })
    expect(Object.keys(pr.extensions as Record<string, unknown>)).toEqual(['haven-demo', 'haven-passport'])
  })
})

describe('passportSummaryFor (#4723)', () => {
  it('is null when the payment carried no reference', async () => {
    const check = vi.fn()
    expect(
      await passportSummaryFor(fakeSettledPayment({ passportReference: null }), {
        passport: PASSPORT_CONFIG,
        check,
      }),
    ).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })

  it('is null when the merchant has no passport config', async () => {
    const check = vi.fn()
    expect(await passportSummaryFor(fakeSettledPayment(), { check })).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })

  it('reports { standing, checked_at } for a verified receipt', async () => {
    const summary = await passportSummaryFor(fakeSettledPayment(), {
      passport: PASSPORT_CONFIG,
      chainId: CHAIN_ID,
      check: async () => checkResult(),
    })
    expect(summary).toEqual({ standing: 'active', checked_at: '2026-11-07T11:00:00.000Z' })
  })

  it('reports { error } for a non-active standing, never a standing', async () => {
    const summary = await passportSummaryFor(fakeSettledPayment(), {
      passport: PASSPORT_CONFIG,
      chainId: CHAIN_ID,
      check: async () => checkResult({ ok: false, standing: 'revoked', reason: 'not_active' }),
    })
    expect(summary).toEqual({ error: 'not_active', checked_at: '2026-11-07T11:00:00.000Z' })
  })

  it('reports { error: unavailable } when the verifier is down — and the payment still settled', async () => {
    const payment = fakeSettledPayment()
    const summary = await passportSummaryFor(payment, {
      passport: PASSPORT_CONFIG,
      chainId: CHAIN_ID,
      check: async () => checkResult({ ok: false, standing: null, reason: 'unavailable' }),
    })
    expect(summary).toEqual({ error: 'unavailable', checked_at: '2026-11-07T11:00:00.000Z' })
    // The settle path is untouched: the payment is still a settled one.
    expect(payment.settlement).toBe('settled_onchain')
    expect(payment.txHash).toBe(TX_HASH)
  })

  it('reports { error: subject_mismatch } for a lent passport', async () => {
    const summary = await passportSummaryFor(fakeSettledPayment(), {
      passport: PASSPORT_CONFIG,
      chainId: CHAIN_ID,
      check: async () => checkResult({ ok: false, standing: null, reason: 'subject_mismatch' }),
    })
    expect(summary).toEqual({ error: 'subject_mismatch', checked_at: '2026-11-07T11:00:00.000Z' })
  })

  it('passes the payer, the rail, the chain and the reference to the checker', async () => {
    const check = vi.fn(async () => checkResult())
    await passportSummaryFor(fakeSettledPayment(), { passport: PASSPORT_CONFIG, chainId: CHAIN_ID, check })
    expect(check).toHaveBeenCalledWith({
      baseUrl: PASSPORT_CONFIG.baseUrl,
      issuer: PASSPORT_CONFIG.issuer,
      payer: PAYER,
      rail: 'eip3009',
      chainId: CHAIN_ID,
      reference: { attestation_uid: UID, chain_id: CHAIN_ID },
    })
  })

  it('binds the erc7710 payer on the erc7710 rail', async () => {
    const check = vi.fn(async (_options: CheckPassportOptions) => checkResult())
    await passportSummaryFor(fakeSettledPayment({ settlementMethod: 'erc7710' }), {
      passport: PASSPORT_CONFIG,
      chainId: CHAIN_ID,
      check,
    })
    expect(check.mock.calls[0][0]).toMatchObject({ rail: 'erc7710' })
  })

  // Spec-review finding 7: duplicate tool calls must not re-hit Haven.
  it('reuses the first check for a duplicate call on the same payment', async () => {
    const payment = fakeSettledPayment()
    const check = vi.fn(async () => checkResult())
    const first = await passportSummaryFor(payment, { passport: PASSPORT_CONFIG, chainId: CHAIN_ID, check })
    const second = await passportSummaryFor(payment, { passport: PASSPORT_CONFIG, chainId: CHAIN_ID, check })
    expect(check).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('never throws when the checker throws', async () => {
    const summary = await passportSummaryFor(fakeSettledPayment(), {
      passport: PASSPORT_CONFIG,
      chainId: CHAIN_ID,
      check: async () => {
        throw new Error('boom')
      },
    })
    expect(summary).toMatchObject({ error: 'unavailable' })
  })
})

describe('the purchase response (#4723)', () => {
  it('carries passport: null when the payment carried no reference', () => {
    const summary = buildPurchaseSummary(fakeSettledPayment({ passportReference: null }), fakeInvoice())
    expect(summary.passport).toBeNull()
  })

  it('carries passport: { standing, checked_at } when the check passed', () => {
    const passport: PassportSummary = { standing: 'active', checked_at: '2026-11-07T11:00:00.000Z' }
    const summary = buildPurchaseSummary(fakeSettledPayment(), fakeInvoice(), passport)
    expect(summary.passport).toEqual(passport)
  })

  it('carries passport: { error } when the check could not answer', () => {
    const passport: PassportSummary = { error: 'unavailable', checked_at: '2026-11-07T11:00:00.000Z' }
    const summary = buildPurchaseSummary(fakeSettledPayment(), fakeInvoice(), passport)
    expect(summary.passport).toEqual(passport)
  })
})

describe('the copy rule (#4723)', () => {
  // Spec-review finding 8: `lint:copy` scans the frontend only, so the rule
  // needs a mechanism. This is it.
  it('says the standing was CHECKED, never "verified"', () => {
    const line = renderPassportLine({ standing: 'active', checked_at: '2026-11-07T11:00:00.000Z' }, 'en')
    expect(line).toContain('checked')
    expect(line.toLowerCase()).not.toContain('verified')
    expect(line.toLowerCase()).not.toContain('verified agent')
  })

  it('says the standing was NOT checked when the check failed', () => {
    const line = renderPassportLine({ error: 'unavailable', checked_at: '2026-11-07T11:00:00.000Z' }, 'en')
    expect(line).toContain('not checked')
    expect(line.toLowerCase()).not.toContain('verified')
  })

  it('holds in Swedish too', () => {
    const line = renderPassportLine({ standing: 'active', checked_at: '2026-11-07T11:00:00.000Z' }, 'sv')
    expect(line).toContain('kontrollerad')
    expect(line.toLowerCase()).not.toContain('verifierad')
  })

  it('renders nothing when the payment carried no reference', () => {
    expect(renderPassportLine(null, 'en')).toBe('')
  })

  it('the structured summary never says "verified"', () => {
    const summary = buildPurchaseSummary(fakeSettledPayment(), fakeInvoice(), {
      standing: 'active',
      checked_at: '2026-11-07T11:00:00.000Z',
    })
    expect(JSON.stringify(summary.passport).toLowerCase()).not.toContain('verified')
  })
})
