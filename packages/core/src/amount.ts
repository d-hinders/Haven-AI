/**
 * Pure atomic<->decimal token amount conversion (#994, epic #980 M2).
 *
 * `ethers.formatUnits`/`parseUnits` and `viem`'s equivalents are the two
 * chain SDKs' takes on the SAME deterministic string<->bigint conversion —
 * no chain I/O involved. #994's port (`packages/backend/src/domain/chain-client.ts`)
 * deliberately does NOT cover this: routing it through a `ChainClient`
 * instance per rail would suggest ethers and viem disagree on ordinary
 * decimal math, which they don't for the domain this codebase uses (see the
 * differential characterization below). What actually differs at the edges
 * is exactly the kind of subtle bug a reimplementation risks introducing —
 * which is why this file exists as ONE definition instead of two
 * (`ethers-client.ts` calling `ethers.formatUnits`, `viem-client.ts` calling
 * viem's `formatUnits`) that could silently drift apart.
 *
 * Behaviorally byte-identical to `ethers` v6's `formatUnits`/`parseUnits`
 * for the domain this codebase needs (non-negative and negative integer
 * atomic amounts, arbitrary decimals) — verified against
 * `packages/backend/src/routes/__tests__/amount-formatting.characterization.test.ts`,
 * which pins the exact literal output for every token in `CHAIN_REGISTRY`.
 *
 * Reimplemented here — NOT delegating to `ethers` or `viem` at runtime —
 * because `@haven_ai/core` must stay pure (`core-stays-pure`, zero
 * baseline): it is shared by the Node backend and the browser frontend, and
 * a payment-amount formatter is exactly the kind of code that has no
 * business depending on either chain SDK.
 *
 * Intentionally NOT replicated from ethers' `FixedNumber`: the width-512
 * signed-overflow guard (`checkValue` in ethers' `fixednumber.ts`). No
 * atomic amount in this codebase approaches 2^511; a bound that large is
 * unreachable in practice for a real token balance and adding it would be
 * speculative complexity, not correctness.
 */

const DECIMAL_STRING_RE = /^(-?)([0-9]*)\.?([0-9]*)$/

/**
 * Format an atomic bigint amount as a human decimal string, e.g.
 * `formatTokenAmount(1_000_000n, 6) === '1.0'`.
 *
 * Trailing zeros in the fraction are trimmed but at least one fractional
 * digit is always kept (`'1.0'`, never `'1'`) — matching ethers' behavior —
 * EXCEPT when `decimals` is 0, where no decimal point is printed at all.
 */
export function formatTokenAmount(value: bigint, decimals: number): string {
  let negative = ''
  let magnitude = value
  if (magnitude < 0n) {
    negative = '-'
    magnitude = -magnitude
  }

  let digits = magnitude.toString()
  if (decimals === 0) return negative + digits

  // Pad out to at least one whole-part digit plus `decimals` fractional digits.
  while (digits.length <= decimals) {
    digits = '0' + digits
  }

  const splitIndex = digits.length - decimals
  let whole = digits.slice(0, splitIndex)
  let fraction = digits.slice(splitIndex)

  while (whole.length > 1 && whole[0] === '0') {
    whole = whole.slice(1)
  }
  while (fraction.length > 1 && fraction[fraction.length - 1] === '0') {
    fraction = fraction.slice(0, -1)
  }

  return `${negative}${whole}.${fraction}`
}

/**
 * Parse a human decimal string into an atomic bigint amount, e.g.
 * `parseTokenAmount('1.0', 6) === 1_000_000n`.
 *
 * Throws on: no digits at all, more fractional digits than `decimals`
 * supports (unless the excess digits are all zero — `'1.0000000'` at 6
 * decimals is fine, it just has redundant precision), scientific notation,
 * a leading `+`, underscores, or surrounding whitespace — matching ethers'
 * `FixedNumber.fromString` accept/reject boundary exactly.
 */
export function parseTokenAmount(value: string, decimals: number): bigint {
  const match = value.match(DECIMAL_STRING_RE)
  if (!match || match[2].length + match[3].length === 0) {
    throw new Error(`invalid decimal amount string: ${value}`)
  }

  const sign = match[1]
  const whole = match[2] || '0'
  let fraction = match[3] || ''

  while (fraction.length < decimals) {
    fraction += '0'
  }

  const excess = fraction.slice(decimals)
  if (!/^0*$/.test(excess)) {
    throw new Error(`too many decimals for amount: ${value}`)
  }

  fraction = fraction.slice(0, decimals)
  return BigInt(sign + whole + fraction)
}
