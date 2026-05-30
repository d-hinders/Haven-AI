import { createDemoMerchantServer } from './http.js'
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

const server = createDemoMerchantServer({
  merchantAddress: MERCHANT_ADDRESS,
  baseUrl: BASE_URL,
})

server.listen(PORT, () => {
  console.log(`Haven Demo Merchant MCP server`)
  console.log(`  Endpoint:  ${BASE_URL}/mcp`)
  console.log(`  Healthz:   ${BASE_URL}/healthz`)
  console.log(`  Merchant:  ${MERCHANT_ADDRESS}`)
  console.log(`  Network:   Base (chain ID 8453)`)
  console.log(`  Payment:   USDC via x402 EIP-3009`)
  console.log()
  console.log(`Products: vpn_basic $1.00 | vpn_pro $3.00 | vpn_ultra $5.00`)
  console.log(`          storage_50gb $0.50 | storage_200gb $1.50 | storage_1tb $4.00`)
})

process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())
