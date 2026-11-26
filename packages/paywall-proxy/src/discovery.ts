/**
 * The public discovery document (docs/architecture/12-merchant-kit.md §4): the
 * products file, served at the x402 well-known path so agents, directories and
 * Haven read one catalogue. It is built from the products file, the
 * deployment's settings, and the kit's own constants — `terms` and `payment`
 * describe what the handler does for every product and are not products-file
 * content (#4990). Answering it verifies nothing, settles nothing and makes no
 * facilitator call.
 *
 * The path is `/.well-known/x402` (RFC 8615) and nowhere else. It is NOT the
 * demo merchant's `/.well-known/haven-demo-merchant`, and the document carries
 * no `mcp_url`: Haven's SDK probes the demo path and `/` and acts on `mcp_url`
 * for MCP merchants (`MERCHANT_DISCOVERY_PATHS` in
 * `packages/sdk/src/merchant-discovery.ts`), so a kit document at that path, or
 * one carrying that field, would be read as an MCP merchant.
 */
import type { Address } from 'viem'
import type { ProxyConfig } from './config.js'
import type { Product } from './products.js'

/** The x402 well-known path (§4). */
export const DISCOVERY_PATH = '/.well-known/x402'
/** The kit document version. `1` is the only version (§4). */
export const DISCOVERY_VERSION = 1
/** The x402 v2 specification, for the payment payload's shape (§4). */
export const X402_SPEC_URL = 'https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md'
/** The headers the proxy accepts a payment in, preferred first (`handler.ts`). */
export const PAYMENT_HEADERS = ['PAYMENT-SIGNATURE', 'X-PAYMENT'] as const
/** The asset every product is priced in. */
export const ASSET_SYMBOL = 'USDC'
/** USDC's decimals on every chain the kit sells on. */
export const ASSET_DECIMALS = 6

/**
 * One product, as the document lists it (§4): the products-file fields (§3),
 * with `route` carrying the deployment's base path so it is the path a buyer
 * calls (#5034).
 */
export interface DiscoveryProduct {
  id: string
  name?: string
  /**
   * `METHOD /path`, the absolute path a buyer calls: the products-file path
   * with the deployment's `BASE_PATH` in front of it (#5034).
   */
  route: string
  model?: string
  /** Atomic USDC units, as a decimal string. */
  price: string
  /** The same price as a decimal USDC string with no trailing zeros: `"0.01"`. */
  price_usdc: string
  output_token_cap?: number
  description: string
  input_example?: unknown
  input_schema?: unknown
  output_example?: unknown
  /** The shape of the answer, when the products file carries one. Served only, never enforced. */
  output_schema?: unknown
}

/** One statement of the sale: the handler's `error` code for the case, and one sentence. */
export interface DiscoveryTerm {
  /** The `error` code the handler answers with for this case. */
  code: string
  /** One sentence, in the merchant's own voice, saying only what the handler does. */
  statement: string
}

/**
 * The rules of the sale (§4): the merchant's own plain statements about its own
 * endpoint, true for every product. They say only what the handler does; the
 * recourse policy for a call that failed after settlement is not stated here
 * (owner decision 2, 2026-11-19).
 */
export interface DiscoveryTerms {
  one_payment_one_call: true
  replay: DiscoveryTerm
  payment_response: { header: 'PAYMENT-RESPONSE'; statement: string }
  upstream_answered: DiscoveryTerm
  on_failure_after_settlement: DiscoveryTerm & { contact?: string }
}

/** How to pay (§4): the accepted headers, the x402 version and the specification. */
export interface DiscoveryPayment {
  /** The headers the proxy accepts a payment in, preferred first. */
  headers: string[]
  preferred_header: string
  x402_version: 2
  /** The x402 v2 specification, for the payload's shape. */
  spec: string
}

export interface DiscoveryDocument {
  version: number
  /** Who operates the endpoint (§4). */
  operator: { name: string; contact?: string }
  name: string
  description: string
  /** CAIP-2 identifier, the same value the challenge advertises. */
  network: string
  /** The chain's display name (`chains.ts`), for a reader that does not know CAIP-2 ids. */
  network_name: string
  /** Whether that chain is a test network (`chains.ts`). */
  testnet: boolean
  /** The USDC contract on that network. */
  asset: Address
  asset_symbol: string
  asset_decimals: number
  /** The receiving address: one setting of the deployment, every product is paid to it. */
  pay_to: Address
  settlement: { scheme: 'exact'; facilitator: 'coinbase-cdp'; methods: ['eip3009'] }
  /** The rules of the sale, stated by the kit and true for every product. */
  terms: DiscoveryTerms
  /** How to pay: the accepted headers, the x402 version and the specification. */
  payment: DiscoveryPayment
  products: DiscoveryProduct[]
  /** RFC 3339 timestamp of the last change, for caches. */
  updated?: string
  /** The deployment's `ICON_URL`, for a directory listing (§4). */
  icon_url?: string
}

/**
 * The price as a decimal USDC string with no trailing zeros: `10000n` is
 * `"0.01"`, `18000n` is `"0.018"`, `100n` is `"0.0001"`, `1000000n` is `"1"`.
 * Pure bigint math, so no precision is lost past 2^53 base units.
 */
export function formatUsdcPrice(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const frac = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac === '' ? whole.toString() : `${whole}.${frac}`
}

/**
 * The rules of the sale (§4). Each statement says only what the handler does:
 * the codes are the ones `handler.ts` and `forward.ts` answer with, and the
 * failure statement names the merchant's contact when it published one. It
 * says nothing about retries or the payer-signed `SIGN-IN-WITH-X` proof
 * (owner decision 2, 2026-11-19).
 */
export function buildTerms(config: Pick<ProxyConfig, 'operatorContact'>): DiscoveryTerms {
  const contact = config.operatorContact
  return {
    one_payment_one_call: true,
    replay: {
      code: 'payment_already_delivered',
      statement:
        'The same payment header does not buy a second call: once the call is delivered, presenting it again answers payment_already_delivered.',
    },
    payment_response: {
      header: 'PAYMENT-RESPONSE',
      statement: 'Every answer after settlement carries a PAYMENT-RESPONSE header with the settlement transaction hash.',
    },
    upstream_answered: {
      code: 'upstream_answered',
      statement:
        'A 3xx or 4xx from the upstream is wrapped into a 200 upstream_answered and the payment is used for that call; 401, 402, 403 and 407 are upstream_auth_refused, and 408, 429 and 5xx are failures.',
    },
    on_failure_after_settlement: {
      code: 'upstream_failed_after_settlement',
      statement:
        contact === undefined
          ? 'The payment settled and the call failed: the answer is a 200 upstream_failed_after_settlement with the transaction hash, and the merchant published no contact for what happens next.'
          : `The payment settled and the call failed: the answer is a 200 upstream_failed_after_settlement with the transaction hash, and the merchant's contact for what happens next is ${contact}.`,
      ...(contact !== undefined ? { contact } : {}),
    },
  }
}

/**
 * §4: the discovery document's `description` when `ENDPOINT_DESCRIPTION` is
 * unset (#5006). Built from the products file and the network, because
 * `loadConfig` never reads the products file — it holds only the path. One
 * sentence, in the merchant's own voice, saying only what the deployment is.
 */
export function defaultEndpointDescription(
  config: Pick<ProxyConfig, 'operatorName' | 'chain'>,
  products: readonly Product[],
): string {
  const count = products.length
  return `Pay-per-call API by ${config.operatorName}: ${count} ${count === 1 ? 'product' : 'products'}, paid in USDC on ${config.chain.label}.`
}

/**
 * The route as the document lists it (#5034): the products-file `METHOD /path`
 * with the deployment's `BASE_PATH` in front of the path. The handler serves a
 * product only under the base path (`handler.ts`), so listing the products-file
 * spelling would name a route that answers 404. With no `BASE_PATH` the route
 * is the products-file spelling, unchanged.
 */
export function listedRoute(product: Pick<Product, 'method' | 'path'>, basePath: string): string {
  return `${product.method} ${basePath}${product.path}`
}

/**
 * Build the document from the products file, the deployment's settings and the
 * kit's own constants (`terms`, `payment`). `updated` is the products file's
 * last change; the caller reads it once at startup, so the document changes
 * when the file does and the proxy restarts.
 */
export function buildDiscoveryDocument(params: {
  config: ProxyConfig
  products: readonly Product[]
  updated?: string
}): DiscoveryDocument {
  const { config, products, updated } = params
  return {
    version: DISCOVERY_VERSION,
    operator: {
      name: config.operatorName,
      ...(config.operatorContact !== undefined ? { contact: config.operatorContact } : {}),
    },
    name: config.endpointName,
    description: config.endpointDescription ?? defaultEndpointDescription(config, products),
    network: config.chain.network,
    network_name: config.chain.label,
    testnet: config.chain.testnet,
    asset: config.chain.usdcAddress,
    asset_symbol: ASSET_SYMBOL,
    asset_decimals: ASSET_DECIMALS,
    pay_to: config.payTo,
    settlement: { scheme: 'exact', facilitator: 'coinbase-cdp', methods: ['eip3009'] },
    terms: buildTerms(config),
    payment: {
      headers: [...PAYMENT_HEADERS],
      preferred_header: PAYMENT_HEADERS[0],
      x402_version: 2,
      spec: X402_SPEC_URL,
    },
    products: products.map((product) => ({
      id: product.id,
      ...(product.name !== undefined ? { name: product.name } : {}),
      route: listedRoute(product, config.basePath),
      ...(product.model !== undefined ? { model: product.model } : {}),
      price: product.price.toString(),
      price_usdc: formatUsdcPrice(product.price),
      ...(product.outputTokenCap !== undefined ? { output_token_cap: product.outputTokenCap } : {}),
      description: product.description,
      ...(product.inputExample !== undefined ? { input_example: product.inputExample } : {}),
      ...(product.inputSchema !== undefined ? { input_schema: product.inputSchema } : {}),
      ...(product.outputExample !== undefined ? { output_example: product.outputExample } : {}),
      ...(product.outputSchema !== undefined ? { output_schema: product.outputSchema } : {}),
    })),
    ...(updated !== undefined ? { updated } : {}),
    ...(config.iconUrl !== undefined ? { icon_url: config.iconUrl } : {}),
  }
}
