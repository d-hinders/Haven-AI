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
import {
  CHECKOUT_DETAILS_FIELDS,
  isCheckoutDetailsField,
  type CheckoutDetailsField,
  type CheckoutDetailsRequest,
} from '@haven_ai/merchant-payments'

interface MerchantChainConfig {
  /** The ONE home of the network's display name (#3834). */
  name: string
  /** Testnets are marked in every display copy; mainnet is not. */
  testnet: boolean
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
   * (`packages/sdk/src/settlement-child.ts`, shared with the signer since #3283).
   */
  erc20TransferAmountEnforcer: Address
}

const CHAINS: Record<number, MerchantChainConfig> = {
  8453: {
    name: 'Base',
    testnet: false,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdcDomainName: 'USD Coin',
    usdcDomainVersion: '2',
    delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
    erc20TransferAmountEnforcer: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc',
  },
  84532: {
    name: 'Base Sepolia',
    testnet: true,
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

/**
 * Display name of the merchant's network, per chain and language (#3834).
 * Mainnet is the bare name ("Base"); a testnet carries a marker ("Base Sepolia
 * testnet" / "Base Sepolia testnät"). Every human/agent-facing copy of the
 * network name derives from here.
 */
export function networkDisplayName(chainId: number = CHAIN_ID, locale: MerchantLocale = 'en'): string {
  const c = CHAINS[chainId]
  if (!c) throw new Error(`Unsupported chain: ${chainId}`)
  if (!c.testnet) return c.name
  return locale === 'sv' ? `${c.name} testnät` : `${c.name} testnet`
}

/** Startup-log label: "Base mainnet" / "Base Sepolia testnet". */
export function networkLogLabel(chainId: number = CHAIN_ID): string {
  const c = CHAINS[chainId]
  return c ? `${c.name} ${c.testnet ? 'testnet' : 'mainnet'}` : ''
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
  | 'joke'
  | 'field_notes'
  | 'philip_vpn'
  | 'philip_storage'
  | 'philip_spoof'

export interface Product {
  id: ProductId
  name: string
  /** English display description (#1550 — the demo default is English). */
  description: string
  /**
   * Swedish display description, and the text of the invoice JSON's
   * `beskrivning` row on a Swedish receipt (`locale: 'sv'`); an English
   * receipt uses `description` (#4980, see invoice.ts).
   */
  description_sv: string
  /** Price in USDC base units (6 decimals). E.g. $1.00 = 1_000_000n */
  price_usdc: bigint
  category: 'vpn' | 'storage' | 'joke' | 'field_notes' | 'philip'
  /**
   * #4851: what one purchase buys. Absent, `monthly` — every subscription
   * product. Read through `productBillingPeriod`.
   */
  billing?: BillingPeriod
  x402: {
    settlementMethods: readonly SettlementMethod[]
    defaultSettlementMethod: SettlementMethod
  }
  /**
   * #4850: the address this product's payment is made out to — the 402's
   * `payTo`, the EIP-3009 `to` it verifies, the ERC-7710 transfer target and
   * the invoice's recipient address. Absent, the merchant's default receiving
   * address (`MERCHANT_ADDRESS`): read it through `productReceivingAddress`,
   * never off this field, so the default lives in one place.
   */
  receivingAddress?: Address
  /**
   * #4850: who verifies and settles this product's payment. Absent, `self`.
   * Read it through `productSettlementKind`.
   */
  settlement?: SettlementKind
  /**
   * #4853: this product's payments are recorded in Stripe as PaymentIntents,
   * and its receiving address is the Stripe deposit address when one is
   * configured. Read the address through `productReceivingAddress`, never off
   * this field. Only the CDP-settled joke sets it: Stripe records what CDP
   * settled, and no other product is settled by CDP.
   */
  stripeRecording?: boolean
  /**
   * #4873: the checkout details this product's challenge asks for, in the
   * shape `docs/architecture/13-checkout-details.md` §2 decided. Absent, the
   * challenge is unchanged. Read it through `checkoutDetailsForProduct`, never
   * off this field, so the dev-only required-field hook lives in one place.
   */
  checkoutDetails?: CheckoutDetailsRequest
  /**
   * #4950: this product is paid into the merchant's Haven Sales account
   * (`MERCHANT_SALES_ADDRESS`) and each settled sale is reported to Haven with
   * the Sales key. Read the address through `productReceivingAddress`, never
   * off this field. The product is offered only when the Sales settings are
   * set (`isProductOffered`).
   */
  salesAccount?: boolean
}

/**
 * #4850: how a product's payment is verified and settled.
 * - `self`: the merchant verifies the payment itself and settles it with its
 *   own gas-funded key (`SETTLEMENT_PRIVATE_KEY`).
 * - `cdp` (#4851): Coinbase's hosted facilitator (CDP) verifies the payment
 *   and settles it on-chain, paying the gas. The merchant still runs its own
 *   pre-verification checks first, and reads the chain itself after any
 *   failure. A `cdp` product is offered only when CDP credentials are set.
 */
export const SETTLEMENT_KINDS = ['self', 'cdp'] as const
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number]
export const DEFAULT_SETTLEMENT_KIND: SettlementKind = 'self'

/**
 * #4850: the address a payment for `product` must be made out to.
 *
 * #4853: a product whose payments Stripe records (`stripeRecording`) is paid
 * to the Stripe deposit address when one is configured — the deposit address
 * IS that product's receiving address, and no other product can name it. The
 * caller passes the deposit address only when Stripe is on; absent, the
 * product keeps `MERCHANT_ADDRESS` exactly as before.
 */
export function productReceivingAddress(
  product: Product,
  merchantDefault: Address,
  opts?: { stripeDepositAddress?: Address; salesAddress?: Address },
): Address {
  if (product.stripeRecording && opts?.stripeDepositAddress) return opts.stripeDepositAddress
  // #4950: the Sales product is paid into the Sales account. It is offered only
  // when that address is configured, so the fallback below is never quoted.
  if (product.salesAccount && opts?.salesAddress) return opts.salesAddress
  return product.receivingAddress ?? merchantDefault
}

/** #4850: who verifies and settles a payment for `product`. */
export function productSettlementKind(product: Product): SettlementKind {
  return product.settlement ?? DEFAULT_SETTLEMENT_KIND
}

/** #4851: what one purchase of `product` buys. */
export function productBillingPeriod(product: Product): BillingPeriod {
  return product.billing ?? 'monthly'
}

// ── Checkout details (#4873) ─────────────────────────────────────────────────
// The demo merchant is the first merchant that asks for checkout details. One
// product asks (`vpn_pro`), and the request rides its 402 challenge as the
// `haven-checkout-details` extension (docs/architecture/13-checkout-details.md
// §2). The answer is the `X-Checkout-Details` header on the paid request, read
// by `acceptCheckoutDetails` in the shared payment core.

/**
 * #4873: the checkout-details request a product's challenge carries, or
 * `undefined` when it asks for none.
 *
 * `requiredField` is the dev-only hook that turns one of the product's
 * optional fields into a required one, so the "stopped before paying"
 * behaviour (#4872) can be exercised on dev. It is off by default: with it
 * unset, every product's challenge is exactly what it was.
 */
export function checkoutDetailsForProduct(
  product: Product,
  opts?: { requiredField?: CheckoutDetailsField | null },
): CheckoutDetailsRequest | undefined {
  const request = product.checkoutDetails
  if (!request) return undefined
  const requiredField = opts?.requiredField
  if (!requiredField || !request.fields[requiredField]) return request
  return {
    fields: {
      ...request.fields,
      [requiredField]: { required: true },
    },
  }
}

/** #4873: the env var that exposes the required-field case on dev. */
export const CHECKOUT_DETAILS_REQUIRED_FIELD_ENV = 'MERCHANT_CHECKOUT_DETAILS_REQUIRED_FIELD'

/**
 * #4873: the dev-only required-field hook, read from
 * `MERCHANT_CHECKOUT_DETAILS_REQUIRED_FIELD`.
 *
 * **Testnet-only, enforced in code**, like `MERCHANT_SKIP_SETTLE_PRODUCT`: on
 * any other chain the merchant refuses to start rather than silently ignore
 * the flag. A required field changes what a purchase needs before it can be
 * paid — that is a test hook, not something to leave reachable on a real
 * chain.
 *
 * Unset (the default) means no field is required, so the QA scenarios see the
 * optional shape the issue asks for.
 */
export function requiredCheckoutFieldFromEnv(
  env: Record<string, string | undefined> = process.env,
  chainId: number = CHAIN_ID,
): CheckoutDetailsField | null {
  const raw = env[CHECKOUT_DETAILS_REQUIRED_FIELD_ENV]?.trim()
  if (!raw) return null
  if (!isCheckoutDetailsField(raw)) {
    throw new Error(
      `${CHECKOUT_DETAILS_REQUIRED_FIELD_ENV} must be one of ${CHECKOUT_DETAILS_FIELDS.join(', ')}; got "${raw}".`,
    )
  }
  if (chainId !== 84532) {
    throw new Error(
      `${CHECKOUT_DETAILS_REQUIRED_FIELD_ENV} is a dev-only hook that makes a checkout field required, ` +
        'so the "stopped before paying" behaviour can be exercised. ' +
        `Set MERCHANT_CHAIN_ID=84532 (Base Sepolia) to use it, or unset the flag. Got chain ${chainId}.`,
    )
  }
  return raw
}

/**
 * #4851: whether this merchant offers `product`. A `cdp` product needs CDP
 * credentials; without them it is absent from every surface — `list_products`,
 * the discovery document, the tool list and the payment gate — so a merchant
 * without the key is byte-identical to one built before the product existed.
 *
 * #4950: the Sales product needs the Sales settings (`salesConfigured`), on
 * the same terms: absent, it is on no surface.
 */
export interface ProductOfferOptions {
  cdpConfigured: boolean
  salesConfigured?: boolean
}

export function isProductOffered(product: Product, opts: ProductOfferOptions): boolean {
  if (product.salesAccount && !opts.salesConfigured) return false
  return productSettlementKind(product) !== 'cdp' || opts.cdpConfigured
}

/** #4851: the offered products, in catalogue order. */
export function offeredProducts(opts: ProductOfferOptions): Product[] {
  return Object.values(PRODUCTS).filter((product) => isProductOffered(product, opts))
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
   * The ONLY self-settled EIP-3009-only product (#1441; the CDP-settled joke,
   * #4851, is EIP-3009-only too). Everything else advertises both
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
    /**
     * #4873: the demo merchant's checkout-details product. It asks for a
     * receipt email and a billing address, both optional, so a paid request
     * that carries them shows them on the receipt and one that does not is
     * served exactly as today. `vpn_pro` rather than a product the QA
     * scenarios buy (`vpn_basic`, `storage_50gb`, the CDP joke): the challenge
     * of every other product stays byte-identical.
     */
    checkoutDetails: {
      fields: {
        receipt_email: { required: false },
        billing_address: { required: false },
      },
    },
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
  /**
   * #4851: the one product Coinbase's hosted facilitator (CDP) verifies and
   * settles — the setup Haven recommends to merchants, run here first.
   *
   * EIP-3009 only, on purpose: Haven agents prefer ERC-7710 whenever it is
   * advertised, and CDP does not settle ERC-7710, so offering it would route
   * almost nothing through CDP. That also makes it unavailable to an agent
   * whose budget is pinned to one recipient (EIP-3009 needs an open budget).
   *
   * Not in Haven's catalog (#4852): the demo store's funding target is
   * computed over all its catalog rows, and one EIP-3009-only row would make
   * merchant-locked budgets for the store refuse. Like `vpn_legacy`, it is
   * paid at this merchant's endpoint directly.
   *
   * 10,000 atomic USDC = 0.01 USDC: a whole number of US cents, which Stripe's
   * machine-payments recording needs in M2 (#4853).
   *
   * #4853: the one product Stripe records. With `STRIPE_DEPOSIT_ADDRESS` and
   * `STRIPE_SECRET_KEY` both set, its receiving address is the Stripe deposit
   * address and each settled payment becomes a PaymentIntent.
   */
  joke: {
    id: 'joke',
    name: 'Haven Joke',
    description: 'One joke, delivered at once. Verified and settled by Coinbase\'s hosted x402 facilitator (CDP).',
    description_sv:
      'Ett skämt, levererat direkt. Verifieras och avräknas av Coinbases x402-facilitator (CDP).',
    price_usdc: 10_000n,
    category: 'joke',
    billing: 'one_time',
    settlement: 'cdp',
    stripeRecording: true,
    x402: { settlementMethods: ['eip3009'], defaultSettlementMethod: 'eip3009' },
  },
  /**
   * #4950: the merchant-services demo product. It is paid into the merchant's
   * Haven Sales account, not `MERCHANT_ADDRESS`, and each settled sale is
   * reported to Haven, so it shows on the Sales page.
   *
   * Offered only with `MERCHANT_SALES_ADDRESS`, `MERCHANT_SALES_KEY` and
   * `MERCHANT_HAVEN_BASE_URL` set. Its own category and one-product tool
   * (`buy_field_notes`), like the joke: a new plan or tier on an existing tool
   * would change every existing product's argument schema.
   *
   * Self-settled with both methods, like the VPN and storage products. Not in
   * Haven's catalog: the demo store's catalog rows share one `pay_to`, so an
   * agent buys it at this merchant's endpoint (`haven_quote_mcp_tool`).
   *
   * 2,500 atomic USDC = 0.0025 USDC, a one-time purchase. A price no other
   * erc7710 product has: the already-redeemed bind identifies a purchase by
   * its exact-amount cap (the price-uniqueness guard in erc7710.test.ts).
   */
  field_notes: {
    id: 'field_notes',
    name: 'Haven Field Notes',
    description: 'One field note on running agent payments, delivered at once. Paid into a Haven Sales account.',
    description_sv:
      'En fältanteckning om agentbetalningar, levererad direkt. Betalas till ett Haven-försäljningskonto.',
    price_usdc: 2_500n,
    category: 'field_notes',
    billing: 'one_time',
    salesAccount: true,
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  /**
   * Philip's own demo products, added on a personal branch for a private demo.
   * They are ordinary self-settled products: paid to `MERCHANT_ADDRESS`, both
   * settlement methods, one-time. Prices are deliberately distinct from every
   * other erc7710 product (the price-uniqueness guard in erc7710.test.ts).
   */
  philip_vpn: {
    id: 'philip_vpn',
    name: "Philip's VPN",
    description: "Philip's own VPN tier. Up to 25 devices, 120+ locations, no logs kept.",
    description_sv: "Philips egen VPN-nivå. Upp till 25 enheter, 120+ platser, inga loggar sparas.",
    price_usdc: 2_000n,
    category: 'philip',
    billing: 'one_time',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  philip_storage: {
    id: 'philip_storage',
    name: "Philip's Cloud Storage",
    description: "Philip's own storage tier. 500 GB, version history, API access.",
    description_sv: "Philips egen lagringsnivå. 500 GB, versionshantering, API-åtkomst.",
    price_usdc: 3_500n,
    category: 'philip',
    billing: 'one_time',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
  philip_spoof: {
    id: 'philip_spoof',
    name: "Philip's Spoof Product",
    description: 'A deliberately fake product for demo purposes. Nothing is delivered.',
    description_sv: 'En medvetet påhittad produkt för demoändamål. Ingenting levereras.',
    price_usdc: 700n,
    category: 'philip',
    billing: 'one_time',
    x402: { settlementMethods: SUPPORTED_SETTLEMENT_METHODS, defaultSettlementMethod: DEFAULT_SETTLEMENT_METHOD },
  },
}

export function isSettlementMethod(value: unknown): value is SettlementMethod {
  return value === 'erc7710' || value === 'eip3009'
}

// ── Display locale (#1550) ───────────────────────────────────────────────────
// English is the demo default — this merchant is Haven's own showcase and its
// transcripts are read mostly by English-speaking developers. Swedish stays a
// first-class option. #4980: the invoice JSON's human-readable values follow
// this switch too; its keys and codes never do (see invoice.ts).

export const MERCHANT_LOCALES = ['en', 'sv'] as const
export type MerchantLocale = (typeof MERCHANT_LOCALES)[number]
export const DEFAULT_MERCHANT_LOCALE: MerchantLocale = 'en'

export function isMerchantLocale(value: unknown): value is MerchantLocale {
  return value === 'en' || value === 'sv'
}

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
const PHILIP_PRODUCT_VALUES = ['vpn', 'storage', 'spoof'] as const

interface ProductToolArgs {
  toolName: 'buy_vpn' | 'buy_cloud_storage' | 'buy_joke' | 'buy_field_notes' | 'buy_philip'
  /** #4851: absent for a tool that sells exactly one product (`buy_joke`, `buy_field_notes`). */
  argumentName?: 'plan' | 'tier' | 'product'
  argumentValue?: string
  argumentEnum?: readonly string[]
}

/** Derives the exact buy-tool call (tool name + fixed argument) for a product. */
export function productToolArgs(product: Product): ProductToolArgs {
  if (product.category === 'joke') return { toolName: 'buy_joke' }
  if (product.category === 'field_notes') return { toolName: 'buy_field_notes' }
  if (product.category === 'philip') {
    return {
      toolName: 'buy_philip',
      argumentName: 'product',
      argumentValue: product.id.slice('philip_'.length),
      argumentEnum: PHILIP_PRODUCT_VALUES,
    }
  }
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
  if (!argumentName || !argumentEnum) {
    // #4851: a one-product tool (`buy_joke`) takes no selector, and its one
    // settlement method needs no override — the schema says so exactly.
    return { type: 'object', properties: {}, required: [], additionalProperties: false }
  }
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

export type BillingPeriod = 'monthly' | 'one_time'

// ── QA fixture marker (#2989) ────────────────────────────────────────────────
// The verify-without-settle QA hook (`MERCHANT_SKIP_SETTLE_PRODUCT`, see
// x402.ts `isSkipSettleProduct`) makes ONE product hand out goods without ever
// settling on-chain. Before this, `list_products`, the 402 challenge, and the
// discovery document all presented that product exactly like one that
// settles — an agent had no way to know the outcome was by design (quality
// scan finding B6). This is the one shared shape all three surfaces attach,
// so they can never describe the same fixture two different ways.
export interface QaFixtureMetadata {
  kind: 'skip_settle'
  settles_on_chain: false
}

export const SKIP_SETTLE_QA_FIXTURE: QaFixtureMetadata = { kind: 'skip_settle', settles_on_chain: false }

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
  /**
   * #2989: present ONLY for a product configured via
   * `MERCHANT_SKIP_SETTLE_PRODUCT` (testnet-only, see x402.ts
   * `isSkipSettleProduct`) — ABSENT, not `null` or `undefined`-valued, on
   * every other product and on every other chain, so the prod metadata shape
   * is byte-identical to before this field existed.
   */
  qa_fixture?: QaFixtureMetadata
}

export function buildProductMetadata(
  product: Product,
  opts: {
    enabledSettlementMethods: readonly SettlementMethod[]
    mcpUrl: string
    chainId?: number
    /** #2989: true only for the product(s) named by `MERCHANT_SKIP_SETTLE_PRODUCT`
     *  on Base Sepolia. The caller decides this (`isSkipSettleProduct`) — this
     *  module has no env/chain access of its own to re-derive it. */
    qaFixture?: boolean
  },
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
    billing_period: productBillingPeriod(product),
    tool_name: productToolArgs(product).toolName,
    arguments_schema: productArgumentsSchema(product),
    supported_settlement_methods: supportedSettlementMethods,
    default_settlement_method: defaultSettlementMethod,
    mcp_url: opts.mcpUrl,
    environment: merchantEnvironmentForChain(chainId),
    display: {
      price_formatted: `$${formatUsdc(product.price_usdc)} USDC`,
    },
    ...(opts.qaFixture ? { qa_fixture: SKIP_SETTLE_QA_FIXTURE } : {}),
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
