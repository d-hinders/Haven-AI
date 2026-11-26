/**
 * #4987: the merchant kit's discovery document, served by the demo merchant at
 * `/.well-known/x402` so a Haven Sales account can read its product list.
 *
 * Haven's Sales page reads a seller's products from `<origin>/.well-known/x402`
 * and nowhere else (`MERCHANT_CATALOGUE_DISCOVERY_PATH` in the backend's
 * `modules/catalog/merchant-products.ts`, #4899). The merchant kit serves that
 * document; the demo merchant served nothing there, so the merchant-services
 * demo (#4885) had no way to fill the Products tab.
 *
 * ## A reduced version 1 document
 *
 * This is the subset of `docs/architecture/12-merchant-kit.md` §4 that Haven's
 * reader (`parseDiscoveryDocument`) needs: `version`, `network`, `asset`,
 * `pay_to`, and products with `id`, `name`, `description` and an atomic
 * `price`. §4's `settlement` block and each product's `route` are left out on
 * purpose: these are MCP tools, not HTTP routes, and they do not share one
 * settlement method or facilitator, so neither could be filled truthfully.
 * The reader ignores missing optional fields.
 *
 * It carries no `mcp_url`. That field is what the SDK acts on in the demo
 * merchant's OWN document (`/` and `/.well-known/haven-demo-merchant`), which
 * this does not touch; §4 keeps it out of the kit document.
 *
 * ## Only the products whose sales appear on the Sales account
 *
 * `pay_to` is the Sales account (`MERCHANT_SALES_ADDRESS`), because Haven uses
 * none of a document's products when `pay_to` is not the account's own
 * address. The list is the products that are offered AND whose sales appear
 * on that account, decided by `salesAccountRoute` in `products.ts` — the same
 * function the sale reporter (`createSalesReporting` in `sales.ts`) decides by
 * (#5091): every product paid into the Sales account (by default only
 * `field_notes`), and the Stripe-recorded joke when Stripe recording is on.
 * The VPN and storage products pay `MERCHANT_ADDRESS` and never report, so
 * listing them would show products that can never sell on that Sales account.
 * A merchant that routes more of its catalogue into the Sales account lists
 * more, with no second rule to update.
 *
 * The joke's money lands on the Stripe deposit address, not on `pay_to`. A
 * kit document has one `pay_to`, and nothing pays from this document: the SDK
 * never reads this path, and Haven only labels products with it (captain
 * decision on #4987).
 */
import type { Address } from 'viem'
import { CHAIN_ID, USDC_ADDRESS, offeredProducts, salesAccountRoute } from './products.js'

/** The path the kit serves its discovery document at (12-merchant-kit.md §4). */
export const KIT_DISCOVERY_PATH = '/.well-known/x402'

/** The kit document version this document is (12-merchant-kit.md §4). */
export const KIT_DISCOVERY_VERSION = 1

export interface KitDiscoveryProduct {
  id: string
  name: string
  description: string
  /** USDC base units (6 decimals), as a decimal string. */
  price: string
}

export interface KitDiscoveryDocument {
  version: number
  operator: { name: string }
  name: string
  network: string
  asset: Address
  pay_to: Address
  products: KitDiscoveryProduct[]
}

export interface KitDiscoveryOptions {
  /** The Sales account; without it there is no document (Haven would refuse it). */
  salesAddress: Address | undefined
  /** The merchant's default receiving address (`MERCHANT_ADDRESS`). */
  merchantAddress: Address
  /** The Stripe deposit address when Stripe recording is on, so the joke reports its sales. */
  stripeDepositAddress?: Address
  /** CDP is configured, so the CDP-settled joke is offered at all. */
  cdpConfigured: boolean
  /** Test seam; defaults to the merchant's chain. */
  chainId?: number
  /** Test seam; defaults to the merchant's chain's USDC. */
  asset?: Address
}

/** The document, or `null` when there is no Sales account to name as `pay_to`. */
export function buildKitDiscovery(opts: KitDiscoveryOptions): KitDiscoveryDocument | null {
  if (!opts.salesAddress) return null
  const products = offeredProducts({ cdpConfigured: opts.cdpConfigured, salesConfigured: true })
    .filter(
      (product) =>
        salesAccountRoute(product, opts.merchantAddress, {
          salesAddress: opts.salesAddress,
          stripeDepositAddress: opts.stripeDepositAddress,
        }) !== null,
    )
    .map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      price: product.price_usdc.toString(),
    }))
  return {
    version: KIT_DISCOVERY_VERSION,
    operator: { name: 'Haven Demo Merchant' },
    name: 'Haven Demo Merchant',
    network: `eip155:${opts.chainId ?? CHAIN_ID}`,
    asset: opts.asset ?? USDC_ADDRESS,
    pay_to: opts.salesAddress,
    products,
  }
}
