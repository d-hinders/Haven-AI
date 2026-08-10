/**
 * Chain config — env-selectable so the dev instance can run on Base Sepolia
 * (testnet) while production stays on Base mainnet. Set `MERCHANT_CHAIN_ID=84532`
 * for the dev/testnet deploy (default is `8453`, Base mainnet).
 *
 * The USDC EIP-712 domain `name` differs per chain — "USD Coin" on Base mainnet,
 * "USDC" on Base Sepolia (both verified on-chain via the token's `name()`).
 * Getting it wrong breaks `transferWithAuthorization` signature verification, so
 * it is tracked per chain here, not hardcoded.
 */
import { getAddress, isAddress, type Address } from 'viem'

interface MerchantChainConfig {
  usdcAddress: `0x${string}`
  usdcDomainName: string
  usdcDomainVersion: string
  /** Pinned to the same in-repo DelegationManager registry as the backend. */
  delegationManager: Address
}

const CHAINS: Record<number, MerchantChainConfig> = {
  8453: {
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdcDomainName: 'USD Coin',
    usdcDomainVersion: '2',
    delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
  },
  84532: {
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcDomainName: 'USDC',
    usdcDomainVersion: '2',
    delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
  },
}

export const CHAIN_ID = Number(process.env.MERCHANT_CHAIN_ID ?? '8453')

const chain = CHAINS[CHAIN_ID]
if (!chain) {
  throw new Error(
    `Unsupported MERCHANT_CHAIN_ID: ${CHAIN_ID}. Supported: ${Object.keys(CHAINS).join(', ')}`,
  )
}

export const USDC_ADDRESS = chain.usdcAddress
export const USDC_DOMAIN_NAME = chain.usdcDomainName
export const USDC_DOMAIN_VERSION = chain.usdcDomainVersion
export const TRUSTED_DELEGATION_MANAGER = chain.delegationManager
export const SUPPORTED_SETTLEMENT_METHODS = ['eip3009', 'erc7710'] as const
export type SettlementMethod = (typeof SUPPORTED_SETTLEMENT_METHODS)[number]
export const DEFAULT_SETTLEMENT_METHOD: SettlementMethod = 'eip3009'
export type MerchantEnvironment = 'dev' | 'prod'
export const HOSTED_DEMO_MERCHANT_URLS: Record<MerchantEnvironment, string> = {
  dev: 'https://demo-merchant-dev-84e4.up.railway.app',
  prod: 'https://enthusiastic-blessing-production-171f.up.railway.app',
}

export function merchantEnvironmentForChain(chainId = CHAIN_ID): MerchantEnvironment {
  return chainId === 84532 ? 'dev' : 'prod'
}

export function hostedMerchantBaseUrlForChain(chainId = CHAIN_ID): string {
  return HOSTED_DEMO_MERCHANT_URLS[merchantEnvironmentForChain(chainId)]
}

export function trustedDelegationManagerForChain(chainId = CHAIN_ID): Address | undefined {
  return CHAINS[chainId]?.delegationManager
}

export function isTrustedDelegationManagerForChain(value: unknown, chainId = CHAIN_ID): value is Address {
  const trusted = trustedDelegationManagerForChain(chainId)
  if (!trusted || typeof value !== 'string' || !isAddress(value)) return false
  return getAddress(value) === getAddress(trusted)
}

export type ProductId =
  | 'vpn_basic'
  | 'vpn_pro'
  | 'vpn_ultra'
  | 'storage_50gb'
  | 'storage_200gb'
  | 'storage_1tb'

export interface Product {
  id: ProductId
  name: string
  description: string
  /** Price in USDC base units (6 decimals). E.g. $1.00 = 1_000_000n */
  price_usdc: bigint
  category: 'vpn' | 'storage'
  x402: {
    settlementMethods: readonly SettlementMethod[]
    defaultSettlementMethod: SettlementMethod
  }
}

export const PRODUCTS: Record<ProductId, Product> = {
  vpn_basic: {
    id: 'vpn_basic',
    name: 'NordShield VPN Basic',
    description: 'Grundläggande VPN-skydd. Upp till 10 enheter. Standardhastigheter. 50+ serverplatser.',
    price_usdc: 1_000n,
    category: 'vpn',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  vpn_pro: {
    id: 'vpn_pro',
    name: 'NordShield VPN Pro',
    description: 'Premium VPN. Obegränsade enheter. Höghastighetsservrar. Dubbel-VPN. 90+ länder.',
    price_usdc: 3_000n,
    category: 'vpn',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  vpn_ultra: {
    id: 'vpn_ultra',
    name: 'NordShield VPN Ultra',
    description: 'Ultimat sekretess. Onion-routing. Dedikerade IP-adresser. Prioritetssupport dygnet runt.',
    price_usdc: 5_000n,
    category: 'vpn',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  storage_50gb: {
    id: 'storage_50gb',
    name: 'CloudNest 50 GB',
    description: 'Säker krypterad molnlagring. 50 GB. Fildelning och automatisk synk ingår.',
    price_usdc: 500n,
    category: 'storage',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  storage_200gb: {
    id: 'storage_200gb',
    name: 'CloudNest 200 GB',
    description: 'Utökad lagring. 200 GB. Versionshantering, automatisk backup och prioritetsbandbredd.',
    price_usdc: 1_500n,
    category: 'storage',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  storage_1tb: {
    id: 'storage_1tb',
    name: 'CloudNest 1 TB',
    description: 'Affärsklass molnlagring. 1 TB. API-åtkomst, teamdelning och SLA 99,9% drifttid.',
    price_usdc: 4_000n,
    category: 'storage',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
}

export function isSettlementMethod(value: unknown): value is SettlementMethod {
  return value === 'erc7710' || value === 'eip3009'
}

/** Format USDC base units as a human-readable USD string.
 *  Strips trailing zeros so micropayments show correctly (e.g. 0.001 not 0.00). */
export function formatUsdc(units: bigint): string {
  // Pure bigint math (#1279): this formatter renders invoice/protocol-facing
  // amounts, and a Number round-trip silently loses precision past 2^53 base
  // units. Unreachable with today's demo prices, but formatters get reused.
  const negative = units < 0n
  const abs = negative ? -units : units
  const whole = abs / 1_000_000n
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}
