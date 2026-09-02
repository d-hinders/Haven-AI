import { parseTokenAmount } from '@haven_ai/core'

export type SweepBalanceInput = {
  usdc_atomic: string
  sweep_min_usdc: string
}

export type UsdcSweepStatus = 'none' | 'recoverable' | 'below_minimum' | 'unknown'

/**
 * Keep recovery UI aligned with the backend's configured sweep floor. Invalid
 * wire values fail closed: a malformed balance must never produce a recovery
 * action that the sweep endpoint will reject.
 */
export function usdcSweepStatus(balance: SweepBalanceInput): UsdcSweepStatus {
  try {
    const amount = BigInt(balance.usdc_atomic)
    const minimum = parseTokenAmount(balance.sweep_min_usdc, 6)
    if (amount === 0n) return 'none'
    return amount >= minimum ? 'recoverable' : 'below_minimum'
  } catch {
    return 'unknown'
  }
}
