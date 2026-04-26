/**
 * Multi-chain configuration registry.
 *
 * Single source of truth for all per-chain data: RPC, explorer,
 * token configs, contract addresses, and Safe service URLs.
 */
import { config } from '../config.js'

// ── Types ─────────────────────────────────────────────────────────

export interface TokenConfig {
  symbol: string
  decimals: number
  address: string | null // null = native token
  coingeckoId: string
}

export type ExplorerApiProvider = 'etherscan-v2' | 'blockscout-v1' | 'blockscout-v2'

export interface ChainConfig {
  chainId: number
  name: string
  shortName: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  rpcUrl: string
  explorerUrl: string        // e.g. https://gnosisscan.io
  explorerApiUrl: string     // e.g. https://api.etherscan.io/v2/api
  explorerApiKey: string     // empty allowed for Blockscout
  explorerApiProvider: ExplorerApiProvider
  safeTxServiceUrl: string   // e.g. https://safe-transaction-gnosis-chain.safe.global
  contracts: {
    safeProxyFactory: string
    safeSingletonL2: string
    fallbackHandler: string
    allowanceModule: string
    multiSendCallOnly: string
  }
  tokens: Record<string, TokenConfig>
  /** Reverse lookup: lowercase contract address → TokenConfig */
  tokenByAddress: Record<string, TokenConfig>
}

// ── Gnosis Chain (100) ────────────────────────────────────────────

const GNOSIS_TOKENS: Record<string, TokenConfig> = {
  XDAI: {
    symbol: 'xDAI',
    decimals: 18,
    address: null,
    coingeckoId: 'xdai',
  },
  EURE: {
    symbol: 'EURe',
    decimals: 18,
    address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E',
    coingeckoId: 'monerium-eur-money',
  },
  USDCE: {
    symbol: 'USDC.e',
    decimals: 6,
    address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0',
    coingeckoId: 'usd-coin',
  },
}

const GNOSIS: ChainConfig = {
  chainId: 100,
  name: 'Gnosis Chain',
  shortName: 'gnosis',
  nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
  rpcUrl: config.rpcUrl,
  explorerUrl: 'https://gnosisscan.io',
  explorerApiUrl: 'https://api.etherscan.io/v2/api',
  explorerApiKey: config.gnosisscanApiKey,
  explorerApiProvider: 'etherscan-v2',
  safeTxServiceUrl: 'https://safe-transaction-gnosis-chain.safe.global',
  contracts: {
    safeProxyFactory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
    safeSingletonL2: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E',
    fallbackHandler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
    allowanceModule: '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
  tokens: GNOSIS_TOKENS,
  tokenByAddress: buildTokenByAddress(GNOSIS_TOKENS),
}

// ── Base (8453) ───────────────────────────────────────────────────

const BASE_TOKENS: Record<string, TokenConfig> = {
  ETH: {
    symbol: 'ETH',
    decimals: 18,
    address: null,
    coingeckoId: 'ethereum',
  },
  USDC: {
    symbol: 'USDC',
    decimals: 6,
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    coingeckoId: 'usd-coin',
  },
}

const BASE: ChainConfig = {
  chainId: 8453,
  name: 'Base',
  shortName: 'base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrl: config.rpcUrlBase,
  explorerUrl: 'https://basescan.org',
  // Blockscout v2 is used for Base: the v1 tokentx endpoint consistently
  // times out (HTTP 524) on Base, and Etherscan V2 requires a paid plan.
  // v2 uses per-endpoint REST URLs built from this base.
  explorerApiUrl: 'https://base.blockscout.com/api/v2',
  explorerApiKey: '',
  explorerApiProvider: 'blockscout-v2',
  safeTxServiceUrl: 'https://safe-transaction-base.safe.global',
  contracts: {
    // Base uses EIP-155 variant addresses for Safe v1.3.0
    safeProxyFactory: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC',
    safeSingletonL2: '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
    fallbackHandler: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804',
    // These are at the same CREATE2 addresses on Base
    allowanceModule: '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
  tokens: BASE_TOKENS,
  tokenByAddress: buildTokenByAddress(BASE_TOKENS),
}

// ── Registry ──────────────────────────────────────────────────────

const CHAINS: Record<number, ChainConfig> = {
  100: GNOSIS,
  8453: BASE,
}

export const SUPPORTED_CHAIN_IDS = Object.keys(CHAINS).map(Number)

export function getChain(chainId: number): ChainConfig {
  const chain = CHAINS[chainId]
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}. Supported: ${SUPPORTED_CHAIN_IDS.join(', ')}`)
  }
  return chain
}

export function getExplorerUrl(
  chainId: number,
  type: 'tx' | 'address',
  hash: string,
): string {
  const chain = getChain(chainId)
  return `${chain.explorerUrl}/${type}/${hash}`
}

export function isSupportedChain(chainId: number): boolean {
  return chainId in CHAINS
}

// ── Helpers ───────────────────────────────────────────────────────

function buildTokenByAddress(
  tokens: Record<string, TokenConfig>,
): Record<string, TokenConfig> {
  const map: Record<string, TokenConfig> = {}
  for (const token of Object.values(tokens)) {
    if (token.address) {
      map[token.address.toLowerCase()] = token
    }
  }
  return map
}
