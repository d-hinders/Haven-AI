/**
 * Shared chain + token registry (#986, epic #980 M1) — the single source of
 * truth for the per-chain FACTS that backend and frontend previously each
 * maintained a copy of: identity, explorer/Safe-service URLs, contract
 * addresses, passkey deployment, and token data.
 *
 * What deliberately does NOT live here:
 * - RPC URLs, API keys, provider/relayer construction — environment wiring,
 *   stays in the backend (`packages/backend/src/domain/chains.ts`).
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
// RPCs.

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

/**
 * The chain a record lands on when a caller does not name one (#990).
 *
 * Base (8453), matching CLAUDE.md's "Base is the primary / default network" and
 * the column defaults that migration `034_base_default_chain` already set. This
 * constant does not *decide* the default — it names the one already in force so
 * the value stops being restated as a bare literal in a dozen call sites.
 *
 * ## Changing this is a money-path change, not a config tweak
 *
 * Hoisting the literal is what makes it dangerous: before, moving the default
 * meant editing every site and confronting each one; now a single edit here
 * silently moves where new Safes, payment intents and approval requests land.
 * `chains.test.ts` pins the value for exactly that reason — a change must break
 * a test and be argued for, not merged as a one-character diff.
 *
 * Two things it deliberately does NOT do:
 *
 * - It does not touch existing rows. Migration 034 changed column defaults for
 *   future inserts only; a Safe or payment already on Gnosis stays on Gnosis,
 *   because rewriting a stored chain would repoint money at another network.
 * - It does not govern chains a deployment will actually *serve*. That is
 *   `HAVEN_DEPLOY_CHAIN_IDS` (#679), which is env-scoped — dev serves Base
 *   Sepolia only. A default is what you get when you say nothing; the served
 *   set is what you are allowed to ask for.
 */
export const DEFAULT_CHAIN_ID = 8453

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
