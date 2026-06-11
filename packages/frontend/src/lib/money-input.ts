import { parseUnits } from 'viem'

export type MoneyInputResult =
  | {
      ok: true
      amount: string
      raw: bigint
    }
  | {
      ok: false
      message: string
    }

interface MoneyInputOptions {
  tokenSymbol?: string
  allowZero?: boolean
}

function decimalLabel(decimals: number): string {
  return decimals === 1 ? '1 decimal place' : `${decimals} decimal places`
}

export function normalizeMoneyInput(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('.')) return `0${trimmed}`
  return trimmed
}

/**
 * True while the value is an in-progress state the user is still typing
 * ("", ".", "0", "12.", "0.0"). Used to suppress live error styling —
 * these values are not submittable, but they are not mistakes either.
 */
export function isIncompleteMoneyInput(input: string): boolean {
  const trimmed = input.trim()
  return (
    trimmed === '' ||
    trimmed === '.' ||
    /^\d+\.$/.test(trimmed) ||
    /^0+(\.0*)?$/.test(trimmed)
  )
}

export function validateMoneyInput(
  input: string,
  decimals: number,
  options: MoneyInputOptions = {},
): MoneyInputResult {
  const amount = normalizeMoneyInput(input)
  const tokenLabel = options.tokenSymbol ? ` ${options.tokenSymbol}` : ''

  if (!amount) {
    return { ok: false, message: 'Enter an amount greater than 0' }
  }

  if (!/^\d+(?:\.\d+)?$/.test(amount)) {
    return { ok: false, message: `Enter a valid${tokenLabel} amount` }
  }

  const [, fractional = ''] = amount.split('.')
  if (fractional.length > decimals) {
    return {
      ok: false,
      message: `${options.tokenSymbol ?? 'This token'} supports up to ${decimalLabel(decimals)}`,
    }
  }

  try {
    const raw = parseUnits(amount, decimals)
    if (!options.allowZero && raw <= 0n) {
      return { ok: false, message: 'Enter an amount greater than 0' }
    }
    return { ok: true, amount, raw }
  } catch {
    return { ok: false, message: `Enter a valid${tokenLabel} amount` }
  }
}

export function rawAmountFromBalance(balance: string): bigint | null {
  try {
    return BigInt(balance)
  } catch {
    return null
  }
}

export function exceedsRawBalance(amountRaw: bigint, balanceRaw: string): boolean {
  const rawBalance = rawAmountFromBalance(balanceRaw)
  return rawBalance !== null && amountRaw > rawBalance
}
