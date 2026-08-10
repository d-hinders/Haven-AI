import { createDemoMerchantServer } from './http.js'
import { createViemSettlementClient, createX402PaymentProcessor } from './x402.js'
import {
  DEFAULT_SETTLEMENT_METHOD,
  PRODUCTS,
  SUPPORTED_SETTLEMENT_METHODS,
  formatUsdc,
  CHAIN_ID,
  hostedMerchantBaseUrlForChain,
  isSettlementMethod,
  merchantEnvironmentForChain,
  type SettlementMethod,
} from './products.js'
import { isAddress, type Address } from 'viem'

const PORT = parseInt(process.env.PORT ?? '3456', 10)
const MERCHANT_ENVIRONMENT = merchantEnvironmentForChain(CHAIN_ID)
const HOSTED_DEMO_URL = hostedMerchantBaseUrlForChain(CHAIN_ID)
const IS_HOSTED_RUNTIME = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.NODE_ENV === 'production')
const BASE_URL = process.env.BASE_URL ?? (IS_HOSTED_RUNTIME ? HOSTED_DEMO_URL : `http://localhost:${PORT}`)
if (IS_HOSTED_RUNTIME && BASE_URL.includes('localhost')) {
  console.error(
    'BASE_URL must be a public URL for hosted demo merchant deployments.\n' +
      `For ${MERCHANT_ENVIRONMENT} on eip155:${CHAIN_ID}, use ${HOSTED_DEMO_URL}. ` +
      'Localhost is only valid when intentionally running a local merchant.',
  )
  process.exit(1)
}

const SETTLEMENT_METHODS = parseSettlementMethods(process.env.MERCHANT_X402_SETTLEMENT_METHODS)
const DEFAULT_METHOD = SETTLEMENT_METHODS.includes(DEFAULT_SETTLEMENT_METHOD)
  ? DEFAULT_SETTLEMENT_METHOD
  : SETTLEMENT_METHODS[0]

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

const ERC7710_ENABLED = SETTLEMENT_METHODS.includes('erc7710')
const ERC7710_DELEGATION_MANAGER = process.env.MERCHANT_ERC7710_DELEGATION_MANAGER as Address | undefined
if (ERC7710_ENABLED && (!ERC7710_DELEGATION_MANAGER || !isAddress(ERC7710_DELEGATION_MANAGER))) {
  console.error(
    'MERCHANT_ERC7710_DELEGATION_MANAGER env var is required when ERC-7710 settlement is enabled.\n' +
      'Set it to the ONLY DelegationManager contract address this merchant trusts (e.g. the ' +
      'MetaMask Delegation Framework DelegationManager on the configured Base environment). Payments naming any ' +
      'other delegationManager are rejected.',
  )
  process.exit(1)
}

const paymentProcessor = createX402PaymentProcessor(
  createViemSettlementClient({
    baseRpcUrl: BASE_RPC_URL,
    settlementPrivateKey: SETTLEMENT_PRIVATE_KEY,
  }),
  ERC7710_ENABLED && ERC7710_DELEGATION_MANAGER
    ? { erc7710: { delegationManager: ERC7710_DELEGATION_MANAGER }, settlementMethods: SETTLEMENT_METHODS }
    : { settlementMethods: SETTLEMENT_METHODS },
)

const server = createDemoMerchantServer({
  merchantAddress: MERCHANT_ADDRESS,
  baseUrl: BASE_URL,
  paymentProcessor,
  settlementMethods: SETTLEMENT_METHODS,
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

function parseSettlementMethods(raw: string | undefined): SettlementMethod[] {
  if (!raw) return [...SUPPORTED_SETTLEMENT_METHODS]
  const methods = raw.split(',').map((method) => method.trim()).filter(Boolean)
  if (methods.length === 0) return [...SUPPORTED_SETTLEMENT_METHODS]
  const invalid = methods.find((method) => !isSettlementMethod(method))
  if (invalid) {
    console.error(`Unsupported MERCHANT_X402_SETTLEMENT_METHODS value: ${invalid}. Use erc7710,eip3009.`)
    process.exit(1)
  }
  return [...new Set(methods)] as SettlementMethod[]
}
