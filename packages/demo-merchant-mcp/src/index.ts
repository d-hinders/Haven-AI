import { createDemoMerchantServer } from './http.js'
import { createViemSettlementClient, createX402PaymentProcessor } from './x402.js'
import {
  DEFAULT_SETTLEMENT_METHOD,
  PRODUCTS,
  SUPPORTED_SETTLEMENT_METHODS,
  formatUsdc,
  CHAIN_ID,
  TRUSTED_DELEGATION_MANAGER,
  hostedMerchantBaseUrlForChain,
  isSettlementMethod,
  isTrustedDelegationManagerForChain,
  merchantEnvironmentForChain,
  type SettlementMethod,
} from './products.js'
import { type Address } from 'viem'

const PORT = parseInt(process.env.PORT ?? '3456', 10)
const MERCHANT_ENVIRONMENT = merchantEnvironmentForChain(CHAIN_ID)
const HOSTED_DEMO_URL = hostedMerchantBaseUrlForChain(CHAIN_ID)
const IS_HOSTED_RUNTIME = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.NODE_ENV === 'production')
const BASE_URL = resolveBaseUrl(process.env.BASE_URL)

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

function resolveErc7710Config(requestedMethods: readonly SettlementMethod[] | undefined): { delegationManager: Address } | undefined {
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
  return { delegationManager: TRUSTED_DELEGATION_MANAGER }
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

// #1530: held in a local so `/healthz` can ask the same client that settles.
// Checking a DIFFERENT client's balance would report on a wallet that is not
// the one paying, which is the class of near-miss this whole issue is about.
const settlementClient = createViemSettlementClient({
  baseRpcUrl: BASE_RPC_URL,
  settlementPrivateKey: SETTLEMENT_PRIVATE_KEY,
})

const paymentProcessor = createX402PaymentProcessor(
  settlementClient,
  ERC7710_CONFIG
    ? { erc7710: ERC7710_CONFIG, settlementMethods: SETTLEMENT_METHODS }
    : { settlementMethods: SETTLEMENT_METHODS },
)

const server = createDemoMerchantServer({
  merchantAddress: MERCHANT_ADDRESS,
  baseUrl: BASE_URL,
  paymentProcessor,
  settlementMethods: SETTLEMENT_METHODS,
  settlementClient,
})

server.listen(PORT, () => {
  console.log(`Haven Demo Merchant MCP server`)
  console.log(`  Endpoint:  ${BASE_URL}/mcp`)
  console.log(`  Directory: ${BASE_URL}/`)
  console.log(`  Healthz:   ${BASE_URL}/healthz`)
  console.log(`  Env:       ${MERCHANT_ENVIRONMENT}`)
  console.log(`  Merchant:  ${MERCHANT_ADDRESS}`)
  console.log(`  Network:   eip155:${CHAIN_ID}${CHAIN_ID === 84532 ? ' (Base Sepolia testnet)' : CHAIN_ID === 8453 ? ' (Base mainnet)' : ''}`)
  console.log(`  Payment:   USDC via x402 ${SETTLEMENT_METHODS.join(' + ')} (default ${DEFAULT_METHOD})`)
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
