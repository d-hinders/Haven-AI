import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PRODUCTS, formatUsdc, type ProductId } from './products.js'
import { generateInvoice, nextInvoiceNumber } from './invoice.js'
import { verifyXPayment, buildPaymentRequired, PaymentError, type VerifiedPayment } from './x402.js'
import type { Address } from 'viem'

export interface MerchantConfig {
  merchantAddress: Address
  baseUrl: string
  /**
   * Payment already verified by the HTTP-layer x402 middleware.
   * When set, tool handlers skip their own `verifyXPayment` call —
   * the nonce was already consumed and a second call would fail as replay.
   */
  preVerifiedPayment?: VerifiedPayment & { productId: ProductId }
}

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
      'Kräver giltig X-PAYMENT header med EIP-3009 auktorisering.',
    {
      plan: z.enum(['basic', 'pro', 'ultra']).describe('VPN-plan att köpa'),
      x_payment: z
        .string()
        .optional()
        .describe(
          'Base64-kodad X-PAYMENT header (x402 EIP-3009). Utelämna för att se prisinformation.',
        ),
    },
    async ({ plan, x_payment }) => {
      const productId = `vpn_${plan}` as ProductId
      const product = PRODUCTS[productId]
      const resource = `${config.baseUrl}/mcp`

      // Resolve payment: prefer HTTP-layer pre-verified result (nonce already consumed),
      // fall back to tool-argument verification for clients that don't support HTTP 402.
      let payment: VerifiedPayment | undefined =
        config.preVerifiedPayment?.productId === productId
          ? config.preVerifiedPayment
          : undefined

      if (!payment) {
        if (!x_payment) {
          const requirements = buildPaymentRequired({
            merchantAddress: config.merchantAddress,
            amountUsdc: product.price_usdc,
            resource,
            description: `${product.name} — 1 månads abonnemang`,
          })
          return {
            content: [
              {
                type: 'text',
                text:
                  `Betalning krävs för ${product.name}.\n\n` +
                  `Pris: $${formatUsdc(product.price_usdc)} USDC (inkl. 25% moms)\n` +
                  `Betalningsadress: ${config.merchantAddress}\n` +
                  `Nätverk: Base (chain ID 8453)\n\n` +
                  `x402 betalningskrav:\n${JSON.stringify(requirements, null, 2)}\n\n` +
                  `Skicka om anropet med x_payment-parametern ifylld med din X-PAYMENT header.`,
              },
            ],
          }
        }

        try {
          payment = await verifyXPayment(x_payment, config.merchantAddress, product.price_usdc)
        } catch (err) {
          const msg = err instanceof PaymentError ? err.message : 'Betalningsfel'
          return {
            isError: true,
            content: [{ type: 'text', text: `Betalningsfel: ${msg}` }],
          }
        }
      }

      // Generate invoice
      const invoiceNumber = nextInvoiceNumber()
      const invoice = generateInvoice({
        invoiceNumber,
        productId,
        buyerAddress: payment.from,
        authorizationNonce: payment.nonce,
      })

      return {
        content: [
          {
            type: 'text',
            text:
              `✅ Köp bekräftat!\n\n` +
              `Produkt:  ${product.name}\n` +
              `Betalat:  $${formatUsdc(payment.value)} USDC\n` +
              `Från:     ${payment.from}\n` +
              `Nonce:    ${payment.nonce}\n\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
              invoice.text +
              `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
              `Fakturadetaljerna som JSON (för bokföring):\n` +
              JSON.stringify(invoice.json, null, 2),
          },
        ],
      }
    },
  )

  // ── buy_cloud_storage ──────────────────────────────────────────────────────
  server.tool(
    'buy_cloud_storage',
    'Köp CloudNest molnlagring. Betalning via x402 (USDC på Base). ' +
      'Kräver giltig X-PAYMENT header med EIP-3009 auktorisering.',
    {
      tier: z.enum(['50gb', '200gb', '1tb']).describe('Lagringskapacitet att köpa'),
      x_payment: z
        .string()
        .optional()
        .describe(
          'Base64-kodad X-PAYMENT header (x402 EIP-3009). Utelämna för att se prisinformation.',
        ),
    },
    async ({ tier, x_payment }) => {
      const productId = `storage_${tier}` as ProductId
      const product = PRODUCTS[productId]
      const resource = `${config.baseUrl}/mcp`

      // Resolve payment: prefer HTTP-layer pre-verified result, fall back to tool-argument path.
      let payment: VerifiedPayment | undefined =
        config.preVerifiedPayment?.productId === productId
          ? config.preVerifiedPayment
          : undefined

      if (!payment) {
        if (!x_payment) {
          const requirements = buildPaymentRequired({
            merchantAddress: config.merchantAddress,
            amountUsdc: product.price_usdc,
            resource,
            description: `${product.name} — 1 månads lagring`,
          })
          return {
            content: [
              {
                type: 'text',
                text:
                  `Betalning krävs för ${product.name}.\n\n` +
                  `Pris: $${formatUsdc(product.price_usdc)} USDC (inkl. 25% moms)\n` +
                  `Betalningsadress: ${config.merchantAddress}\n` +
                  `Nätverk: Base (chain ID 8453)\n\n` +
                  `x402 betalningskrav:\n${JSON.stringify(requirements, null, 2)}\n\n` +
                  `Skicka om anropet med x_payment-parametern ifylld med din X-PAYMENT header.`,
              },
            ],
          }
        }

        try {
          payment = await verifyXPayment(x_payment, config.merchantAddress, product.price_usdc)
        } catch (err) {
          const msg = err instanceof PaymentError ? err.message : 'Betalningsfel'
          return {
            isError: true,
            content: [{ type: 'text', text: `Betalningsfel: ${msg}` }],
          }
        }
      }

      // Generate invoice
      const invoiceNumber = nextInvoiceNumber()
      const invoice = generateInvoice({
        invoiceNumber,
        productId,
        buyerAddress: payment.from,
        authorizationNonce: payment.nonce,
      })

      return {
        content: [
          {
            type: 'text',
            text:
              `✅ Köp bekräftat!\n\n` +
              `Produkt:  ${product.name}\n` +
              `Betalat:  $${formatUsdc(payment.value)} USDC\n` +
              `Från:     ${payment.from}\n` +
              `Nonce:    ${payment.nonce}\n\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
              invoice.text +
              `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
              `Fakturadetaljerna som JSON (för bokföring):\n` +
              JSON.stringify(invoice.json, null, 2),
          },
        ],
      }
    },
  )

  return server
}
