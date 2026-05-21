import { getChainConfig } from './chains'

interface FormatAllowanceAmountOptions {
  symbol?: string | null
  minimumFractionDigits?: number
  maximumFractionDigits?: number
}

function normalizeTokenSymbol(symbol: string | null | undefined): string {
  return symbol?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') ?? ''
}

function defaultFractionDigits(symbol: string | null | undefined): number | undefined {
  const normalized = normalizeTokenSymbol(symbol)
  if (normalized === 'ETH') return 4
  if (normalized === 'USDC' || normalized === 'USDCE' || normalized === 'EURE' || normalized === 'XDAI') {
    return 2
  }
  return undefined
}

function defaultTokenUnitDecimals(symbol: string | null | undefined): number | undefined {
  const normalized = normalizeTokenSymbol(symbol)
  if (normalized === 'USDC' || normalized === 'USDCE') return 6
  if (normalized === 'ETH' || normalized === 'EURE' || normalized === 'XDAI') return 18
  return undefined
}

function formatDecimalParts({
  negative,
  whole,
  fraction,
  maxFractionDigits,
  minFractionDigits,
}: {
  negative: boolean
  whole: string
  fraction: string
  maxFractionDigits: number
  minFractionDigits?: number
}): string {
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0'
  let fractionText = fraction.slice(0, maxFractionDigits).replace(/0+$/, '')

  if (minFractionDigits != null && fractionText.length < minFractionDigits) {
    fractionText = fractionText.padEnd(minFractionDigits, '0')
  }

  const body = fractionText ? `${normalizedWhole}.${fractionText}` : normalizedWhole
  return negative ? `-${body}` : body
}

/**
 * Format an allowance amount for display.
 *
 * The backend stores `allowance_amount` as a raw on-chain bigint string
 * (e.g. `"5000000000000000000"` for 5 ETH with 18 decimals). This helper
 * divides by the token's decimals and trims to a humane display value.
 *
 * Stablecoins default to 2 decimal places and ETH defaults to 4, but
 * non-zero smaller amounts keep the extra precision needed to avoid
 * displaying real money as zero.
 *
 * Defensive against shape drift — if a caller ever hands us an
 * already-decimal string like `"5.000000"`, we fall back to parsing as
 * a decimal string and applying the same trim rules.
 */
export function formatAllowanceAmount(
  amount: string,
  decimals: number,
  options: FormatAllowanceAmountOptions = {},
): string {
  const minFractionDigits = options.minimumFractionDigits ?? defaultFractionDigits(options.symbol)
  const maxFractionDigits = Math.max(
    minFractionDigits ?? 0,
    options.maximumFractionDigits ?? (options.symbol ? decimals : Math.min(decimals, 4)),
  )

  // Primary path: raw on-chain bigint string.
  try {
    const raw = BigInt(amount)
    const negative = raw < 0n
    const absRaw = negative ? -raw : raw
    const divisor = 10n ** BigInt(decimals)
    const whole = absRaw / divisor
    const fraction = absRaw % divisor
    return formatDecimalParts({
      negative,
      whole: whole.toString(),
      fraction: fraction.toString().padStart(decimals, '0'),
      minFractionDigits,
      maxFractionDigits,
    })
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

  const match = amount.match(/^(-)?(\d+)(?:\.(\d+))?$/)
  if (!match) return amount

  return formatDecimalParts({
    negative: Boolean(match[1]),
    whole: match[2],
    fraction: match[3] ?? '',
    minFractionDigits,
    maxFractionDigits,
  })
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
    return defaultTokenUnitDecimals(symbol)
  }
  const normalizedSymbol = normalizeTokenSymbol(symbol)
  const token = Object.values(chain.tokens).find((t) => normalizeTokenSymbol(t.symbol) === normalizedSymbol)
  return token?.decimals ?? defaultTokenUnitDecimals(symbol)
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
  const decimals = chainId != null ? getTokenDecimals(chainId, symbol) : defaultTokenUnitDecimals(symbol)
  return formatAllowanceAmount(amount, decimals ?? 18, { symbol })
}
