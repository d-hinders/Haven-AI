/**
 * Multi-chain configuration for the Haven frontend.
 *
 * Single source of truth for per-chain data: contract addresses,
 * tokens, explorer URLs, and Safe TX service URLs.
 */
import type { Address } from 'viem'
import { gnosis, base } from 'viem/chains'

// Re-export viem chain objects for convenience
export { gnosis, base }

// ── Types ─────────────────────────────────────────────────────────

export interface FrontendTokenConfig {
  symbol: string
  decimals: number
  address: Address | null // null = native token
}

export interface FrontendChainConfig {
  chainId: number
  name: string
  shortName: string
  viemChain: typeof gnosis | typeof base
  explorerUrl: string
  safeTxServiceUrl: string
  contracts: {
    safeProxyFactory: Address
    safeSingletonL2: Address
    fallbackHandler: Address
    allowanceModule: Address
    multiSendCallOnly: Address
  }
  passkey: {
    /** P-256 verifier the Safe passkey signer will call. */
    verifier: Address
  }
  tokens: Record<string, FrontendTokenConfig>
}

// ── Gnosis Chain (100) ────────────────────────────────────────────

const GNOSIS_CONFIG: FrontendChainConfig = {
  chainId: 100,
  name: 'Gnosis Chain',
  shortName: 'gnosis',
  viemChain: gnosis,
  explorerUrl: 'https://gnosisscan.io',
  safeTxServiceUrl: 'https://safe-transaction-gnosis-chain.safe.global',
  contracts: {
    safeProxyFactory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
    safeSingletonL2: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E',
    fallbackHandler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
    allowanceModule: '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
  passkey: {
    // TODO: source from safe-modules-deployments once the package exposes the Gnosis FCL verifier.
    verifier: '0x445a0683e494ea0c5af3e83c5159fbe47cf9e765',
  },
  tokens: {
    'xDAI': { symbol: 'xDAI', decimals: 18, address: null },
    'EURe': { symbol: 'EURe', decimals: 18, address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E' },
    'USDC.e': { symbol: 'USDC.e', decimals: 6, address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0' },
  },
}

// ── Base (8453) ───────────────────────────────────────────────────

const BASE_CONFIG: FrontendChainConfig = {
  chainId: 8453,
  name: 'Base',
  shortName: 'base',
  viemChain: base,
  explorerUrl: 'https://basescan.org',
  safeTxServiceUrl: 'https://safe-transaction-base.safe.global',
  contracts: {
    // Base uses EIP-155 variant addresses for Safe v1.3.0
    safeProxyFactory: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC',
    safeSingletonL2: '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
    fallbackHandler: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804',
    // Same CREATE2 addresses on Base
    allowanceModule: '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
  passkey: {
    verifier: '0x0000000000000000000000000000000000000100',
  },
  tokens: {
    'ETH': { symbol: 'ETH', decimals: 18, address: null },
    'USDC': { symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  },
}

// ── Registry ──────────────────────────────────────────────────────

const CHAINS: Record<number, FrontendChainConfig> = {
  100: GNOSIS_CONFIG,
  8453: BASE_CONFIG,
}

export const SUPPORTED_CHAINS = Object.values(CHAINS)
export const SUPPORTED_CHAIN_IDS = Object.keys(CHAINS).map(Number)
export const DEFAULT_CHAIN_ID = 100

export function getChainConfig(chainId: number): FrontendChainConfig {
  const chain = CHAINS[chainId]
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}`)
  }
  return chain
}

export function getExplorerUrl(
  chainId: number,
  type: 'tx' | 'address',
  hash: string,
): string {
  const chain = getChainConfig(chainId)
  return `${chain.explorerUrl}/${type}/${hash}`
}

export function getTokensForChain(chainId: number): Record<string, FrontendTokenConfig> {
  return getChainConfig(chainId).tokens
}
