import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PRODUCTS, formatUsdc, type ProductId } from './products.js'
import { generateInvoice, nextInvoiceNumber } from './invoice.js'
import { buildPaymentRequired, type SettledPayment } from './x402.js'
import type { Address } from 'viem'

export interface PaymentContext {
  currentPayment?: SettledPayment
}

export interface MerchantConfig {
  merchantAddress: Address
  baseUrl: string
  paymentContext: PaymentContext
}

const completedPurchases = new WeakMap<SettledPayment, string>()

/** Build the demo merchant MCP server. */
export function buildMerchantMcpServer(config: MerchantConfig): McpServer {
  const server = new McpServer({
    name: 'haven-demo-merchant',
    version: '0.1.0',
  })

  // ── list_products ──────────────────────────────────────────────────────────
  server.tool(
    'list_products',
    'Lista alla tillgängliga produkter med priser (USDC). Kräver ingen betalning.',
    {},
    async () => {
      const rows = Object.values(PRODUCTS).map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        price_usdc: formatUsdc(p.price_usdc),
        description: p.description,
      }))

      const text = rows
        .map(
          (r) =>
            `[${r.id}] ${r.name}\n  Pris: $${r.price_usdc} USDC/månad\n  ${r.description}`,
        )
        .join('\n\n')

      return {
        content: [
          {
            type: 'text',
            text: `Tillgängliga produkter:\n\n${text}\n\nAnvänd buy_vpn eller buy_cloud_storage för att köpa. Betalning sker via x402 (USDC på Base).`,
          },
        ],
      }
    },
  )

  // ── buy_vpn ────────────────────────────────────────────────────────────────
  server.tool(
    'buy_vpn',
    'Köp ett NordShield VPN-abonnemang. Betalning via x402 (USDC på Base). ' +
      'Kräver giltig PAYMENT-SIGNATURE eller X-PAYMENT header med EIP-3009 auktorisering.',
    {
      plan: z.enum(['basic', 'pro', 'ultra']).describe('VPN-plan att köpa'),
    },
    async ({ plan }) => {
      const productId = `vpn_${plan}` as ProductId
      return completePurchase(config, productId, `${PRODUCTS[productId].name} — 1 månads abonnemang`)
    },
  )

  // ── buy_cloud_storage ──────────────────────────────────────────────────────
  server.tool(
    'buy_cloud_storage',
    'Köp CloudNest molnlagring. Betalning via x402 (USDC på Base). ' +
      'Kräver giltig PAYMENT-SIGNATURE eller X-PAYMENT header med EIP-3009 auktorisering.',
    {
      tier: z.enum(['50gb', '200gb', '1tb']).describe('Lagringskapacitet att köpa'),
    },
    async ({ tier }) => {
      const productId = `storage_${tier}` as ProductId
      return completePurchase(config, productId, `${PRODUCTS[productId].name} — 1 månads lagring`)
    },
  )

  return server
}

function completePurchase(config: MerchantConfig, productId: ProductId, description: string) {
  const product = PRODUCTS[productId]
  const resource = `${config.baseUrl}/mcp`
  const payment = config.paymentContext.currentPayment

  if (!payment || payment.productId !== productId) {
    const requirements = buildPaymentRequired({
      merchantAddress: config.merchantAddress,
      amountUsdc: product.price_usdc,
      resource,
      description,
    })
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text:
            `Betalning krävs för ${product.name}.\n\n` +
            `Pris: $${formatUsdc(product.price_usdc)} USDC (inkl. 25% moms)\n` +
            `Betalningsadress: ${config.merchantAddress}\n` +
            `Nätverk: Base (chain ID 8453)\n\n` +
            `x402 betalningskrav:\n${JSON.stringify(requirements, null, 2)}\n\n` +
            `Skicka om samma HTTP-anrop med PAYMENT-SIGNATURE eller X-PAYMENT header.`,
        },
      ],
    }
  }

  const cachedText = completedPurchases.get(payment)
  if (cachedText) {
    return { content: [{ type: 'text' as const, text: cachedText }] }
  }

  const invoiceNumber = nextInvoiceNumber()
  const invoice = generateInvoice({
    invoiceNumber,
    productId,
    buyerAddress: payment.from,
    authorizationNonce: payment.nonce,
    txHash: payment.txHash,
  })

  const text =
    `✅ Köp bekräftat!\n\n` +
    `Produkt:  ${product.name}\n` +
    `Betalat:  $${formatUsdc(payment.value)} USDC\n` +
    `Från:     ${payment.from}\n` +
    `Tx:       ${payment.txHash}\n` +
    `Nonce:    ${payment.nonce}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    invoice.text +
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Fakturadetaljerna som JSON (för bokföring):\n` +
    JSON.stringify(invoice.json, null, 2)

  completedPurchases.set(payment, text)
  return { content: [{ type: 'text' as const, text }] }
}
