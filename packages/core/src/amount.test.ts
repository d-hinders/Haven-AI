import { describe, expect, it } from 'vitest'
import { formatTokenAmount, parseTokenAmount } from './amount.js'
import { CHAIN_REGISTRY } from './chains.js'

const MAX_UINT256 = 2n ** 256n - 1n

// Same hardcoded oracle as
// packages/backend/src/routes/__tests__/amount-formatting.characterization.test.ts
// (captured from ethers v6.16.0's real `formatUnits`/`parseUnits` output) —
// duplicated deliberately rather than imported, so this package's tests stay
// self-contained and don't reach into `packages/backend`.
const FORMAT_ORACLE: Record<number, Array<{ label: string; atomic: bigint; expected: string }>> = {
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

const PARSE_ORACLE: Record<number, Array<{ label: string; human: string; expected: bigint }>> = {
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

describe('formatTokenAmount / parseTokenAmount (pure, #994 ChainClient port substitute)', () => {
  for (const token of registryTokens) {
    describe(`${token.chainName} — ${token.symbol} (${token.decimals} decimals)`, () => {
      for (const { label, atomic, expected } of FORMAT_ORACLE[token.decimals]) {
        it(`formatTokenAmount: ${label}`, () => {
          expect(formatTokenAmount(atomic, token.decimals)).toBe(expected)
        })
      }

      for (const { label, human, expected } of PARSE_ORACLE[token.decimals]) {
        it(`parseTokenAmount: ${label}`, () => {
          expect(parseTokenAmount(human, token.decimals)).toBe(expected)
        })
      }
    })
  }

  it('formats a negative amount (shortfall math) with the sign outside the whole part', () => {
    expect(formatTokenAmount(-1_500_000n, 6)).toBe('-1.5')
  })

  it('decimals === 0 prints no decimal point at all', () => {
    expect(formatTokenAmount(1n, 0)).toBe('1')
    expect(formatTokenAmount(0n, 0)).toBe('0')
  })

  it('rejects malformed decimal strings the same way ethers does', () => {
    for (const bad of ['', 'abc', '1.2.3', '+1', '1e5', ' 1', '1 ', '1_000', '0x10', '.']) {
      expect(() => parseTokenAmount(bad, 18)).toThrow()
    }
  })

  it('accepts redundant trailing-zero precision beyond `decimals`', () => {
    expect(parseTokenAmount('1.0000000', 6)).toBe(1_000_000n)
  })

  it('rejects genuine excess precision beyond `decimals`', () => {
    expect(() => parseTokenAmount('0.0000001', 6)).toThrow()
  })

  it('round-trips at the decimal boundary for every registry token', () => {
    for (const token of registryTokens) {
      const oneWhole = 10n ** BigInt(token.decimals)
      expect(parseTokenAmount(formatTokenAmount(oneWhole, token.decimals), token.decimals)).toBe(oneWhole)
    }
  })
})
