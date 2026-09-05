/**
 * Human token amounts → atomic units, without a dependency (#2527).
 *
 * ## Why this exists rather than `parseUnits`
 *
 * The dashboard modal converts with viem's `parseUnits` before it POSTs
 * (`useAgentConnectionSetup.ts`), and this CLI has to produce the same string
 * for the same input. It cannot call the same function: `@haven_ai/cli` ships
 * with **zero runtime dependencies** — asserted by a test, because `npx
 * @haven_ai/cli` is the path an agent uses and viem's tree is ~94 MB — so this
 * is the arithmetic done in strings over Node builtins.
 *
 * ## The two shapes, and why this direction is the dangerous one
 *
 * `allowance_amount` is ATOMIC on the way in and HUMAN-DECIMAL on the way back
 * (#2295). One name, two shapes. Nothing here sniffs which it is holding: the
 * caller says, and this function only ever converts human → atomic. A number
 * that is wrong by 10^6 is a budget that is wrong by a factor of a million.
 *
 * ## Excess precision is REFUSED, never rounded
 *
 * `parseUnits` ROUNDS the excess rather than dropping it, which is worse than
 * it sounds: measured against viem, `parseUnits('1.9999999', 6)` is `2000000n`
 * — **two whole tokens** — and `parseUnits('0.0000005', 6)` is `1n`, a budget
 * conjured out of a value below the token's precision. An earlier version of
 * this comment said it truncates to `1999999n`; that was wrong, and the truth
 * is the stronger argument for refusing (haven-reviewer, #2527).
 *
 * For a field a person typed and is about to authorise, quietly changing the
 * number is worse than declining it, so this mirrors the modal's own
 * `validateMoneyInput`, which refuses before it ever reaches `parseUnits`. The
 * rule is the same on both surfaces on purpose: a budget the dashboard would
 * not accept must not become acceptable by being typed into a terminal.
 */

export interface AmountResult {
  ok: true
  /** The normalised human string, e.g. `.5` → `0.5`. */
  human: string
  /** Atomic units as a decimal string — what the wire wants. */
  atomic: string
}

export interface AmountRefusal {
  ok: false
  message: string
}

function decimalLabel(decimals: number): string {
  return decimals === 1 ? '1 decimal place' : `${decimals} decimal places`
}

/**
 * Convert a human amount to atomic units for a token with `decimals`.
 *
 * Refuses rather than guesses: anything that is not a plain non-negative
 * decimal, anything that is zero, and anything carrying more fraction digits
 * than the token can represent.
 */
export function parseTokenAmount(
  input: string,
  decimals: number,
  tokenSymbol?: string,
): AmountResult | AmountRefusal {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return { ok: false, message: `Unusable token decimals: ${String(decimals)}` }
  }

  // `.5` → `0.5`, matching the modal's `normalizeMoneyInput` so the two
  // surfaces accept the same set of strings.
  const trimmed = String(input ?? '').trim()
  const human = trimmed.startsWith('.') ? `0${trimmed}` : trimmed
  const label = tokenSymbol ? ` ${tokenSymbol}` : ''

  if (human === '') return { ok: false, message: 'Enter an amount greater than 0' }
  // No sign, no exponent, no separators. `1e6` and `1_000` are the shapes most
  // likely to be meant well and read wrong, so they are refused by omission.
  if (!/^\d+(?:\.\d+)?$/.test(human)) {
    return { ok: false, message: `Enter a valid${label} amount — digits, with an optional decimal point` }
  }

  const [whole, fraction = ''] = human.split('.')
  if (fraction.length > decimals) {
    return {
      ok: false,
      message: `${tokenSymbol ?? 'This token'} supports up to ${decimalLabel(decimals)}`,
    }
  }

  // Right-pad the fraction to the token's precision and concatenate: the whole
  // conversion, with no float anywhere near it. BigInt then strips leading
  // zeros, so `0.5` at 6 decimals is `500000` rather than `0500000`.
  const atomic = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`)
  if (atomic === 0n) return { ok: false, message: 'Enter an amount greater than 0' }

  return { ok: true, human, atomic: atomic.toString() }
}
