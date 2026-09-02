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
 * `allowance_amount` carries TWO wire shapes under one field name (#2295, and
 * see the schema pair `allowanceAtomicAmount` / `allowanceHumanAmount` in the
 * backend's `openapi/spec.ts`). `AgentConnectionAllowance` — the connect-setup
 * budget request — is an ATOMIC bigint string (`"5000000000000000000"` for
 * 5 ETH at 18 decimals). `AgentAllowance` on `Agent.allowances`, which is what
 * `GET /agents`, `GET /agents/{id}`, `PUT /agents/{id}` and `/dashboard`
 * return, is the HUMAN-DECIMAL delegation projection (`"5.00"`). (There is no
 * `PATCH /agents/{id}` — this comment named one that has never existed, the
 * same stale row #2392 corrected in the backend's own copies of this list.)
 *
 * This helper takes both on purpose: it is the DISPLAY path, and both shapes
 * render to the same string. The atomic path divides by the token's decimals;
 * the decimal path re-trims an already-scaled value. That tolerance is why
 * every display caller must route through here rather than reaching for
 * `BigInt()` — the exception-as-type-test that produced #2283.
 *
 * It is NOT an arithmetic path. A caller that needs to COMPARE a budget
 * against a price wants {@link humanAmountToAtomic}, which knows which shape
 * it is given instead of inferring one.
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
 * Scale a HUMAN-DECIMAL allowance amount into atomic units, for callers that
 * need to do arithmetic on a budget rather than render it (#2295).
 *
 * ── Why this takes a shape rather than detecting one ─────────────────────────
 *
 * The two shapes are not distinguishable at runtime, and #2408 does not change
 * that — read what it did change carefully, because the two are easy to
 * conflate.
 *
 * What #2408 changed is the CONTRACT: because `formatTokenValue` is the sole
 * emitter of the human shape and returns only `'0'` or
 * `<integer>.<2–6 fraction digits>`, the `allowanceHumanAmount` pattern is now
 * `^(0|[0-9]+\.[0-9]{2,6})$` and a backend response carrying an atomic value in
 * a human field fails the spec round trip. That is a guard on the SERVER's
 * emitters, checked in the backend's own tests.
 *
 * What it does NOT change is this helper's rule. A value arriving here is a
 * string, not a schema: `'0'` is legal and identical in both shapes, and the
 * narrowness of the produced set is a fact about one emitter rather than a
 * property the string carries — so a helper that inferred the shape from the
 * text would be trusting a server-side invariant it cannot see, which is the
 * same class of mistake as #2283's `BigInt`-throw sniff, just better
 * disguised. This comment used to say `'250'` was "a legal value in both",
 * which the tightened schema makes false; the conclusion it supported is
 * unchanged and stated on its own terms above.
 *
 * So the caller states which shape it holds; the OpenAPI schema
 * (`allowanceHumanAmount` vs `allowanceAtomicAmount`) is what tells the caller
 * which one that is. An atomic value needs no helper at all — it is already
 * `BigInt(value)`.
 *
 * Returns `null` for anything that is not a plain decimal number, rather than
 * throwing: callers here are rendering a badge, and an unparseable budget
 * means "cannot answer", never "no budget". Scientific notation is rejected
 * for the same reason `formatAllowanceAmount` rejects it. Excess precision
 * beyond the token's decimals truncates, which is the conservative direction
 * for a "can this budget cover the price" test.
 */
export function humanAmountToAtomic(amount: string, decimals: number): bigint | null {
  const match = amount.trim().match(/^(-)?(\d+)(?:\.(\d+))?$/)
  if (!match) return null
  const fraction = (match[3] ?? '').slice(0, decimals).padEnd(decimals, '0')
  const magnitude = BigInt(`${match[2]}${fraction}` || '0')
  return match[1] ? -magnitude : magnitude
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
