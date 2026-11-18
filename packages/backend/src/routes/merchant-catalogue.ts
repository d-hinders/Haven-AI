/**
 * The merchant catalogue's routes (#4899, epic #4885).
 *
 * The owner saves the public address of their kit deployment for the merchant
 * account; Haven reads the discovery document from it, keeps the product list,
 * and refreshes it on request and on a schedule
 * (`background-jobs.ts`, every 15 minutes). The screens that show the address,
 * a mismatch and the time of the last read are #4900; these are the routes they
 * call.
 *
 * ## Saving an address reads it immediately
 *
 * `PUT /merchant-catalogue/deployment` stores the address and then reads it, so
 * the answer to the save is the catalogue the document produced — the owner
 * does not have to wait for the next tick to see whether the address works. A
 * read that fails does not fail the save: the address is stored, the outcome is
 * recorded, and the answer says what happened.
 *
 * ## The address is checked before it is stored
 *
 * `assertSafeUrl` is the guard's own pure policy check — https only, default
 * port, no embedded credentials, no IP literal, no locally-bound name — so an
 * address Haven would refuse to read is refused at the field rather than stored
 * and refused on every tick. The resolution-time half (a hostname that resolves
 * into private space) can only be checked by the read itself, and it is: the
 * fetch goes through the same guard with `sameHostOnly`, so a redirect off the
 * host is refused too.
 *
 * ## Nothing here moves money
 *
 * The routes store a merchant-supplied address and a product list, and label
 * products. They never change an amount, create a sale, or name a recipient:
 * the document's `pay_to` is compared against the account's own address and
 * stored as a label, never used as a payment destination. The product list is
 * its own table, never `merchant_catalog` (migration 130).
 *
 * ## Money path
 *
 * The module decides what labels the account's sales and stores data a merchant
 * supplies, so it sits on the money-path perimeter and its writes carry the
 * money-path rate limit. Nothing here signs, submits or settles.
 */
import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { assertSafeUrl } from '../infra/http/ssrf-guard.js'
import { findMerchantAccountForUser } from '../infra/repositories/merchant-services.js'
import type {
  MerchantCatalogueSourceRow,
  MerchantProductRow,
} from '../infra/repositories/merchant-catalogue.js'
import { saveCatalogueDeployment } from '../infra/repositories/merchant-catalogue.js'
import {
  readMerchantCatalogue,
  readMerchantCatalogueView,
  type MerchantCatalogueView,
} from '../modules/catalog/index.js'
import { MERCHANT_ACCOUNT_REQUIRED } from '../domain/merchant-keys.js'
import {
  MERCHANT_CATALOGUE_NOT_CONFIGURED,
  MERCHANT_CATALOGUE_URL_REFUSED,
} from '../domain/merchant-catalogue.js'

interface SaveDeploymentBody {
  /** The public address of the kit deployment, e.g. `https://api.example.com`. */
  deployment_url: string
}

/** A timestamp column as the wire spells it: ISO 8601, or null. */
function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

function serializeProduct(row: MerchantProductRow): Record<string, unknown> {
  return {
    product_id: row.product_id,
    name: row.name,
    description: row.description,
    route: row.route,
    model: row.model,
    price_atomic: row.price_atomic,
    network: row.network,
    output_token_cap: row.output_token_cap,
    offered: row.offered,
    removed_at: isoOrNull(row.removed_at),
  }
}

/**
 * The wire shape of the catalogue: the address, the last read, and the list.
 *
 * `last_read_status` is the outcome of the last ATTEMPT, so an unreachable kit
 * shows `unreachable` with the last good list still in `products` and
 * `last_read_at` naming when Haven last tried. `mismatch` is true when the
 * document's receiving address or network is not this account's; its products
 * are not in the list.
 */
function serializeCatalogue(view: MerchantCatalogueView): Record<string, unknown> {
  const source: MerchantCatalogueSourceRow | null = view.source
  return {
    deployment_url: source?.deployment_url ?? null,
    last_read_at: isoOrNull(source?.last_read_at ?? null),
    last_read_status: source?.last_read_status ?? 'never',
    last_read_detail: source?.last_read_detail ?? null,
    mismatch: source?.mismatch ?? false,
    mismatch_reason: source?.mismatch_reason ?? null,
    document_name: source?.document_name ?? null,
    document_operator_name: source?.document_operator_name ?? null,
    document_network: source?.document_network ?? null,
    document_pay_to: source?.document_pay_to ?? null,
    document_updated: source?.document_updated ?? null,
    products: view.products.map(serializeProduct),
  }
}

export default async function merchantCatalogueRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  /**
   * Save the deployment address and read it.
   *
   * 200 with the catalogue the read produced. The address is stored even when
   * the read fails — the owner asked for it to be saved, and the outcome is
   * what the screen shows.
   */
  app.put<{ Body: SaveDeploymentBody }>(
    '/deployment',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }

      const account = await findMerchantAccountForUser(sub)
      if (account === null) {
        return reply.code(409).send({
          error: 'Turn merchant services on before adding a deployment address',
          error_code: MERCHANT_ACCOUNT_REQUIRED,
        })
      }

      // The guard's own policy check, before anything is stored: an address
      // Haven would refuse to read is refused at the field.
      const checked = assertSafeUrl(request.body.deployment_url)
      if (!checked.ok) {
        return reply.code(400).send({
          error: `Haven cannot read that address: ${checked.detail}`,
          error_code: MERCHANT_CATALOGUE_URL_REFUSED,
          reason: checked.reason,
        })
      }

      // The saved address is the deployment's ORIGIN. The discovery document is
      // served at `/.well-known/x402` and nowhere else, so a path, query or
      // fragment the owner pasted must not become part of what Haven reads.
      const { source } = await saveCatalogueDeployment({
        merchantAccountId: account.id,
        deploymentUrl: checked.url.origin,
      })

      // Read it now, so the answer to the save is the catalogue it produced.
      // A read that throws (a database failure, not a document failure — the
      // document's own failures are recorded, not thrown) must not lose the
      // save that already committed.
      try {
        await readMerchantCatalogue({
          merchantAccountId: account.id,
          deploymentUrl: source.deployment_url,
          accountAddress: account.account_address,
          chainId: Number(account.chain_id),
        })
      } catch (err) {
        request.log.warn({ err }, 'Merchant catalogue read after save failed')
      }

      return serializeCatalogue(await readMerchantCatalogueView(account.id))
    },
  )

  /**
   * Read the deployment again, on request.
   *
   * 409 when no address has been saved: there is nothing to read, and the
   * screen's next step is the address field.
   */
  app.post('/refresh', { config: moneyPathRateLimit }, async (request, reply) => {
    const { sub } = request.user as { sub: string }

    const account = await findMerchantAccountForUser(sub)
    if (account === null) {
      return reply.code(409).send({
        error: 'Turn merchant services on before adding a deployment address',
        error_code: MERCHANT_ACCOUNT_REQUIRED,
      })
    }

    const view = await readMerchantCatalogueView(account.id)
    if (view.source === null) {
      return reply.code(409).send({
        error: 'Save the address of your kit deployment first',
        error_code: MERCHANT_CATALOGUE_NOT_CONFIGURED,
      })
    }

    try {
      await readMerchantCatalogue({
        merchantAccountId: account.id,
        deploymentUrl: view.source.deployment_url,
        accountAddress: account.account_address,
        chainId: Number(account.chain_id),
      })
    } catch (err) {
      request.log.warn({ err }, 'Merchant catalogue refresh failed')
    }

    return serializeCatalogue(await readMerchantCatalogueView(account.id))
  })

  /**
   * The catalogue as the owner's screens read it: the address, the last read,
   * the mismatch, and the product list. Scoped to the caller's merchant
   * account, so another user's catalogue is never returned.
   */
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }
    const account = await findMerchantAccountForUser(sub)
    if (account === null) {
      return serializeCatalogue({ source: null, products: [] })
    }
    return serializeCatalogue(await readMerchantCatalogueView(account.id))
  })
}
