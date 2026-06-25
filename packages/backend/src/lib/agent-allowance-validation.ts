import { isAddress } from './address.js'

export interface AgentAllowanceInput {
  token_address?: unknown
  token_symbol?: unknown
  allowance_amount?: unknown
  reset_period_min?: unknown
}

export interface NormalizedAgentAllowance {
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

const MAX_UINT96 = (1n << 96n) - 1n
const MAX_UINT16 = 65535
const MAX_AMOUNT_DIGITS = 78

export function normalizeAgentAllowance(
  input: AgentAllowanceInput,
): ValidationResult<NormalizedAgentAllowance> {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Allowance is required' }
  }

  const tokenAddress = normalizeAgentAllowanceTokenAddress(input.token_address)
  if (!tokenAddress.ok) return tokenAddress

  const tokenSymbol = normalizeTokenSymbol(input.token_symbol)
  if (!tokenSymbol.ok) return tokenSymbol

  const allowanceAmount = normalizeAllowanceAmount(input.allowance_amount)
  if (!allowanceAmount.ok) return allowanceAmount

  const resetPeriodMin = normalizeResetPeriod(input.reset_period_min)
  if (!resetPeriodMin.ok) return resetPeriodMin

  return {
    ok: true,
    value: {
      token_address: tokenAddress.value,
      token_symbol: tokenSymbol.value,
      allowance_amount: allowanceAmount.value,
      reset_period_min: resetPeriodMin.value,
    },
  }
}

export function normalizeAgentAllowances(input: unknown): ValidationResult<NormalizedAgentAllowance[]> {
  if (input === undefined || input === null) {
    return { ok: true, value: [] }
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: 'Allowances must be an array' }
  }

  const allowances: NormalizedAgentAllowance[] = []
  const tokenAddresses = new Set<string>()
  for (const allowance of input) {
    const normalized = normalizeAgentAllowance(allowance as AgentAllowanceInput)
    if (!normalized.ok) return normalized
    if (tokenAddresses.has(normalized.value.token_address)) {
      return { ok: false, error: 'Duplicate token allowances are not allowed' }
    }
    tokenAddresses.add(normalized.value.token_address)
    allowances.push(normalized.value)
  }
  return { ok: true, value: allowances }
}

export function normalizeAgentAllowanceTokenAddress(input: unknown): ValidationResult<string> {
  if (!isAddress(input)) {
    return { ok: false, error: 'Valid token address is required' }
  }
  return { ok: true, value: input.toLowerCase() }
}

function normalizeTokenSymbol(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Token symbol is required' }
  }
  const tokenSymbol = input.trim()
  if (!tokenSymbol) {
    return { ok: false, error: 'Token symbol is required' }
  }
  if (tokenSymbol.length > 20) {
    return { ok: false, error: 'Token symbol must be 20 characters or fewer' }
  }
  return { ok: true, value: tokenSymbol }
}

function normalizeAllowanceAmount(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string' || !/^\d+$/.test(input) || input.length > MAX_AMOUNT_DIGITS) {
    return { ok: false, error: 'Allowance amount must be a positive decimal atomic amount' }
  }

  const amount = BigInt(input)
  if (amount <= 0n) {
    return { ok: false, error: 'Allowance amount must be a positive decimal atomic amount' }
  }
  if (amount > MAX_UINT96) {
    return { ok: false, error: 'Allowance amount exceeds uint96 AllowanceModule limit' }
  }
  return { ok: true, value: amount.toString() }
}

function normalizeResetPeriod(input: unknown): ValidationResult<number> {
  if (
    typeof input !== 'number' ||
    !Number.isInteger(input) ||
    input < 0 ||
    input > MAX_UINT16
  ) {
    return { ok: false, error: 'Reset period must be an integer from 0 to 65535 minutes' }
  }
  return { ok: true, value: input }
}
