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
  /**
   * The `ERC20TransferAmountEnforcer` this merchant will trust as the on-chain
   * record of "how much has this settlement child spent" (#1515). Pinned, not
   * read from the attacker-supplied payment: the enforcer address in a
   * `permissionContext` caveat is chosen by whoever built the delegation, so
   * trusting `spentMap` from an arbitrary caveat address lets a forged
   * enforcer return any number. Deterministically deployed, so Base and Base
   * Sepolia share it — the same address the signer pins
   * (`packages/signer/src/settlement-child.ts`).
   */
  erc20TransferAmountEnforcer: Address
}

const CHAINS: Record<number, MerchantChainConfig> = {
  8453: {
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdcDomainName: 'USD Coin',
    usdcDomainVersion: '2',
    delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
    erc20TransferAmountEnforcer: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc',
  },
  84532: {
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcDomainName: 'USDC',
    usdcDomainVersion: '2',
    delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
    erc20TransferAmountEnforcer: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc',
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
export const TRUSTED_ERC20_TRANSFER_AMOUNT_ENFORCER = chain.erc20TransferAmountEnforcer
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
  | 'vpn_legacy'
  | 'vpn_pro'
  | 'vpn_ultra'
  | 'storage_50gb'
  | 'storage_200gb'
  | 'storage_1tb'

export interface Product {
  id: ProductId
  name: string
  /** English display description (#1550 — the demo default is English). */
  description: string
  /**
   * Swedish display description, and the text that feeds the invoice JSON's
   * `beskrivning` row: the invoice document is a Swedish bookkeeping artifact
   * by design (see invoice.ts) and stays Swedish regardless of display locale.
   */
  description_sv: string
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
    description: 'Essential VPN protection. Up to 10 devices. Standard speeds. 50+ server locations.',
    description_sv: 'Grundläggande VPN-skydd. Upp till 10 enheter. Standardhastigheter. 50+ serverplatser.',
    price_usdc: 1_000n,
    category: 'vpn',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  /**
   * The ONLY EIP-3009-only product (#1441). Everything else advertises both
   * methods, and the #1450 preference rule then picks erc7710 — which has no
   * funding leg, so it makes the funding-leg topology unreachable from the
   * `haven_pay_mcp_tool` entry point that `x402-hosted-mcp-signer` exists to
   * cover. That leg had no merchant it could assert against and skipped
   * permanently.
   *
   * A dedicated product rather than narrowing an existing one: an earlier
   * attempt (#1513) made `vpn_pro` 3009-only and had to be reverted, because
   * mutating a shared fixture changes what every other leg is buying. This one
   * is bought by exactly one scenario, and its settlement methods are the
   * point of it — do not "tidy" it back to SUPPORTED_SETTLEMENT_METHODS.
   */
  vpn_legacy: {
    id: 'vpn_legacy',
    name: 'NordShield VPN Legacy',
    description:
      'VPN subscription that only supports EIP-3009 payment. Intended for clients without ERC-7710 support.',
    description_sv:
      'VPN-abonnemang som endast stöder EIP-3009-betalning. Avsett för klienter utan ERC-7710-stöd.',
    price_usdc: 1_000n,
    category: 'vpn',
    x402: { settlementMethods: ['eip3009'], defaultSettlementMethod: 'eip3009' },
  },
  vpn_pro: {
    id: 'vpn_pro',
    name: 'NordShield VPN Pro',
    description: 'Premium VPN. Unlimited devices. High-speed servers. Double-VPN. 90+ countries.',
    description_sv: 'Premium VPN. Obegränsade enheter. Höghastighetsservrar. Dubbel-VPN. 90+ länder.',
    price_usdc: 3_000n,
    category: 'vpn',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  vpn_ultra: {
    id: 'vpn_ultra',
    name: 'NordShield VPN Ultra',
    description: 'Ultimate privacy. Onion routing. Dedicated IP addresses. 24/7 priority support.',
    description_sv: 'Ultimat sekretess. Onion-routing. Dedikerade IP-adresser. Prioritetssupport dygnet runt.',
    price_usdc: 5_000n,
    category: 'vpn',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  storage_50gb: {
    id: 'storage_50gb',
    name: 'CloudNest 50 GB',
    description: 'Secure encrypted cloud storage. 50 GB. File sharing and automatic sync included.',
    description_sv: 'Säker krypterad molnlagring. 50 GB. Fildelning och automatisk synk ingår.',
    price_usdc: 500n,
    category: 'storage',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  storage_200gb: {
    id: 'storage_200gb',
    name: 'CloudNest 200 GB',
    description: 'Expanded storage. 200 GB. Version history, automatic backup, and priority bandwidth.',
    description_sv: 'Utökad lagring. 200 GB. Versionshantering, automatisk backup och prioritetsbandbredd.',
    price_usdc: 1_500n,
    category: 'storage',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  storage_1tb: {
    id: 'storage_1tb',
    name: 'CloudNest 1 TB',
    description: 'Business-grade cloud storage. 1 TB. API access, team sharing, and a 99.9% uptime SLA.',
    description_sv: 'Affärsklass molnlagring. 1 TB. API-åtkomst, teamdelning och SLA 99,9% drifttid.',
    price_usdc: 4_000n,
    category: 'storage',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
}

export function isSettlementMethod(value: unknown): value is SettlementMethod {
  return value === 'erc7710' || value === 'eip3009'
}

// ── Display locale (#1550) ───────────────────────────────────────────────────
// English is the demo default — this merchant is Haven's own showcase and its
// transcripts are read mostly by English-speaking developers. Swedish stays a
// first-class option, and the invoice JSON (a Swedish bookkeeping artifact —
// see invoice.ts) is deliberately NOT localized by this switch.

export const MERCHANT_LOCALES = ['en', 'sv'] as const
export type MerchantLocale = (typeof MERCHANT_LOCALES)[number]
export const DEFAULT_MERCHANT_LOCALE: MerchantLocale = 'en'

export function productDescription(product: Product, locale: MerchantLocale): string {
  return locale === 'sv' ? product.description_sv : product.description
}

// ── Machine-readable product metadata (#1274) ───────────────────────────────
// Builds the stable, per-product contract agents can select purchases from
// without parsing the localized freeform `description` prose. This layer only
// CONSUMES the settlement methods the caller says are enabled — it does not
// re-decide the erc7710/pinned-DelegationManager gate itself, so it inherits
// #1266's compatibility decisions (eip3009 default/first, erc7710 opt-in,
// no-boot-crash-on-missing-config) from whoever resolved that list upstream
// (`index.ts` / `http.ts`).

const VPN_PLAN_VALUES = ['basic', 'legacy', 'pro', 'ultra'] as const
const STORAGE_TIER_VALUES = ['50gb', '200gb', '1tb'] as const

interface ProductToolArgs {
  toolName: 'buy_vpn' | 'buy_cloud_storage'
  argumentName: 'plan' | 'tier'
  argumentValue: string
  argumentEnum: readonly string[]
}

/** Derives the exact buy-tool call (tool name + fixed argument) for a product. */
export function productToolArgs(product: Product): ProductToolArgs {
  if (product.category === 'vpn') {
    return {
      toolName: 'buy_vpn',
      argumentName: 'plan',
      argumentValue: product.id.slice('vpn_'.length),
      argumentEnum: VPN_PLAN_VALUES,
    }
  }
  return {
    toolName: 'buy_cloud_storage',
    argumentName: 'tier',
    argumentValue: product.id.slice('storage_'.length),
    argumentEnum: STORAGE_TIER_VALUES,
  }
}

/** JSON-schema-ish description of the buy tool's arguments for this exact product
 *  (the fixed `const` pins the value an agent must send to select it). */
export function productArgumentsSchema(product: Product): Record<string, unknown> {
  const { argumentName, argumentValue, argumentEnum, toolName } = productToolArgs(product)
  return {
    type: 'object',
    properties: {
      [argumentName]: {
        type: 'string',
        enum: [...argumentEnum],
        const: argumentValue,
        description: `Fixed value selecting "${product.name}" via the ${toolName} tool.`,
      },
      settlement_method: {
        type: 'string',
        enum: [...SUPPORTED_SETTLEMENT_METHODS],
        description: 'Optional x402 settlement method override; omit to use default_settlement_method.',
      },
    },
    required: [argumentName],
    additionalProperties: false,
  }
}

/** Settlement methods this product supports, filtered to the merchant's
 *  currently-enabled set (which is where the erc7710 pinned-manager gate is
 *  already decided) — always ordered with EIP-3009 first when present, never
 *  letting an opt-in rail lead. */
export function settlementMethodsForProduct(
  product: Product,
  enabledMethods: readonly SettlementMethod[],
): SettlementMethod[] {
  const supported = product.x402.settlementMethods.filter((method) => enabledMethods.includes(method))
  const unique = [...new Set(supported)]
  if (unique.includes(DEFAULT_SETTLEMENT_METHOD)) {
    return [DEFAULT_SETTLEMENT_METHOD, ...unique.filter((method) => method !== DEFAULT_SETTLEMENT_METHOD)]
  }
  return unique
}

export type BillingPeriod = 'monthly'

export interface ProductMetadata {
  product_id: ProductId
  display_name: string
  /** Freeform prose, display-only — ALWAYS the English copy (#1550), even when
   *  a tool call passes `locale: 'sv'`: this is stable machine metadata, and the
   *  localized text lives in the tool's prose output instead. Agents should
   *  select products via `product_id` + `arguments_schema`, never by parsing this. */
  description: string
  /** Price in USDC base units (6 decimals), as a decimal string. */
  price_atomic: string
  asset: 'USDC'
  network: string
  billing_period: BillingPeriod
  tool_name: ProductToolArgs['toolName']
  arguments_schema: Record<string, unknown>
  supported_settlement_methods: SettlementMethod[]
  default_settlement_method: SettlementMethod
  mcp_url: string
  environment: MerchantEnvironment
  /** Display-only formatted text alongside the stable fields above. */
  display: {
    price_formatted: string
  }
}

export function buildProductMetadata(
  product: Product,
  opts: { enabledSettlementMethods: readonly SettlementMethod[]; mcpUrl: string; chainId?: number },
): ProductMetadata {
  const chainId = opts.chainId ?? CHAIN_ID
  const supportedSettlementMethods = settlementMethodsForProduct(product, opts.enabledSettlementMethods)
  const defaultSettlementMethod = supportedSettlementMethods[0] ?? DEFAULT_SETTLEMENT_METHOD
  return {
    product_id: product.id,
    display_name: product.name,
    description: product.description,
    price_atomic: product.price_usdc.toString(),
    asset: 'USDC',
    network: `eip155:${chainId}`,
    billing_period: 'monthly',
    tool_name: productToolArgs(product).toolName,
    arguments_schema: productArgumentsSchema(product),
    supported_settlement_methods: supportedSettlementMethods,
    default_settlement_method: defaultSettlementMethod,
    mcp_url: opts.mcpUrl,
    environment: merchantEnvironmentForChain(chainId),
    display: {
      price_formatted: `$${formatUsdc(product.price_usdc)} USDC`,
    },
  }
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
