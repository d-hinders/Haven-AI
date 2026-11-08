/**
 * USDC arrival amounts (#4704, lifted here by #4705 so the dashboard's funds
 * toast and Receive's arrived state say the same number the same way).
 */

/**
 * The arrived amount (#4704 toast, #4705 Receive): the account's USDC balance
 * in whole tokens, at least two decimals ("25.00") and up to six, so a small
 * testnet deposit reads "0.0005" rather than "0.00". `null` when the balance
 * or its decimals are unknown or malformed — then no toast, never a guess.
 */
export function formatUsdcArrival(atomic: string | null, decimals: number | null): string | null {
  if (atomic === null || decimals === null || atomic.trim() === '') return null
  // A malformed decimals value is unknown too — and must not throw inside the
  // effect that calls this (BigInt of a negative or fractional exponent).
  if (!Number.isInteger(decimals) || decimals < 0) return null
  let value: bigint
  try {
    value = BigInt(atomic)
  } catch {
    return null
  }
  if (value <= 0n) return null
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  const shown = fraction.length >= 2 ? fraction.slice(0, 6) : fraction.padEnd(2, '0')
  return `${whole.toLocaleString('en-US')}.${shown}`
}
