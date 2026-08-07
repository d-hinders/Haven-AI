/**
 * Amount-formatting characterization suite (#994, epic #980 M2).
 *
 * MONEY-PATH. Pins the EXACT string/bigint output of the amount conversion
 * routes/x402.ts, routes/payments.ts and routes/machine-payments.ts call
 * today — `ethers.formatUnits` / `ethers.parseUnits` — for every token in
 * the shared registry (`@haven_ai/core`'s `CHAIN_REGISTRY`), before the
 * ChainClient port (#994) substitutes anything.
 *
 * Per the issue's real risk: "formatUnits/parseUnits decimal handling
 * differs subtly between ethers and viem at the edges, and these values are
 * payment amounts." This suite is the oracle a substitution must match
 * byte-for-byte. The expected values below are HARDCODED LITERALS, not
 * computed via any formatter under test (including ethers itself) — a
 * broken formatter (or a broken substitute) must not be able to satisfy its
 * own assertions.
 *
 * #985's recorded lesson: commit this suite BEFORE the substitution commit,
 * so the history proves the tests existed first (this file IS that commit).
 *
 * When #994's substitution lands, this file gains a second `describe` block
 * that runs the identical pinned literals against `@haven_ai/core`'s new
 * `formatTokenAmount` / `parseTokenAmount` — same expectations, different
 * subject — so "characterization passes byte-identical" is a property of
 * this one file, not an assertion made in a PR description.
 */
import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { CHAIN_REGISTRY } from '@haven_ai/core'

// Every distinct decimals value present in the registry today. If a future
// token introduces a new decimals count, this suite must grow with it —
// hence the assertion in the "registry coverage" block below.
const MAX_UINT256 = 2n ** 256n - 1n

interface FormatCase {
  label: string
  atomic: bigint
  expected: string
}

interface ParseCase {
  label: string
  human: string
  expected: bigint
}

// Hardcoded oracle, keyed by decimals. Captured from ethers v6.16.0's real
// output (see PR description for the capture command) — NOT derived from
// any formatter this suite exercises.
const FORMAT_ORACLE: Record<number, FormatCase[]> = {
  6: [
    { label: 'zero', atomic: 0n, expected: '0.0' },
    { label: 'sub-unit dust (1 atomic unit)', atomic: 1n, expected: '0.000001' },
    { label: 'just below the decimal boundary', atomic: 999_999n, expected: '0.999999' },
    { label: 'at the decimal boundary (1 whole token)', atomic: 1_000_000n, expected: '1.0' },
    {
      label: 'large value near uint256 overflow',
      atomic: MAX_UINT256,
      expected: '115792089237316195423570985008687907853269984665640564039457584007913129.639935',
    },
  ],
  18: [
    { label: 'zero', atomic: 0n, expected: '0.0' },
    { label: 'sub-unit dust (1 atomic unit)', atomic: 1n, expected: '0.000000000000000001' },
    {
      label: 'just below the decimal boundary',
      atomic: 999_999_999_999_999_999n,
      expected: '0.999999999999999999',
    },
    { label: 'at the decimal boundary (1 whole token)', atomic: 1_000_000_000_000_000_000n, expected: '1.0' },
    {
      label: 'large value near uint256 overflow',
      atomic: MAX_UINT256,
      expected: '115792089237316195423570985008687907853269984665640564039457.584007913129639935',
    },
  ],
}

const PARSE_ORACLE: Record<number, ParseCase[]> = {
  6: [
    { label: 'zero', human: '0', expected: 0n },
    { label: 'sub-unit dust', human: '0.000001', expected: 1n },
    { label: 'at the decimal boundary', human: '1.0', expected: 1_000_000n },
    {
      label: 'large value near uint256 overflow',
      human: '115792089237316195423570985008687907853269984665640564039457584007913129.639935',
      expected: MAX_UINT256,
    },
  ],
  18: [
    { label: 'zero', human: '0', expected: 0n },
    { label: 'sub-unit dust', human: '0.000000000000000001', expected: 1n },
    { label: 'at the decimal boundary', human: '1.0', expected: 1_000_000_000_000_000_000n },
    {
      label: 'large value near uint256 overflow',
      human: '115792089237316195423570985008687907853269984665640564039457.584007913129639935',
      expected: MAX_UINT256,
    },
  ],
}

const registryTokens = Object.values(CHAIN_REGISTRY).flatMap((chain) =>
  chain.tokens.map((token) => ({ chainId: chain.chainId, chainName: chain.name, ...token })),
)

describe('amount-formatting characterization (pre-#994 baseline: ethers directly)', () => {
  it('the registry only uses decimals this suite has an oracle for', () => {
    // Fails loudly — not silently skips — if a token with a new decimals
    // count is added without extending FORMAT_ORACLE/PARSE_ORACLE.
    for (const token of registryTokens) {
      expect(Object.keys(FORMAT_ORACLE).map(Number)).toContain(token.decimals)
      expect(Object.keys(PARSE_ORACLE).map(Number)).toContain(token.decimals)
    }
  })

  for (const token of registryTokens) {
    describe(`${token.chainName} — ${token.symbol} (${token.decimals} decimals)`, () => {
      for (const { label, atomic, expected } of FORMAT_ORACLE[token.decimals]) {
        it(`formatUnits: ${label}`, () => {
          expect(ethers.formatUnits(atomic, token.decimals)).toBe(expected)
        })
      }

      for (const { label, human, expected } of PARSE_ORACLE[token.decimals]) {
        it(`parseUnits: ${label}`, () => {
          expect(ethers.parseUnits(human, token.decimals)).toBe(expected)
        })
      }

      it('format/parse round-trips at the decimal boundary', () => {
        const oneWhole = 10n ** BigInt(token.decimals)
        expect(ethers.parseUnits(ethers.formatUnits(oneWhole, token.decimals), token.decimals)).toBe(oneWhole)
      })
    })
  }

  it('rejects a value with more fractional digits than the token supports', () => {
    // Every registry decimals count today is >= 6, so 7 fractional digits
    // overflows all of them — this pins the reject boundary, not just the
    // accept path.
    for (const token of registryTokens) {
      const tooPrecise = `0.${'0'.repeat(token.decimals)}1`
      expect(() => ethers.parseUnits(tooPrecise, token.decimals)).toThrow()
    }
  })
})
