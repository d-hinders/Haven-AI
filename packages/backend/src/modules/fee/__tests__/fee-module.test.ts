import { describe, expect, it, vi } from 'vitest'
import { quoteFee, HavenFeeModule, type FeeContext } from '../fee-module.js'

vi.mock('../../../config.js', () => ({ config: { feeEnabled: false } }))

function ctx(over: Partial<FeeContext> = {}): FeeContext {
  return {
    paymentId: 'pi1',
    rail: 'x402',
    grossAtomic: 1_000_000n,
    token: 'USDC',
    userId: 'u1',
    ...over,
  }
}

describe('quoteFee (dark scaffold)', () => {
  it('returns a zero quote while the module is disabled — no funds move', () => {
    const q = quoteFee(ctx())
    expect(q.feeAtomic).toBe(0n)
    expect(q.basisPoints).toBe(0)
    expect(q.isZero).toBe(true)
    expect(q.feeToken).toBe('USDC')
    expect(q.paymentId).toBe('pi1')
    expect(q.rail).toBe('x402')
  })

  it('never throws and is pure', () => {
    expect(() => quoteFee(ctx({ grossAtomic: 0n }))).not.toThrow()
  })

  it('exposes the #386 module surface (quote/recordSettled)', () => {
    expect(HavenFeeModule.quote).toBe(quoteFee)
    expect(typeof HavenFeeModule.recordSettled).toBe('function')
  })
})
