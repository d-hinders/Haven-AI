/**
 * Token configuration — delegates to the chain registry.
 *
 * The per-chain token data lives in chains.ts. This module provides
 * chain-aware lookups and the formatTokenValue utility.
 */
import { getChain, type TokenConfig } from './chains.js'

export type { TokenConfig }

/** Get the supported tokens for a specific chain */
export function getSupportedTokens(chainId: number): Record<string, TokenConfig> {
  return getChain(chainId).tokens
}

/** Reverse lookup: contract address → token config for a given chain */
export function getTokenByAddress(chainId: number, address: string): TokenConfig | undefined {
  return getChain(chainId).tokenByAddress[address.toLowerCase()]
}

/** Get the native token config for a chain */
export function getNativeToken(chainId: number): TokenConfig {
  const chain = getChain(chainId)
  const native = Object.values(chain.tokens).find((t) => t.address === null)
  if (!native) throw new Error(`No native token configured for chain ${chainId}`)
  return native
}

// Legacy exports for Gnosis-only callers (will be removed as routes are updated)
export const SUPPORTED_TOKENS = getSupportedTokens(100)
export const TOKEN_BY_ADDRESS: Record<string, TokenConfig> = getChain(100).tokenByAddress

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
