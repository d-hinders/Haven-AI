import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import {
  DEFAULT_SETTLEMENT_METHOD,
  PRODUCTS,
  SUPPORTED_SETTLEMENT_METHODS,
  CHAIN_ID,
  HOSTED_DEMO_MERCHANT_URLS,
  formatUsdc,
  type ProductId,
  type SettlementMethod,
} from './products.js'
import { invoiceForPayment } from './invoice.js'
import type { SettledPayment, X402PaymentProcessor } from './x402.js'
import type { Address } from 'viem'

const paymentStorage = new AsyncLocalStorage<SettledPayment | undefined>()

export interface MerchantConfig {
  merchantAddress: Address
  baseUrl: string
  /** Requirements builder used for the in-band "payment required" tool text.
   *  Required so every entrypoint passes the processor's builder and the tool
   *  text advertises the same accepts entries (e.g. the experimental erc7710
   *  option) as the HTTP 402 challenge. */
  buildPaymentRequired: X402PaymentProcessor['buildPaymentRequired']
  settlementMethods?: readonly SettlementMethod[]
}

const completedPurchases = new WeakMap<SettledPayment, string>()

export function runWithSettledPayment<T>(payment: SettledPayment | undefined, fn: () => T): T {
  return paymentStorage.run(payment, fn)
}

/** Build the demo merchant MCP server. */
export function buildMerchantMcpServer(config: MerchantConfig): McpServer {
  const settlementMethods = config.settlementMethods?.length ? config.settlementMethods : ['eip3009']
  const defaultSettlementMethod = settlementMethods.includes(DEFAULT_SETTLEMENT_METHOD)
    ? DEFAULT_SETTLEMENT_METHOD
    : settlementMethods[0]
  const server = new McpServer({
    name: 'haven-demo-merchant',
    version: '0.1.0',
  })

  // ── list_products ──────────────────────────────────────────────────────────
  server.tool(
    'list_products',
    'List available demo products, prices, merchant URL, and supported x402 settlement methods. No payment required.',
    {},
    async () => {
      const rows = Object.values(PRODUCTS).map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        price_usdc: formatUsdc(p.price_usdc),
        description: p.description,
        x402: {
          resource_url: `${config.baseUrl}/mcp`,
          network: `eip155:${CHAIN_ID}`,
          asset: 'USDC',
          settlement_methods: settlementMethods,
          default_settlement_method: defaultSettlementMethod,
          hosted_urls: {
            dev: `${HOSTED_DEMO_MERCHANT_URLS.dev}/mcp`,
            prod: `${HOSTED_DEMO_MERCHANT_URLS.prod}/mcp`,
          },
        },
      }))

      const text = rows
        .map(
          (r) =>
            `[${r.id}] ${r.name}\n` +
            `  Pris: $${r.price_usdc} USDC/månad\n` +
            `  x402: ${r.x402.network} USDC, settlement_methods=${r.x402.settlement_methods.join(',')}, default=${r.x402.default_settlement_method}\n` +
            `  Merchant MCP URL: ${r.x402.resource_url}\n` +
            `  Hosted routing: dev=${r.x402.hosted_urls.dev}, prod=${r.x402.hosted_urls.prod}\n` +
            `  ${r.description}`,
        )
        .join('\n\n')

      return {
        content: [
          {
            type: 'text',
            text:
              `Tillgängliga produkter:\n\n${text}\n\n` +
              `Använd buy_vpn eller buy_cloud_storage för att köpa. ` +
              `Utelämna settlement_method för ${defaultSettlementMethod}; ange eip3009 eller erc7710 för att välja explicit. ` +
              `Betalning sker via x402 (USDC på Base) och måste signeras av köparens wallet eller agentruntime.`,
          },
        ],
      }
    },
  )

  // ── buy_vpn ────────────────────────────────────────────────────────────────
  server.tool(
    'buy_vpn',
    'Köp ett NordShield VPN-abonnemang. Betalning via x402 (USDC på Base). ' +
      `settlement_method är valfritt och standard är ${defaultSettlementMethod}. Kräver giltig PAYMENT-SIGNATURE eller X-PAYMENT header.`,
    {
      plan: z.enum(['basic', 'pro', 'ultra']).describe('VPN-plan att köpa'),
      settlement_method: z.enum(SUPPORTED_SETTLEMENT_METHODS).optional().describe('Valfri x402 settlement method'),
    },
    async ({ plan, settlement_method }) => {
      const productId = `vpn_${plan}` as ProductId
      return completePurchase(config, productId, `${PRODUCTS[productId].name} — 1 månads abonnemang`, settlement_method)
    },
  )

  // ── buy_cloud_storage ──────────────────────────────────────────────────────
  server.tool(
    'buy_cloud_storage',
    'Köp CloudNest molnlagring. Betalning via x402 (USDC på Base). ' +
      `settlement_method är valfritt och standard är ${defaultSettlementMethod}. Kräver giltig PAYMENT-SIGNATURE eller X-PAYMENT header.`,
    {
      tier: z.enum(['50gb', '200gb', '1tb']).describe('Lagringskapacitet att köpa'),
      settlement_method: z.enum(SUPPORTED_SETTLEMENT_METHODS).optional().describe('Valfri x402 settlement method'),
    },
    async ({ tier, settlement_method }) => {
      const productId = `storage_${tier}` as ProductId
      return completePurchase(config, productId, `${PRODUCTS[productId].name} — 1 månads lagring`, settlement_method)
    },
  )

  return server
}

function completePurchase(
  config: MerchantConfig,
  productId: ProductId,
  description: string,
  settlementMethod?: SettlementMethod,
) {
  const product = PRODUCTS[productId]
  const resource = `${config.baseUrl}/mcp`
  const payment = paymentStorage.getStore()

  if (!payment || payment.productId !== productId) {
    const requirements = config.buildPaymentRequired({
      merchantAddress: config.merchantAddress,
      amountUsdc: product.price_usdc,
      resource,
      description,
      settlementMethod,
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
            `Nätverk: eip155:${CHAIN_ID}\n\n` +
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

  // Shared with the HTTP layer's x-receipt-json header (#956) — one invoice
  // per settled payment, so header and text can never diverge.
  const invoice = invoiceForPayment(payment, productId)

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
