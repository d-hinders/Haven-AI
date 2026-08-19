import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import {
  DEFAULT_MERCHANT_LOCALE,
  DEFAULT_SETTLEMENT_METHOD,
  MERCHANT_LOCALES,
  PRODUCTS,
  SUPPORTED_SETTLEMENT_METHODS,
  CHAIN_ID,
  HOSTED_DEMO_MERCHANT_URLS,
  buildProductMetadata,
  formatUsdc,
  merchantEnvironmentForChain,
  productDescription,
  type MerchantLocale,
  type ProductId,
  type SettlementMethod,
} from './products.js'
import { invoiceForPayment, renderInvoiceText, type Invoice } from './invoice.js'
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

// #1550: the confirmation text now varies by (locale, result_detail), so the
// per-payment replay cache is keyed per variant — a Swedish full receipt must
// never be replayed to an English summary request for the same payment.
const completedPurchases = new WeakMap<SettledPayment, Map<string, string>>()

// ── Display locale + result detail (#1550) ───────────────────────────────────
// English default, Swedish behind `locale: 'sv'`. `result_detail: 'summary'`
// drops the ASCII invoice + bookkeeping JSON from the TEXT — raw evidence an
// agent that reports from the structured `summary` never needed to relay —
// while the structured content and the `x-receipt-json` header stay identical.
const RESULT_DETAILS = ['full', 'summary'] as const
type ResultDetail = (typeof RESULT_DETAILS)[number]

interface MerchantStrings {
  monthSubscription: string
  monthStorage: string
  availableProductsHeading: string
  priceLabel: string
  perMonth: string
  listFooter: (defaultMethod: SettlementMethod) => string
  paymentRequired: (productName: string) => string
  priceLine: (amount: string) => string
  paymentAddress: string
  network: string
  paymentRequirementsHeading: string
  resendHint: string
  purchaseConfirmed: string
  productLabel: string
  paidLabel: string
  fromDelegate: (from: string) => string
  fromLabel: string
  invoiceJsonHeading: string
  summaryTail: string
}

const STRINGS: Record<MerchantLocale, MerchantStrings> = {
  en: {
    monthSubscription: '1 month subscription',
    monthStorage: '1 month of storage',
    availableProductsHeading: 'Available products:',
    priceLabel: 'Price',
    perMonth: '/month',
    listFooter: (defaultMethod) =>
      `Use buy_vpn or buy_cloud_storage to purchase. ` +
      `Omit settlement_method for ${defaultMethod}; pass eip3009 or erc7710 to choose explicitly. ` +
      `Payment happens via x402 (USDC on Base) and must be signed by the buyer's wallet or agent runtime.`,
    paymentRequired: (productName) => `Payment required for ${productName}.`,
    priceLine: (amount) => `Price: $${amount} USDC (incl. 25% VAT)`,
    paymentAddress: 'Payment address',
    network: 'Network',
    paymentRequirementsHeading: 'x402 payment requirements:',
    resendHint: 'Re-send the same HTTP call with a PAYMENT-SIGNATURE or X-PAYMENT header.',
    purchaseConfirmed: '✅ Purchase confirmed!',
    productLabel: 'Product',
    paidLabel: 'Paid',
    fromDelegate: (from) => `From:     ${from} (delegate account — the payment is drawn from the owner's treasury)`,
    fromLabel: 'From',
    invoiceJsonHeading: 'Invoice details as JSON (for bookkeeping):',
    summaryTail:
      'Full invoice omitted (result_detail: "summary") — re-call with result_detail: "full" for the ' +
      'rendered invoice + bookkeeping JSON; the same document also travels as the x-receipt-json response header.',
  },
  sv: {
    monthSubscription: '1 månads abonnemang',
    monthStorage: '1 månads lagring',
    availableProductsHeading: 'Tillgängliga produkter:',
    priceLabel: 'Pris',
    perMonth: '/månad',
    listFooter: (defaultMethod) =>
      `Använd buy_vpn eller buy_cloud_storage för att köpa. ` +
      `Utelämna settlement_method för ${defaultMethod}; ange eip3009 eller erc7710 för att välja explicit. ` +
      `Betalning sker via x402 (USDC på Base) och måste signeras av köparens wallet eller agentruntime.`,
    paymentRequired: (productName) => `Betalning krävs för ${productName}.`,
    priceLine: (amount) => `Pris: $${amount} USDC (inkl. 25% moms)`,
    paymentAddress: 'Betalningsadress',
    network: 'Nätverk',
    paymentRequirementsHeading: 'x402 betalningskrav:',
    resendHint: 'Skicka om samma HTTP-anrop med PAYMENT-SIGNATURE eller X-PAYMENT header.',
    purchaseConfirmed: '✅ Köp bekräftat!',
    productLabel: 'Produkt',
    paidLabel: 'Betalat',
    fromDelegate: (from) => `Från:     ${from} (delegatkonto — betalningen dras från ägarens treasury)`,
    fromLabel: 'Från',
    invoiceJsonHeading: 'Fakturadetaljerna som JSON (för bokföring):',
    summaryTail:
      'Fullständig faktura utelämnad (result_detail: "summary") — anropa igen med result_detail: "full" för den ' +
      'renderade fakturan + bokförings-JSON; samma dokument skickas också som svarsheadern x-receipt-json.',
  },
}

const LOCALE_PARAM = z
  .enum(MERCHANT_LOCALES)
  .optional()
  .describe("Display language for text output; 'en' (default) or 'sv'. The invoice JSON stays Swedish (bookkeeping document) either way.")
const RESULT_DETAIL_PARAM = z
  .enum(RESULT_DETAILS)
  .optional()
  .describe("'full' (default) includes the rendered invoice + bookkeeping JSON in the text; 'summary' returns a short confirmation — the structured `summary` object is identical either way.")

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
      "can pick e.g. buy_cloud_storage { tier: \"50gb\" } without parsing the localized `description` prose. " +
      "Text output is English by default; pass locale: 'sv' for Swedish (#1550).",
    { locale: LOCALE_PARAM },
    async ({ locale }) => {
      const t = STRINGS[locale ?? DEFAULT_MERCHANT_LOCALE]
      // #1274: one builder shared per product so metadata and its display text
      // can never drift from each other or from the erc7710 gate resolved upstream.
      const metadata = Object.values(PRODUCTS).map((p) =>
        buildProductMetadata(p, { enabledSettlementMethods: settlementMethods, mcpUrl: `${config.baseUrl}/mcp` }),
      )

      const text = Object.values(PRODUCTS)
        .map((p, i) => {
          const m = metadata[i]
          return (
            `[${m.product_id}] ${m.display_name}\n` +
            `  ${t.priceLabel}: ${m.display.price_formatted}${t.perMonth}\n` +
            `  x402: ${m.network} USDC, settlement_methods=${m.supported_settlement_methods.join(',')}, default=${m.default_settlement_method}\n` +
            `  Merchant MCP URL: ${m.mcp_url}\n` +
            `  Hosted routing: dev=${HOSTED_DEMO_MERCHANT_URLS.dev}/mcp, prod=${HOSTED_DEMO_MERCHANT_URLS.prod}/mcp\n` +
            `  ${productDescription(p, locale ?? DEFAULT_MERCHANT_LOCALE)}`
          )
        })
        .join('\n\n')

      return {
        content: [
          {
            type: 'text',
            text: `${t.availableProductsHeading}\n\n${text}\n\n${t.listFooter(defaultSettlementMethod)}`,
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
    'Buy a NordShield VPN subscription. Payment via x402 (USDC on Base). ' +
      `settlement_method is optional and defaults to ${defaultSettlementMethod}. Requires a valid PAYMENT-SIGNATURE or X-PAYMENT header. ` +
      'On success, report the purchase to the user from the structured `summary` object (status, product_name, amount, ' +
      'settlement_tx_hash) rather than parsing the confirmation text or invoice. ' +
      "Text output is English by default (locale: 'sv' for Swedish); pass result_detail: 'summary' to omit the rendered invoice + bookkeeping JSON from the text (#1550).",
    {
      plan: z.enum(['basic', 'legacy', 'pro', 'ultra']).describe('VPN plan to buy'),
      settlement_method: z.enum(SUPPORTED_SETTLEMENT_METHODS).optional().describe('Optional x402 settlement method'),
      locale: LOCALE_PARAM,
      result_detail: RESULT_DETAIL_PARAM,
    },
    async ({ plan, settlement_method, locale, result_detail }) => {
      const productId = `vpn_${plan}` as ProductId
      const resolvedLocale = locale ?? DEFAULT_MERCHANT_LOCALE
      return completePurchase(config, productId, {
        description: `${PRODUCTS[productId].name} — ${STRINGS[resolvedLocale].monthSubscription}`,
        settlementMethod: settlement_method,
        locale: resolvedLocale,
        detail: result_detail ?? 'full',
      })
    },
  )

  // ── buy_cloud_storage ──────────────────────────────────────────────────────
  server.tool(
    'buy_cloud_storage',
    'Buy CloudNest cloud storage. Payment via x402 (USDC on Base). ' +
      `settlement_method is optional and defaults to ${defaultSettlementMethod}. Requires a valid PAYMENT-SIGNATURE or X-PAYMENT header. ` +
      'On success, report the purchase to the user from the structured `summary` object (status, product_name, amount, ' +
      'settlement_tx_hash) rather than parsing the confirmation text or invoice. ' +
      "Text output is English by default (locale: 'sv' for Swedish); pass result_detail: 'summary' to omit the rendered invoice + bookkeeping JSON from the text (#1550).",
    {
      tier: z.enum(['50gb', '200gb', '1tb']).describe('Storage capacity to buy'),
      settlement_method: z.enum(SUPPORTED_SETTLEMENT_METHODS).optional().describe('Optional x402 settlement method'),
      locale: LOCALE_PARAM,
      result_detail: RESULT_DETAIL_PARAM,
    },
    async ({ tier, settlement_method, locale, result_detail }) => {
      const productId = `storage_${tier}` as ProductId
      const resolvedLocale = locale ?? DEFAULT_MERCHANT_LOCALE
      return completePurchase(config, productId, {
        description: `${PRODUCTS[productId].name} — ${STRINGS[resolvedLocale].monthStorage}`,
        settlementMethod: settlement_method,
        locale: resolvedLocale,
        detail: result_detail ?? 'full',
      })
    },
  )

  return server
}

function completePurchase(
  config: MerchantConfig,
  productId: ProductId,
  options: {
    description: string
    settlementMethod?: SettlementMethod
    locale: MerchantLocale
    detail: ResultDetail
  },
) {
  const { description, settlementMethod, locale, detail } = options
  const t = STRINGS[locale]
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
            `${t.paymentRequired(product.name)}\n\n` +
            `${t.priceLine(formatUsdc(product.price_usdc))}\n` +
            `${t.paymentAddress}: ${config.merchantAddress}\n` +
            `${t.network}: eip155:${CHAIN_ID}\n\n` +
            `${t.paymentRequirementsHeading}\n${JSON.stringify(requirements, null, 2)}\n\n` +
            t.resendHint,
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

  // #1550: cached per (locale, detail) — the replay guarantee is per VARIANT,
  // so a duplicate call with the same options replays byte-identical text.
  const variantKey = `${locale}:${detail}`
  const variants = completedPurchases.get(payment) ?? new Map<string, string>()
  const cachedText = variants.get(variantKey)
  if (cachedText) {
    return { content: [{ type: 'text' as const, text: cachedText }], structuredContent: { summary } }
  }

  const header =
    `${t.purchaseConfirmed}\n\n` +
    `${t.productLabel}:  ${product.name}\n` +
    `${t.paidLabel}:     $${formatUsdc(payment.value)} USDC\n` +
    // #1472, decision recorded: the receipt says what the address IS. On
    // erc7710 `payment.from` is the DELEGATE ACCOUNT (the header's delegator)
    // — the funds provably leave the owner's treasury, not this address, so
    // printing it as a bare "From" made a claim about custody the chain
    // contradicts. The #1454 live run surfaced exactly that confusion.
    (payment.settlementMethod === 'erc7710'
      ? `${t.fromDelegate(payment.from)}\n`
      : `${t.fromLabel}:     ${payment.from}\n`) +
    `Tx:       ${payment.txHash}\n` +
    `Nonce:    ${payment.nonce}\n`

  const text =
    detail === 'summary'
      ? `${header}\n${t.summaryTail}`
      : `${header}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        renderInvoiceText(invoice.json, product.name, locale) +
        `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `${t.invoiceJsonHeading}\n` +
        JSON.stringify(invoice.json, null, 2)

  variants.set(variantKey, text)
  completedPurchases.set(payment, variants)
  return { content: [{ type: 'text' as const, text }], structuredContent: { summary } }
}
