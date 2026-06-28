/**
 * Multi-chain configuration for the Haven frontend.
 *
 * Single source of truth for per-chain data: contract addresses,
 * tokens, explorer URLs, and Safe TX service URLs.
 */
import type { Address } from 'viem'
import { gnosis, base, baseSepolia } from 'viem/chains'

// Re-export viem chain objects for convenience
export { gnosis, base, baseSepolia }

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
  viemChain: typeof gnosis | typeof base | typeof baseSepolia
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
  safeTxServiceUrl: 'https://api.safe.global/tx-service/gno',
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
  safeTxServiceUrl: 'https://api.safe.global/tx-service/base',
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
    'USDC': { symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    'ETH': { symbol: 'ETH', decimals: 18, address: null },
  },
}

// ── Base Sepolia (84532) — testnet, for the dev environment ───────
//
// Mirrors the backend BASE_SEPOLIA (#598); every address verified deployed on
// Base Sepolia via eth_getCode. The AllowanceModule is the **v0.1.1** deployment
// (0xAA46…) — v0.1.0's 0xCFbF… is not on Base Sepolia (identical ABI). USDC is
// Circle's testnet token.
const BASE_SEPOLIA_CONFIG: FrontendChainConfig = {
  chainId: 84532,
  name: 'Base Sepolia',
  shortName: 'base-sepolia',
  viemChain: baseSepolia,
  explorerUrl: 'https://sepolia.basescan.org',
  safeTxServiceUrl: 'https://api.safe.global/tx-service/basesep',
  contracts: {
    safeProxyFactory: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC',
    safeSingletonL2: '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
    fallbackHandler: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804',
    allowanceModule: '0xAA46724893dedD72658219405185Fb0Fc91e091C',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
  passkey: {
    verifier: '0x0000000000000000000000000000000000000100',
  },
  tokens: {
    'USDC': { symbol: 'USDC', decimals: 6, address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
    'ETH': { symbol: 'ETH', decimals: 18, address: null },
  },
}

// ── Registry ──────────────────────────────────────────────────────

/**
 * Full registry of every chain Haven *knows about*. `getChainConfig` reads
 * from here, so data created on any of these chains (e.g. a Safe a user
 * imported on Gnosis before we went Base-only) still renders without
 * crashing.
 */
const CHAINS: Record<number, FrontendChainConfig> = {
  100: GNOSIS_CONFIG,
  8453: BASE_CONFIG,
  84532: BASE_SEPOLIA_CONFIG,
}

/**
 * Chains currently *offered to users* — network pickers, wallet
 * network-validation, and the wagmi connector list all derive from this.
 *
 * Single-chain per deploy. The active chain is configurable via
 * `NEXT_PUBLIC_HAVEN_CHAIN_ID` (build-time inlined, like `NEXT_PUBLIC_HAVEN_ENV`)
 * — defaults to Base mainnet (8453); the **dev** Vercel deploy sets `84532`
 * (Base Sepolia) so dev onboards on testnet against the testnet relayer, mirroring
 * the demo-merchant's `MERCHANT_CHAIN_ID`. Unknown/unset values fall back to Base.
 */
const CONFIGURED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_HAVEN_CHAIN_ID ?? '')
const ACTIVE_CHAIN: FrontendChainConfig = CHAINS[CONFIGURED_CHAIN_ID] ?? BASE_CONFIG

const ENABLED_CHAIN_IDS: number[] = [ACTIVE_CHAIN.chainId]

export const SUPPORTED_CHAINS = ENABLED_CHAIN_IDS.map((id) => CHAINS[id])
export const SUPPORTED_CHAIN_IDS = ENABLED_CHAIN_IDS
export const DEFAULT_CHAIN_ID = ACTIVE_CHAIN.chainId

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
