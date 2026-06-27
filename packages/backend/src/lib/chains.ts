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
  safeTxServiceUrl: string   // e.g. https://api.safe.global/tx-service/gno
  contracts: {
    safeProxyFactory: string
    safeSingletonL2: string
    fallbackHandler: string
    allowanceModule: string
    multiSendCallOnly: string
  }
  passkey: {
    /** P-256 verifier the Safe passkey signer will call. */
    verifier: string
    /** SafeWebAuthnSignerFactory deployment for this chain. */
    factoryAddress: string
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
  safeTxServiceUrl: 'https://api.safe.global/tx-service/gno',
  contracts: {
    safeProxyFactory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
    safeSingletonL2: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E',
    fallbackHandler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
    allowanceModule: '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
  passkey: {
    verifier: '0x445a0683e494ea0c5af3e83c5159fbe47cf9e765',
    // SafeWebAuthnSignerFactory live deployment used by the frontend parity checks in PR #40.
    factoryAddress: '0x1d31F259eE307358a26dFb23EB365939E8641195',
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
  safeTxServiceUrl: 'https://api.safe.global/tx-service/base',
  contracts: {
    // Base uses EIP-155 variant addresses for Safe v1.3.0
    safeProxyFactory: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC',
    safeSingletonL2: '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
    fallbackHandler: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804',
    // These are at the same CREATE2 addresses on Base
    allowanceModule: '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
  passkey: {
    verifier: '0x0000000000000000000000000000000000000100',
    // SafeWebAuthnSignerFactory live deployment used by the frontend parity checks in PR #40.
    factoryAddress: '0x1d31F259eE307358a26dFb23EB365939E8641195',
  },
  tokens: BASE_TOKENS,
  tokenByAddress: buildTokenByAddress(BASE_TOKENS),
}

// ── Base Sepolia (84532) — testnet for dev / QA ───────────────────
//
// All addresses verified deployed on Base Sepolia via eth_getCode across three
// RPCs. The only delta from Base mainnet is the AllowanceModule: v0.1.0's
// 0xCFbF… address is NOT deployed on Base Sepolia, so this uses the v0.1.1
// deployment (0xAA46…). v0.1.1's ABI is identical to v0.1.0's, so the existing
// AllowanceModule integration works unchanged.

const BASE_SEPOLIA_TOKENS: Record<string, TokenConfig> = {
  ETH: {
    symbol: 'ETH',
    decimals: 18,
    address: null,
    coingeckoId: 'ethereum',
  },
  USDC: {
    symbol: 'USDC',
    decimals: 6,
    // Circle's canonical Base Sepolia testnet USDC.
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    coingeckoId: 'usd-coin',
  },
}

const BASE_SEPOLIA: ChainConfig = {
  chainId: 84532,
  name: 'Base Sepolia',
  shortName: 'base-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrl: config.rpcUrlBaseSepolia,
  explorerUrl: 'https://sepolia.basescan.org',
  explorerApiUrl: 'https://base-sepolia.blockscout.com/api/v2',
  explorerApiKey: '',
  explorerApiProvider: 'blockscout-v2',
  safeTxServiceUrl: 'https://api.safe.global/tx-service/basesep',
  contracts: {
    safeProxyFactory: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC',
    safeSingletonL2: '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
    fallbackHandler: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804',
    // AllowanceModule v0.1.1 (identical ABI to v0.1.0; v0.1.0's address is not
    // on Base Sepolia). Verified via eth_getCode.
    allowanceModule: '0xAA46724893dedD72658219405185Fb0Fc91e091C',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
  passkey: {
    verifier: '0x0000000000000000000000000000000000000100',
    factoryAddress: '0x1d31F259eE307358a26dFb23EB365939E8641195',
  },
  tokens: BASE_SEPOLIA_TOKENS,
  tokenByAddress: buildTokenByAddress(BASE_SEPOLIA_TOKENS),
}

// ── Registry ──────────────────────────────────────────────────────

const CHAINS: Record<number, ChainConfig> = {
  100: GNOSIS,
  8453: BASE,
  84532: BASE_SEPOLIA,
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
