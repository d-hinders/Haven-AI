import { createDemoMerchantServer } from './http.js'
import { createViemSettlementClient, createX402PaymentProcessor } from './x402.js'
import { PRODUCTS, formatUsdc, CHAIN_ID } from './products.js'
import type { Address } from 'viem'

const PORT = parseInt(process.env.PORT ?? '3456', 10)
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`

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

// Experimental ERC-7710 rail (#747, epic #452) — testnet-only. Refuse to start
// rather than silently ignore the flag: mainnet must never advertise erc7710.
const ERC7710_ENABLED = ['1', 'true'].includes((process.env.MERCHANT_X402_ERC7710 ?? '').toLowerCase())
if (ERC7710_ENABLED && CHAIN_ID !== 84532) {
  console.error(
    'MERCHANT_X402_ERC7710 is experimental and testnet-only.\n' +
      `Set MERCHANT_CHAIN_ID=84532 (Base Sepolia) to enable it, or unset the flag. Got chain ${CHAIN_ID}.`,
  )
  process.exit(1)
}

const paymentProcessor = createX402PaymentProcessor(
  createViemSettlementClient({
    baseRpcUrl: BASE_RPC_URL,
    settlementPrivateKey: SETTLEMENT_PRIVATE_KEY,
  }),
  { erc7710: ERC7710_ENABLED },
)

const server = createDemoMerchantServer({
  merchantAddress: MERCHANT_ADDRESS,
  baseUrl: BASE_URL,
  paymentProcessor,
})

server.listen(PORT, () => {
  console.log(`Haven Demo Merchant MCP server`)
  console.log(`  Endpoint:  ${BASE_URL}/mcp`)
  console.log(`  Healthz:   ${BASE_URL}/healthz`)
  console.log(`  Merchant:  ${MERCHANT_ADDRESS}`)
  console.log(`  Network:   eip155:${CHAIN_ID}${CHAIN_ID === 84532 ? ' (Base Sepolia testnet)' : CHAIN_ID === 8453 ? ' (Base mainnet)' : ''}`)
  console.log(`  Payment:   USDC via x402 EIP-3009${ERC7710_ENABLED ? ' + experimental ERC-7710' : ''}`)
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
