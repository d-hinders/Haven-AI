import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import {
  DEFAULT_SETTLEMENT_METHOD,
  PRODUCTS,
  SUPPORTED_SETTLEMENT_METHODS,
  CHAIN_ID,
  HOSTED_DEMO_MERCHANT_URLS,
  buildProductMetadata,
  formatUsdc,
  merchantEnvironmentForChain,
  type ProductId,
  type SettlementMethod,
} from './products.js'
import { invoiceForPayment, type Invoice } from './invoice.js'
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

// ── Structured purchase summary (#1273) ─────────────────────────────────────
// DISPLAY/REPORTING DATA ONLY. This is a convenience surface for agent-facing
// reporting ("what did I just buy") — it is never the bookkeeping or ledger
// source of truth. That truth remains the Haven receipt (the `x-receipt-json`
// header / invoice, set by the HTTP layer from this same `SettledPayment`) plus
// on-chain funding/settlement state. Every field below is read straight off the
// already-settled `SettledPayment` (never re-derived from the quoted product
// price or caller input), so the summary cannot silently drift from what was
// actually settled on-chain.
export interface PurchaseSummary {
  status: 'confirmed'
  product_id: ProductId
  product_name: string
  invoice_id: string
  amount_atomic: string
  amount: string
  asset: 'USDC'
  network: string
  /** Not known merchant-side in this demo (no funding-leg visibility here);
   *  present for shape parity with Haven's funding+settlement two-leg rails. */
  funding_tx_hash?: string
  settlement_tx_hash: string
}

/** Built only from an ALREADY-SETTLED payment — status: 'confirmed' is reachable
 *  only via this function, and only after `waitForReceipt` has proven the
 *  on-chain transaction succeeded (see x402.ts `confirmSubmittedPayment`). */
export function buildPurchaseSummary(payment: SettledPayment, invoice: Invoice): PurchaseSummary {
  const product = PRODUCTS[payment.productId]
  return {
    status: 'confirmed',
    product_id: payment.productId,
    product_name: product.name,
    invoice_id: invoice.json.fakturanummer,
    amount_atomic: payment.value.toString(),
    amount: formatUsdc(payment.value),
    asset: 'USDC',
    network: `eip155:${CHAIN_ID}`,
    settlement_tx_hash: payment.txHash,
  }
}

export function runWithSettledPayment<T>(payment: SettledPayment | undefined, fn: () => T): T {
  return paymentStorage.run(payment, fn)
}

/** Build the demo merchant MCP server. */
export function buildMerchantMcpServer(config: MerchantConfig): McpServer {
  const settlementMethods: readonly SettlementMethod[] = config.settlementMethods?.length
    ? config.settlementMethods
    : ['eip3009']
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
    'List available demo products, prices, merchant URL, and supported x402 settlement methods. No payment required. ' +
      'The structured output (`products`) exposes stable machine-readable fields — product_id, tool_name, ' +
      'arguments_schema, supported_settlement_methods, default_settlement_method, mcp_url, environment — so an agent ' +
      'can pick e.g. buy_cloud_storage { tier: "50gb" } without parsing the localized `description` prose.',
    {},
    async () => {
      // #1274: one builder shared per product so metadata and its display text
      // can never drift from each other or from the erc7710 gate resolved upstream.
      const metadata = Object.values(PRODUCTS).map((p) =>
        buildProductMetadata(p, { enabledSettlementMethods: settlementMethods, mcpUrl: `${config.baseUrl}/mcp` }),
      )

      const text = metadata
        .map(
          (m) =>
            `[${m.product_id}] ${m.display_name}\n` +
            `  Pris: ${m.display.price_formatted}/månad\n` +
            `  x402: ${m.network} USDC, settlement_methods=${m.supported_settlement_methods.join(',')}, default=${m.default_settlement_method}\n` +
            `  Merchant MCP URL: ${m.mcp_url}\n` +
            `  Hosted routing: dev=${HOSTED_DEMO_MERCHANT_URLS.dev}/mcp, prod=${HOSTED_DEMO_MERCHANT_URLS.prod}/mcp\n` +
            `  ${m.description}`,
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
        structuredContent: {
          products: metadata,
          environment: merchantEnvironmentForChain(CHAIN_ID),
          mcp_url: `${config.baseUrl}/mcp`,
        },
      }
    },
  )

  // ── buy_vpn ────────────────────────────────────────────────────────────────
  server.tool(
    'buy_vpn',
    'Köp ett NordShield VPN-abonnemang. Betalning via x402 (USDC på Base). ' +
      `settlement_method är valfritt och standard är ${defaultSettlementMethod}. Kräver giltig PAYMENT-SIGNATURE eller X-PAYMENT header. ` +
      'On success, report the purchase to the user from the structured `summary` object (status, product_name, amount, ' +
      'settlement_tx_hash) rather than parsing the confirmation text or invoice.',
    {
      plan: z.enum(['basic', 'legacy', 'pro', 'ultra']).describe('VPN-plan att köpa'),
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
      `settlement_method är valfritt och standard är ${defaultSettlementMethod}. Kräver giltig PAYMENT-SIGNATURE eller X-PAYMENT header. ` +
      'On success, report the purchase to the user from the structured `summary` object (status, product_name, amount, ' +
      'settlement_tx_hash) rather than parsing the confirmation text or invoice.',
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

  // Shared with the HTTP layer's x-receipt-json header (#956) — one invoice
  // per settled payment, so header and text can never diverge. Recomputing on
  // every call is cheap and deterministic (invoiceForPayment memoizes per
  // payment), so the summary below can never disagree between a fresh
  // purchase and a retried/duplicate one.
  const invoice = invoiceForPayment(payment, productId)
  const summary = buildPurchaseSummary(payment, invoice)

  const cachedText = completedPurchases.get(payment)
  if (cachedText) {
    return { content: [{ type: 'text' as const, text: cachedText }], structuredContent: { summary } }
  }

  const text =
    `✅ Köp bekräftat!\n\n` +
    `Produkt:  ${product.name}\n` +
    `Betalat:  $${formatUsdc(payment.value)} USDC\n` +
    // #1472, decision recorded: the receipt says what the address IS. On
    // erc7710 `payment.from` is the DELEGATE ACCOUNT (the header's delegator)
    // — the funds provably leave the owner's treasury, not this address, so
    // printing it as a bare "Från" made a claim about custody the chain
    // contradicts. The #1454 live run surfaced exactly that confusion.
    (payment.settlementMethod === 'erc7710'
      ? `Från:     ${payment.from} (delegatkonto — betalningen dras från ägarens treasury)\n`
      : `Från:     ${payment.from}\n`) +
    `Tx:       ${payment.txHash}\n` +
    `Nonce:    ${payment.nonce}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    invoice.text +
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Fakturadetaljerna som JSON (för bokföring):\n` +
    JSON.stringify(invoice.json, null, 2)

  completedPurchases.set(payment, text)
  return { content: [{ type: 'text' as const, text }], structuredContent: { summary } }
}
