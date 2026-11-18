/**
 * The public discovery document (docs/architecture/12-merchant-kit.md §4): the
 * products file, served at the x402 well-known path so agents, directories and
 * Haven read one catalogue. It is built from the products file and the
 * deployment's settings and from nothing else. Answering it verifies nothing,
 * settles nothing and makes no facilitator call.
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

/** One product, as the products file spells it (§3) and the document lists it (§4). */
export interface DiscoveryProduct {
  id: string
  name?: string
  /** `METHOD /path`, the products-file spelling: how to call it. */
  route: string
  model?: string
  /** Atomic USDC units, as a decimal string. */
  price: string
  output_token_cap?: number
  description: string
  input_example?: unknown
  input_schema?: unknown
  output_example?: unknown
}

export interface DiscoveryDocument {
  version: number
  /** Who operates the endpoint (§4). */
  operator: { name: string; contact?: string }
  name: string
  description: string
  /** CAIP-2 identifier, the same value the challenge advertises. */
  network: string
  /** The USDC contract on that network. */
  asset: Address
  /** The receiving address: one setting of the deployment, every product is paid to it. */
  pay_to: Address
  settlement: { scheme: 'exact'; facilitator: 'coinbase-cdp'; methods: ['eip3009'] }
  products: DiscoveryProduct[]
  /** RFC 3339 timestamp of the last change, for caches. */
  updated?: string
  /** The deployment's `ICON_URL`, for a directory listing (§4). */
  icon_url?: string
}

/**
 * Build the document from the products file and the deployment's settings.
 * `updated` is the products file's last change; the caller reads it once at
 * startup, so the document changes when the file does and the proxy restarts.
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
    description: config.endpointDescription,
    network: config.chain.network,
    asset: config.chain.usdcAddress,
    pay_to: config.payTo,
    settlement: { scheme: 'exact', facilitator: 'coinbase-cdp', methods: ['eip3009'] },
    products: products.map((product) => ({
      id: product.id,
      ...(product.name !== undefined ? { name: product.name } : {}),
      route: product.route,
      ...(product.model !== undefined ? { model: product.model } : {}),
      price: product.price.toString(),
      ...(product.outputTokenCap !== undefined ? { output_token_cap: product.outputTokenCap } : {}),
      description: product.description,
      ...(product.inputExample !== undefined ? { input_example: product.inputExample } : {}),
      ...(product.inputSchema !== undefined ? { input_schema: product.inputSchema } : {}),
      ...(product.outputExample !== undefined ? { output_example: product.outputExample } : {}),
    })),
    ...(updated !== undefined ? { updated } : {}),
    ...(config.iconUrl !== undefined ? { icon_url: config.iconUrl } : {}),
  }
}
