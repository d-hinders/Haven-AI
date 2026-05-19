import { getChainConfig } from './chains'

/**
 * Format an allowance amount for display.
 *
 * The backend stores `allowance_amount` as a raw on-chain bigint string
 * (e.g. `"5000000000000000000"` for 5 ETH with 18 decimals). This helper
 * divides by the token's decimals and trims to a humane display value:
 * up to 4 fractional digits, trailing zeros stripped.
 *
 * Defensive against shape drift — if a caller ever hands us an
 * already-decimal string like `"5.000000"`, we fall back to parsing as
 * a number and applying the same trim rules so the display never
 * regresses to "way too many zeros" on the page.
 */
export function formatAllowanceAmount(amount: string, decimals: number): string {
  // Primary path: raw on-chain bigint string.
  try {
    const raw = BigInt(amount)
    const negative = raw < 0n
    const absRaw = negative ? -raw : raw
    const divisor = 10n ** BigInt(decimals)
    const whole = absRaw / divisor
    const fraction = absRaw % divisor
    const fractionText = fraction
      .toString()
      .padStart(decimals, '0')
      .slice(0, 4)
      .replace(/0+$/, '')

    const body = fractionText ? `${whole}.${fractionText}` : whole.toString()
    return negative ? `-${body}` : body
  } catch {
    // Fallthrough — `amount` likely already has a decimal point.
  }

  // Defensive path: already-decimal string. Reject scientific notation —
  // `Number('1e20').toFixed(4)` returns a 25-character integer that
  // defeats the whole point of formatting, and once values approach
  // Number.MAX_SAFE_INTEGER `toFixed` silently loses precision. Pass
  // such strings through unchanged so the caller sees something
  // diagnosable.
  if (/[eE]/.test(amount)) return amount

  const asNumber = Number(amount)
  if (!Number.isFinite(asNumber)) return amount

  const formatted = asNumber.toFixed(4)
  // Strip trailing zeros after the decimal point, then a dangling dot.
  return formatted.replace(/\.?0+$/, '')
}

/**
 * Look up a token's decimals on a chain by symbol. Returns `undefined`
 * if the chain or token is unknown — callers should fall back to 18 in
 * that case (matches the existing convention in AgentDetailClient).
 */
export function getTokenDecimals(chainId: number, symbol: string): number | undefined {
  let chain
  try {
    chain = getChainConfig(chainId)
  } catch {
    return undefined
  }
  const token = Object.values(chain.tokens).find((t) => t.symbol === symbol)
  return token?.decimals
}

/**
 * Convenience wrapper: format an allowance for a token on a given chain,
 * falling back to 18 decimals if the token is unknown.
 */
export function formatAllowanceForToken(
  amount: string,
  chainId: number | null | undefined,
  symbol: string,
): string {
  const decimals = chainId != null ? getTokenDecimals(chainId, symbol) : undefined
  return formatAllowanceAmount(amount, decimals ?? 18)
}
