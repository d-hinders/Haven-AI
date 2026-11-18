import { createDemoMerchantServer } from './http.js'
import { createViemSettlementClient, createX402PaymentProcessor } from './x402.js'
import type { PassportVerifierConfig } from './x402.js'
import {
  createCdpChainReader,
  createCdpFacilitator,
  createViemChainReadClient,
  resolveCdpCredentials,
  type CdpSettlementConfig,
} from './cdp.js'
import {
  DEFAULT_SETTLEMENT_METHOD,
  PRODUCTS,
  SUPPORTED_SETTLEMENT_METHODS,
  offeredProducts,
  productSettlementKind,
  formatUsdc,
  CHAIN_ID,
  networkLogLabel,
  TRUSTED_DELEGATION_MANAGER,
  TRUSTED_ERC20_TRANSFER_AMOUNT_ENFORCER,
  hostedMerchantBaseUrlForChain,
  isSettlementMethod,
  isTrustedDelegationManagerForChain,
  merchantEnvironmentForChain,
  type SettlementMethod,
} from './products.js'
import { type Address } from 'viem'
import { LogWindows, parseMaxBlockRange } from '@haven_ai/merchant-payments'
import { createStripeRecording, resolveStripeConfig } from './stripe.js'
import { DEMO_SELLER, resolveReceiptSeller } from './invoice.js'
import { createSekRateFeed, SEK_RATE_SOURCE } from './sek-rate.js'
import { createSalesReporting, resolveSalesConfig } from './sales.js'

const PORT = parseInt(process.env.PORT ?? '3456', 10)
const MERCHANT_ENVIRONMENT = merchantEnvironmentForChain(CHAIN_ID)
const HOSTED_DEMO_URL = hostedMerchantBaseUrlForChain(CHAIN_ID)
const IS_HOSTED_RUNTIME = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.NODE_ENV === 'production')
const BASE_URL = resolveBaseUrl(process.env.BASE_URL)

// #4723: the passport check is opt-in and needs BOTH values. With either
// missing the merchant advertises only `haven-demo`, exactly as before — the
// no-env case is pinned by a test, not left to the code's own constant.
const PASSPORT_CONFIG = resolvePassportConfig(
  process.env.MERCHANT_HAVEN_BASE_URL,
  process.env.MERCHANT_PASSPORT_ISSUER,
)

/**
 * #4723: resolve the passport verifier config from env.
 *
 * Both values are required together. A half-configured merchant is a mistake
 * worth a warning, but not a reason to refuse payments: the check is advisory,
 * so a bad value disables it rather than taking the merchant down.
 */
function resolvePassportConfig(
  baseUrlRaw: string | undefined,
  issuerRaw: string | undefined,
): PassportVerifierConfig | undefined {
  const baseUrl = baseUrlRaw?.trim()
  const issuer = issuerRaw?.trim()
  if (!baseUrl || !issuer) {
    if (baseUrl || issuer) {
      console.warn(
        'Passport checking is disabled: set BOTH MERCHANT_HAVEN_BASE_URL and MERCHANT_PASSPORT_ISSUER. ' +
          'The merchant advertises only haven-demo until both are set.',
      )
    }
    return undefined
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(issuer)) {
    console.warn(
      'MERCHANT_PASSPORT_ISSUER is not a 0x-prefixed 20-byte address. Passport checking is disabled.',
    )
    return undefined
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    console.warn('MERCHANT_HAVEN_BASE_URL is not a valid URL. Passport checking is disabled.')
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.warn('MERCHANT_HAVEN_BASE_URL must be http(s). Passport checking is disabled.')
    return undefined
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), issuer }
}

const REQUESTED_SETTLEMENT_METHODS = parseSettlementMethods(process.env.MERCHANT_X402_SETTLEMENT_METHODS)
const ERC7710_CONFIG = resolveErc7710Config(REQUESTED_SETTLEMENT_METHODS)
const SETTLEMENT_METHODS = effectiveSettlementMethods(REQUESTED_SETTLEMENT_METHODS, Boolean(ERC7710_CONFIG))
const DEFAULT_METHOD = SETTLEMENT_METHODS.includes(DEFAULT_SETTLEMENT_METHOD)
  ? DEFAULT_SETTLEMENT_METHOD
  : SETTLEMENT_METHODS[0]

function resolveBaseUrl(raw: string | undefined): string {
  if (!raw) return IS_HOSTED_RUNTIME ? HOSTED_DEMO_URL : `http://localhost:${PORT}`
  if (IS_HOSTED_RUNTIME && raw.includes('localhost')) {
    console.warn(
      'Ignoring localhost BASE_URL for hosted demo merchant deployment.\n' +
        `Using ${HOSTED_DEMO_URL} for ${MERCHANT_ENVIRONMENT} on eip155:${CHAIN_ID} instead.`,
    )
    return HOSTED_DEMO_URL
  }
  return raw
}

function resolveErc7710Config(
  requestedMethods: readonly SettlementMethod[] | undefined,
): { delegationManager: Address; erc20TransferAmountEnforcer: Address } | undefined {
  const raw = process.env.MERCHANT_ERC7710_DELEGATION_MANAGER
  const explicitlyRequested = requestedMethods?.includes('erc7710') ?? false
  if (!raw) {
    if (explicitlyRequested) {
      console.warn(
        'ERC-7710 settlement was requested but MERCHANT_ERC7710_DELEGATION_MANAGER is not set. ' +
          'Starting with EIP-3009 only; explicit erc7710 purchases will be refused.',
      )
    }
    return undefined
  }
  if (!isTrustedDelegationManagerForChain(raw, CHAIN_ID)) {
    console.warn(
      'MERCHANT_ERC7710_DELEGATION_MANAGER does not match the pinned Haven DelegationManager for this chain. ' +
        `Expected ${TRUSTED_DELEGATION_MANAGER} for eip155:${CHAIN_ID}. ` +
        'Starting with EIP-3009 only; explicit erc7710 purchases will be refused.',
    )
    return undefined
  }
  return {
    delegationManager: TRUSTED_DELEGATION_MANAGER,
    erc20TransferAmountEnforcer: TRUSTED_ERC20_TRANSFER_AMOUNT_ENFORCER,
  }
}

function effectiveSettlementMethods(
  requestedMethods: readonly SettlementMethod[] | undefined,
  erc7710Configured: boolean,
): SettlementMethod[] {
  const requested = requestedMethods ?? (erc7710Configured ? SUPPORTED_SETTLEMENT_METHODS : ['eip3009'])
  const methods = erc7710Configured ? requested : requested.filter((method) => method !== 'erc7710')
  if (methods.length === 0) {
    console.warn(
      'No configured x402 settlement methods are usable. Falling back to EIP-3009 so the merchant can keep serving existing clients.',
    )
    return ['eip3009']
  }
  return [...new Set(methods)]
}

if (REQUESTED_SETTLEMENT_METHODS?.includes('erc7710') && !ERC7710_CONFIG) {
  console.warn(
    'ERC-7710 is omitted from advertised x402 accepts until the pinned DelegationManager is configured.',
  )
}

const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS as Address | undefined
if (!MERCHANT_ADDRESS) {
  console.error(
    'MERCHANT_ADDRESS env var is required.\n' +
      'Set it to the Base wallet address that will receive USDC payments.',
  )
  process.exit(1)
}

const BASE_RPC_URL = process.env.BASE_RPC_URL
if (!BASE_RPC_URL) {
  console.error(
    'BASE_RPC_URL env var is required.\n' +
      'Set it to a Base RPC URL (Base mainnet, or Base Sepolia when MERCHANT_CHAIN_ID=84532) ' +
      'used to submit and confirm USDC settlement transactions.',
  )
  process.exit(1)
}

const SETTLEMENT_PRIVATE_KEY = process.env.SETTLEMENT_PRIVATE_KEY as `0x${string}` | undefined
if (!SETTLEMENT_PRIVATE_KEY) {
  console.error(
    'SETTLEMENT_PRIVATE_KEY env var is required.\n' +
      'Set it to the gas-funded Base key that submits USDC transferWithAuthorization transactions. ' +
      'It does not need to be the receiving wallet.',
  )
  process.exit(1)
}

// #4851: Coinbase's hosted facilitator, for the joke product only. Off unless
// BOTH variables are set; a half-set pair warns and stays off (never a refusal
// to start). The secret goes to the Coinbase client constructor and nowhere else.
const CDP_CREDENTIALS = resolveCdpCredentials(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)
let CDP_CONFIG: CdpSettlementConfig | undefined
if (CDP_CREDENTIALS) {
  try {
    CDP_CONFIG = {
      facilitator: await createCdpFacilitator(CDP_CREDENTIALS),
      // #4866: the recovery search reads in windows the RPC serves — narrowed
      // by ETH_GETLOGS_MAX_BLOCK_RANGE and by the provider's own refusal.
      chain: createCdpChainReader(
        createViemChainReadClient(BASE_RPC_URL),
        new LogWindows({ maxSpan: parseMaxBlockRange(process.env.ETH_GETLOGS_MAX_BLOCK_RANGE) }),
      ),
    }
  } catch (err) {
    // The class only: an SDK error message is not ours to print next to a key.
    console.warn(
      `Coinbase facilitator (CDP) client could not be built (${err instanceof Error ? err.name : 'UnknownError'}). ` +
        'The CDP-settled joke product is not offered; every other product is unaffected.',
    )
  }
}

// #1530: held in a local so `/healthz` can ask the same client that settles.
// Checking a DIFFERENT client's balance would report on a wallet that is not
// the one paying, which is the class of near-miss this whole issue is about.
const settlementClient = createViemSettlementClient({
  baseRpcUrl: BASE_RPC_URL,
  settlementPrivateKey: SETTLEMENT_PRIVATE_KEY,
})

// #4853: Stripe recording for the joke product. Off unless BOTH variables are
// set, CDP is configured, and the joke's price is a whole number of cents; a
// half-set or unusable configuration warns and stays off (never a refusal to
// start). The secret goes to the Stripe client and nowhere else, and nothing
// here logs it.
const STRIPE_CONFIG = resolveStripeConfig({
  depositAddressRaw: process.env.STRIPE_DEPOSIT_ADDRESS,
  secretKeyRaw: process.env.STRIPE_SECRET_KEY,
  previousDepositAddressRaw: process.env.STRIPE_PREVIOUS_DEPOSIT_ADDRESS,
  cdpConfigured: Boolean(CDP_CONFIG),
  priceAtomic: PRODUCTS.joke.price_usdc,
})
const STRIPE_RECORDING = STRIPE_CONFIG ? createStripeRecording(STRIPE_CONFIG) : undefined

// #4950, #4953: the Haven Sales key and its sale reporter. Reporting is on with
// MERCHANT_SALES_KEY and MERCHANT_HAVEN_BASE_URL: the Stripe-settled joke
// (which also needs Stripe) reports, and with a usable MERCHANT_SALES_ADDRESS
// the Sales product (`field_notes`) is offered and reports too. Unset or
// unusable settings warn and stay off (never a refusal to start). The key goes
// to the core reporter and nowhere else.
const SALES_CONFIG = resolveSalesConfig({
  addressRaw: process.env.MERCHANT_SALES_ADDRESS,
  keyRaw: process.env.MERCHANT_SALES_KEY,
  havenBaseUrlRaw: process.env.MERCHANT_HAVEN_BASE_URL,
  merchantAddress: MERCHANT_ADDRESS,
  stripeDepositAddresses: [process.env.STRIPE_DEPOSIT_ADDRESS, process.env.STRIPE_PREVIOUS_DEPOSIT_ADDRESS],
})
const SALES_REPORTING = SALES_CONFIG ? createSalesReporting(SALES_CONFIG, { chainId: CHAIN_ID }) : undefined

// #4856: the seller on every receipt. With no MERCHANT_SELLER_* set, the demo
// seller, so the receipt is unchanged.
const RECEIPT_SELLER = resolveReceiptSeller(process.env)

// #4856: the USDC→SEK rate the Stripe-recorded product's receipt states. Kept
// warm in the background and only read on the purchase path, so it never
// delays a purchase; started only when Stripe recording is on, since no other
// receipt shows a SEK amount.
const SEK_RATE_FEED = STRIPE_RECORDING ? createSekRateFeed() : undefined
SEK_RATE_FEED?.start()

// #4853: a deposit address this merchant quoted before the current one, and
// still honours for a payment that already settled to it. Operator-supplied —
// the payment's own `payTo` is attacker-chosen and cannot be the test.
const PREVIOUS_RECEIVING_ADDRESSES = STRIPE_CONFIG?.previousDepositAddress
  ? [STRIPE_CONFIG.previousDepositAddress]
  : undefined

const paymentProcessor = createX402PaymentProcessor(settlementClient, {
  ...(ERC7710_CONFIG ? { erc7710: ERC7710_CONFIG } : {}),
  settlementMethods: SETTLEMENT_METHODS,
  passport: PASSPORT_CONFIG,
  cdp: CDP_CONFIG,
  ...(PREVIOUS_RECEIVING_ADDRESSES ? { previousReceivingAddresses: PREVIOUS_RECEIVING_ADDRESSES } : {}),
})

const server = createDemoMerchantServer({
  merchantAddress: MERCHANT_ADDRESS,
  baseUrl: BASE_URL,
  paymentProcessor,
  settlementMethods: SETTLEMENT_METHODS,
  settlementClient,
  passport: PASSPORT_CONFIG,
  cdpConfigured: Boolean(CDP_CONFIG),
  stripe: STRIPE_RECORDING,
  sales: SALES_REPORTING,
  receiptSeller: RECEIPT_SELLER,
  sekRate: SEK_RATE_FEED,
})

/** #4950, #4953: which products report, truthfully. Names no key. */
function salesStartupLine(): string {
  if (!SALES_REPORTING || !SALES_CONFIG) {
    return '  Sales:     not reporting (MERCHANT_SALES_KEY / MERCHANT_HAVEN_BASE_URL unset or unusable) — field_notes not offered'
  }
  const reporting: string[] = []
  if (STRIPE_RECORDING) reporting.push('joke (Stripe-settled)')
  if (SALES_REPORTING.address) {
    reporting.push(`field_notes $${formatUsdc(PRODUCTS.field_notes.price_usdc)} paid into ${SALES_REPORTING.address}`)
  }
  return (
    `  Sales:     ${reporting.length > 0 ? `reporting ${reporting.join('; ')}` : 'no product reports (Stripe not configured)'} to ${SALES_CONFIG.havenBaseUrl}` +
    (SALES_REPORTING.address ? '' : ' — field_notes not offered (MERCHANT_SALES_ADDRESS unset or unusable)')
  )
}

server.listen(PORT, () => {
  console.log(`Haven Demo Merchant MCP server`)
  console.log(`  Endpoint:  ${BASE_URL}/mcp`)
  console.log(`  Directory: ${BASE_URL}/`)
  console.log(`  Healthz:   ${BASE_URL}/healthz`)
  console.log(`  Env:       ${MERCHANT_ENVIRONMENT}`)
  console.log(`  Merchant:  ${MERCHANT_ADDRESS}`)
  console.log(`  Network:   eip155:${CHAIN_ID}${networkLogLabel(CHAIN_ID) ? ` (${networkLogLabel(CHAIN_ID)})` : ''}`)
  console.log(`  Payment:   USDC via x402 ${SETTLEMENT_METHODS.join(' + ')} (default ${DEFAULT_METHOD})`)
  console.log(
    PASSPORT_CONFIG
      ? `  Passport:  standing checked against ${PASSPORT_CONFIG.baseUrl} (issuer ${PASSPORT_CONFIG.issuer})`
      : '  Passport:  not advertised (MERCHANT_HAVEN_BASE_URL / MERCHANT_PASSPORT_ISSUER unset)',
  )
  // #4851: names the product and the fact, never a credential.
  const cdpProducts = offeredProducts({ cdpConfigured: true })
    .filter((product) => productSettlementKind(product) === 'cdp')
    .map((product) => `${product.id} $${formatUsdc(product.price_usdc)}`)
    .join(', ')
  console.log(
    CDP_CONFIG
      ? `  CDP:       configured — ${cdpProducts} verified and settled by Coinbase's facilitator`
      : '  CDP:       not configured (CDP_API_KEY_ID / CDP_API_KEY_SECRET unset) — joke product not offered',
  )
  // #4853: names the deposit address (public) and the API version, never the key.
  console.log(
    STRIPE_RECORDING
      ? `  Stripe:    recording the joke to deposit address ${STRIPE_RECORDING.depositAddress} ` +
          `(${STRIPE_RECORDING.network}, ${STRIPE_RECORDING.apiVersion})` +
          (STRIPE_RECORDING.previousDepositAddress
            ? `; still honouring settled payments to ${STRIPE_RECORDING.previousDepositAddress}`
            : '')
      : '  Stripe:    not configured — the joke is paid to MERCHANT_ADDRESS',
  )
  console.log(salesStartupLine())
  // #4856: the seller every receipt carries, and where the joke receipt's
  // SEK rate comes from. Names no credential.
  console.log(
    RECEIPT_SELLER === DEMO_SELLER
      ? `  Seller:    ${RECEIPT_SELLER.name} (demo seller; MERCHANT_SELLER_* unset)`
      : `  Seller:    ${RECEIPT_SELLER.name} (${RECEIPT_SELLER.org_nr}, from MERCHANT_SELLER_*)`,
  )
  if (SEK_RATE_FEED) console.log(`  SEK rate:  ${SEK_RATE_SOURCE}, refreshed in the background; never awaited`)
  console.log()
  console.log(
    `Products: vpn_basic $${formatUsdc(PRODUCTS.vpn_basic.price_usdc)} | ` +
      `vpn_pro $${formatUsdc(PRODUCTS.vpn_pro.price_usdc)} | ` +
      `vpn_ultra $${formatUsdc(PRODUCTS.vpn_ultra.price_usdc)}`,
  )
  console.log(
    `          storage_50gb $${formatUsdc(PRODUCTS.storage_50gb.price_usdc)} | ` +
      `storage_200gb $${formatUsdc(PRODUCTS.storage_200gb.price_usdc)} | ` +
      `storage_1tb $${formatUsdc(PRODUCTS.storage_1tb.price_usdc)}`,
  )
})

process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())

function parseSettlementMethods(raw: string | undefined): SettlementMethod[] | undefined {
  if (!raw) return undefined
  const methods = raw.split(',').map((method) => method.trim()).filter(Boolean)
  if (methods.length === 0) return undefined
  const invalid = methods.find((method) => !isSettlementMethod(method))
  if (invalid) {
    console.error(`Unsupported MERCHANT_X402_SETTLEMENT_METHODS value: ${invalid}. Use eip3009,erc7710.`)
    process.exit(1)
  }
  return [...new Set(methods)] as SettlementMethod[]
}
