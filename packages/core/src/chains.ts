/**
 * Shared chain + token registry (#986, epic #980 M1) — the single source of
 * truth for the per-chain FACTS that backend and frontend previously each
 * maintained a copy of: identity, explorer/Safe-service URLs, contract
 * addresses, passkey deployment, and token data.
 *
 * What deliberately does NOT live here:
 * - RPC URLs, API keys, provider/relayer construction — environment wiring,
 *   stays in the backend (`packages/backend/src/lib/chains.ts`).
 * - viem chain objects, wagmi wiring — client construction, stays in the
 *   frontend (`packages/frontend/src/lib/chains.ts`).
 * - Each consumer's token RECORD keying and ordering — representation, not
 *   data. The backend keys tokens `USDCE`-style and lists native first (its
 *   balances API iterates in registry order); the frontend keys by display
 *   symbol in picker order. Both derive from the token DATA here.
 *
 * This package must stay pure (no viem/ethers) — addresses are plain strings;
 * consumers cast to their own address types at the boundary.
 */

export interface CoreTokenConfig {
  symbol: string
  decimals: number
  /** Token contract address; null = the chain-native token. */
  address: string | null
  coingeckoId: string
}

export interface CoreChainConfig {
  chainId: number
  name: string
  shortName: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  explorerUrl: string
  safeTxServiceUrl: string
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
  /** Token data in the backend's canonical order (native first). */
  tokens: CoreTokenConfig[]
}

// ── Gnosis Chain (100) ────────────────────────────────────────────

const GNOSIS: CoreChainConfig = {
  chainId: 100,
  name: 'Gnosis Chain',
  shortName: 'gnosis',
  nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
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
    verifier: '0x445a0683e494ea0c5af3e83c5159fbe47cf9e765',
    // SafeWebAuthnSignerFactory live deployment used by the frontend parity checks in PR #40.
    factoryAddress: '0x1d31F259eE307358a26dFb23EB365939E8641195',
  },
  tokens: [
    { symbol: 'xDAI', decimals: 18, address: null, coingeckoId: 'xdai' },
    { symbol: 'EURe', decimals: 18, address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E', coingeckoId: 'monerium-eur-money' },
    { symbol: 'USDC.e', decimals: 6, address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', coingeckoId: 'usd-coin' },
  ],
}

// ── Base (8453) ───────────────────────────────────────────────────

const BASE: CoreChainConfig = {
  chainId: 8453,
  name: 'Base',
  shortName: 'base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  explorerUrl: 'https://basescan.org',
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
    factoryAddress: '0x1d31F259eE307358a26dFb23EB365939E8641195',
  },
  tokens: [
    { symbol: 'ETH', decimals: 18, address: null, coingeckoId: 'ethereum' },
    { symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', coingeckoId: 'usd-coin' },
  ],
}

// ── Base Sepolia (84532) — testnet for dev / QA ───────────────────
//
// All addresses verified deployed on Base Sepolia via eth_getCode across three
// RPCs. The only delta from Base mainnet is the AllowanceModule: v0.1.0's
// 0xCFbF… address is NOT deployed on Base Sepolia, so this uses the v0.1.1
// deployment (0xAA46…). v0.1.1's ABI is identical to v0.1.0's.

const BASE_SEPOLIA: CoreChainConfig = {
  chainId: 84532,
  name: 'Base Sepolia',
  shortName: 'base-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  explorerUrl: 'https://sepolia.basescan.org',
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
  tokens: [
    { symbol: 'ETH', decimals: 18, address: null, coingeckoId: 'ethereum' },
    // Circle's canonical Base Sepolia testnet USDC.
    { symbol: 'USDC', decimals: 6, address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', coingeckoId: 'usd-coin' },
  ],
}

// ── Registry + pure lookups ───────────────────────────────────────

export const CHAIN_REGISTRY: Record<number, CoreChainConfig> = {
  100: GNOSIS,
  8453: BASE,
  84532: BASE_SEPOLIA,
}

export const REGISTRY_CHAIN_IDS = Object.keys(CHAIN_REGISTRY).map(Number)

export function getChainData(chainId: number): CoreChainConfig {
  const chain = CHAIN_REGISTRY[chainId]
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}. Supported: ${REGISTRY_CHAIN_IDS.join(', ')}`)
  }
  return chain
}

export function isRegisteredChain(chainId: number): boolean {
  return chainId in CHAIN_REGISTRY
}

/** Token data for a symbol on a chain, or undefined. */
export function resolveToken(chainId: number, symbol: string): CoreTokenConfig | undefined {
  return getChainData(chainId).tokens.find((t) => t.symbol === symbol)
}

export function buildExplorerUrl(
  chainId: number,
  type: 'tx' | 'address',
  hash: string,
): string {
  return `${getChainData(chainId).explorerUrl}/${type}/${hash}`
}
