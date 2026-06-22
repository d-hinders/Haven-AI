import { describe, expect, it } from 'vitest'
import { decideCoverage, type CoverageDecision } from '../payment-coverage.js'

/**
 * Decision-table oracle for decideCoverage (PT-1 PR3). Each row is an
 * independent statement of the policy, not a snapshot of the implementation —
 * the expected decision is derived from the rule ("queue when over allowance
 * but covered", "reject when beyond delegate balance + allowance"), so the
 * table is a real spec, not a mirror of the code.
 */

describe('decideCoverage — allowance-only (MPP / generic rails)', () => {
  // remaining = 100; delegateBalance is irrelevant and set high to prove it.
  const cases: Array<[string, bigint, bigint, CoverageDecision['kind']]> = [
    ['under allowance executes', 50n, 999n, 'execute'],
    ['exactly at allowance executes (inclusive boundary)', 100n, 999n, 'execute'],
    ['one over allowance queues', 101n, 999n, 'queue'],
    ['far over allowance queues', 1_000_000n, 999n, 'queue'],
    ['zero remaining + positive amount queues', 1n, 999n, 'queue'],
  ]
  it.each(cases)('%s', (_label, amount, delegateBalance, expected) => {
    const remaining = _label.startsWith('zero remaining') ? 0n : 100n
    const d = decideCoverage('allowance-only', { amount, remaining, delegateBalance })
    expect(d.kind).toBe(expected)
  })

  it('never returns insufficient regardless of balance', () => {
    for (const balance of [0n, 50n, 10_000n]) {
      const d = decideCoverage('allowance-only', { amount: 1_000n, remaining: 100n, delegateBalance: balance })
      expect(d.kind).not.toBe('insufficient')
    }
  })

  it('ignores delegateBalance entirely (omitted vs huge → same decision)', () => {
    const omitted = decideCoverage('allowance-only', { amount: 150n, remaining: 100n })
    const huge = decideCoverage('allowance-only', { amount: 150n, remaining: 100n, delegateBalance: 10_000n })
    expect(omitted).toEqual(huge)
    expect(omitted.kind).toBe('queue')
  })
})

describe('decideCoverage — balance-aware (x402)', () => {
  // remaining = 100, delegateBalance = 40 ⇒ totalCoverage = 140.
  const remaining = 100n
  const delegateBalance = 40n

  it('under allowance executes (balance does not matter when within allowance)', () => {
    expect(decideCoverage('balance-aware', { amount: 50n, remaining, delegateBalance }).kind).toBe('execute')
  })

  it('exactly at allowance executes', () => {
    expect(decideCoverage('balance-aware', { amount: 100n, remaining, delegateBalance }).kind).toBe('execute')
  })

  it('over allowance but covered by balance queues (the hot-wallet fall-through)', () => {
    expect(decideCoverage('balance-aware', { amount: 120n, remaining, delegateBalance }).kind).toBe('queue')
  })

  it('exactly at total coverage queues (inclusive boundary, not insufficient)', () => {
    expect(decideCoverage('balance-aware', { amount: 140n, remaining, delegateBalance }).kind).toBe('queue')
  })

  it('one beyond total coverage is insufficient with exact shortfall + coverage', () => {
    const d = decideCoverage('balance-aware', { amount: 141n, remaining, delegateBalance })
    expect(d).toEqual({ kind: 'insufficient', shortfall: 1n, totalCoverage: 140n })
  })

  it('far beyond total coverage reports the full shortfall', () => {
    const d = decideCoverage('balance-aware', { amount: 1_140n, remaining, delegateBalance })
    expect(d).toEqual({ kind: 'insufficient', shortfall: 1_000n, totalCoverage: 140n })
  })

  it('zero delegate balance: any over-allowance amount is insufficient (no queue path)', () => {
    // With nothing in the delegate, totalCoverage == remaining, so the queue
    // window (remaining < amount <= totalCoverage) is empty. This is exactly
    // x402 behavior when the delegate holds no funds.
    expect(decideCoverage('balance-aware', { amount: 101n, remaining, delegateBalance: 0n }))
      .toEqual({ kind: 'insufficient', shortfall: 1n, totalCoverage: 100n })
    // ...but within allowance still executes.
    expect(decideCoverage('balance-aware', { amount: 100n, remaining, delegateBalance: 0n }).kind).toBe('execute')
  })

  it('omitted delegateBalance defaults to zero', () => {
    const omitted = decideCoverage('balance-aware', { amount: 101n, remaining })
    const explicitZero = decideCoverage('balance-aware', { amount: 101n, remaining, delegateBalance: 0n })
    expect(omitted).toEqual(explicitZero)
  })
})

describe('decideCoverage — cross-strategy contrast', () => {
  it('the same over-allowance-but-balance-covered input queues in both strategies', () => {
    const input = { amount: 120n, remaining: 100n, delegateBalance: 40n }
    expect(decideCoverage('allowance-only', input).kind).toBe('queue')
    expect(decideCoverage('balance-aware', input).kind).toBe('queue')
  })

  it('an amount beyond balance+allowance queues under allowance-only but is insufficient under balance-aware', () => {
    const input = { amount: 200n, remaining: 100n, delegateBalance: 40n }
    expect(decideCoverage('allowance-only', input).kind).toBe('queue')
    expect(decideCoverage('balance-aware', input).kind).toBe('insufficient')
  })
})
