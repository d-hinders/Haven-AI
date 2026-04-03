export interface TokenConfig {
  symbol: string
  decimals: number
  address: string | null // null = native token
}

export const SUPPORTED_TOKENS: Record<string, TokenConfig> = {
  XDAI: { symbol: 'xDAI', decimals: 18, address: null },
  EURE: {
    symbol: 'EURe',
    decimals: 18,
    address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E',
  },
  USDCE: {
    symbol: 'USDC.e',
    decimals: 6,
    address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0',
  },
}

// Reverse lookup: contract address → token config
export const TOKEN_BY_ADDRESS: Record<string, TokenConfig> = {}
for (const token of Object.values(SUPPORTED_TOKENS)) {
  if (token.address) {
    TOKEN_BY_ADDRESS[token.address.toLowerCase()] = token
  }
}

export function formatTokenValue(
  rawValue: string,
  decimals: number,
): string {
  if (!rawValue || rawValue === '0') return '0'

  const padded = rawValue.padStart(decimals + 1, '0')
  const intPart = padded.slice(0, padded.length - decimals) || '0'
  const fracPart = padded.slice(padded.length - decimals)

  // Trim trailing zeros but keep at least 2 decimal places
  const trimmed = fracPart.replace(/0+$/, '').padEnd(2, '0')
  // Cap at 6 decimal places
  const capped = trimmed.slice(0, 6)

  return `${intPart}.${capped}`
}
