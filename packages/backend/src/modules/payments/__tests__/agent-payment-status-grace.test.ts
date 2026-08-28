import { describe, expect, it } from 'vitest'
import {
  MERCHANT_REPORT_GRACE_MIN,
  merchantReportGraceElapsed,
  resolveMerchantReportGraceMin,
} from '../agent-payment-status.js'

describe('x402 merchant-report grace (#2159)', () => {
  it('keeps the production default when no QA override is configured', () => {
    expect(resolveMerchantReportGraceMin(undefined, [8453, 84532])).toBe(MERCHANT_REPORT_GRACE_MIN)
  })

  it('allows a bounded override only on the Base Sepolia-only QA deployment', () => {
    expect(resolveMerchantReportGraceMin('0', [84532])).toBe(0)
    expect(resolveMerchantReportGraceMin('1', [84532])).toBe(1)
  })

  it('refuses the QA override on mainnet, mixed, or unbounded deployments', () => {
    for (const chains of [[8453], [8453, 84532], []]) {
      expect(() => resolveMerchantReportGraceMin('0', chains)).toThrow(/Base Sepolia QA/)
    }
  })

  it('refuses malformed, negative, fractional, and production-lengthening overrides', () => {
    for (const raw of ['no', '-1', '0.5', '16']) {
      expect(() => resolveMerchantReportGraceMin(raw, [84532])).toThrow(/integer from 0 to 15/)
    }
  })

  it('has exact grace-boundary semantics', () => {
    const confirmedAt = '2026-08-28T12:00:00.000Z'
    const confirmedMs = new Date(confirmedAt).getTime()
    expect(merchantReportGraceElapsed(confirmedAt, confirmedMs + 59_999, 1)).toBe(false)
    expect(merchantReportGraceElapsed(confirmedAt, confirmedMs + 60_000, 1)).toBe(true)
    expect(merchantReportGraceElapsed(confirmedAt, confirmedMs, 0)).toBe(true)
  })
})
