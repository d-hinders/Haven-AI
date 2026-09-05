import { describe, expect, it } from 'vitest'
import { parseTokenAmount } from './amount.js'

/**
 * Human → atomic, the conversion the CLI has to get exactly right (#2527).
 *
 * The reference is viem's `parseUnits`, which the dashboard modal uses. This
 * package cannot import it (zero runtime dependencies, asserted in
 * `agent-guidance-text.test.ts`), so the vectors below are the reference
 * written out: each is what `parseUnits(input, decimals).toString()` returns
 * for the same pair.
 *
 * Those expectations were MEASURED, not reasoned about: every vector in the
 * table below, plus the further value asserted at the end of this file, was run
 * through the real `parseUnits` in the frontend workspace where viem is
 * installed — 18 distinct (value, decimals) pairs, all agreeing. Recorded
 * because a hand-written table of expected values is a claim about another
 * library until somebody executes it, and this one decides a budget: wrong by
 * 10^6 is wrong by a factor of a million. Re-run that check if a vector is
 * added or changed.
 *
 * An earlier version of this note said "all twenty", which was the line count
 * of the throwaway parity script (it repeated two pairs) rather than the number
 * of vectors here. haven-doc-reviewer counted the table and found 17. The
 * measurement was real; the number describing it was not, which is the same
 * defect class as an instrument that cannot fail — so the count now names what
 * can be counted from this file.
 */

describe('parseTokenAmount', () => {
  it('converts across the whole 2–6 fraction-digit range the acceptance criteria names', () => {
    const vectors: [string, number, string][] = [
      // [human, decimals, atomic]
      ['1', 6, '1000000'],
      ['25', 6, '25000000'],
      ['0.5', 6, '500000'],
      ['0.05', 6, '50000'],
      ['0.005', 6, '5000'],
      ['0.0005', 6, '500'],
      ['0.00005', 6, '50'],
      ['0.000005', 6, '5'],
      ['1.23', 6, '1230000'],
      ['1.234', 6, '1234000'],
      ['1.2345', 6, '1234500'],
      ['1.23456', 6, '1234560'],
      ['1.234567', 6, '1234567'],
      // A different precision, so nothing here is quietly hard-coded to 6.
      ['1.5', 18, '1500000000000000000'],
      ['0.000000000000000001', 18, '1'],
      ['7', 0, '7'],
      // Bigger than Number.MAX_SAFE_INTEGER once expanded — the reason this is
      // BigInt string arithmetic and not multiplication.
      ['9007199254740993', 6, '9007199254740993000000'],
    ]
    for (const [human, decimals, atomic] of vectors) {
      const result = parseTokenAmount(human, decimals, 'USDC')
      expect(result, `${human} @ ${decimals}`).toEqual({ ok: true, human, atomic })
    }
  })

  it('normalizes a leading dot, exactly as the modal does', () => {
    // `normalizeMoneyInput` in the frontend turns `.5` into `0.5`. The two
    // surfaces must accept the same set of strings, or a budget the dashboard
    // takes is refused in a terminal.
    expect(parseTokenAmount('.5', 6)).toEqual({ ok: true, human: '0.5', atomic: '500000' })
    expect(parseTokenAmount('  25  ', 6)).toEqual({ ok: true, human: '25', atomic: '25000000' })
  })

  it('REFUSES excess precision rather than rounding it away', () => {
    // `parseUnits('1.9999999', 6)` returns 1999999n — it drops the last digit
    // silently. For a number a person is about to authorise, declining beats
    // changing it. The modal refuses first too; this keeps the two in step.
    const result = parseTokenAmount('1.9999999', 6, 'USDC')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/USDC supports up to 6 decimal places/)
  })

  it('refuses zero however it is written', () => {
    for (const zero of ['0', '0.0', '0.000000', '.0', '00']) {
      expect(parseTokenAmount(zero, 6).ok, zero).toBe(false)
    }
  })

  it('refuses the shapes most likely to be meant well and read wrong', () => {
    // Each of these has an obvious intended meaning and no safe one. A silent
    // reading of `1e6` or `1,000` is a budget off by orders of magnitude.
    for (const bad of ['1e6', '1_000', '1,000', '-1', '+1', 'abc', '1.2.3', '0x5', '', '   ', 'Infinity', 'NaN']) {
      expect(parseTokenAmount(bad, 6).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('refuses an unusable decimals value instead of producing a number', () => {
    // A caller that got decimals wrong should not get an amount back at all.
    for (const decimals of [-1, 1.5, Number.NaN, 999]) {
      expect(parseTokenAmount('1', decimals).ok, String(decimals)).toBe(false)
    }
  })

  it('never returns a leading zero or a float artefact', () => {
    // Concatenation before BigInt would give `0500000`; a float would give
    // `1.0000000000000002e+21`. Both are wire-visible.
    const half = parseTokenAmount('0.5', 6)
    expect(half.ok === true && half.atomic).toBe('500000')
    const big = parseTokenAmount('1000000000000000', 6)
    expect(big.ok === true && big.atomic).toBe('1000000000000000000000')
    expect(big.ok === true && big.atomic).not.toMatch(/[.e+]/)
  })
})
