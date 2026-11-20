/**
 * The sale marker on the transactions feed (#5000, epic #4885).
 *
 * Outside the Sales page a sale used to read "Deposit". This marks each
 * inbound feed row into the user's Sales account that the Sales page counts as
 * a sale, so the Transactions list, the account page and the dashboard card
 * can call it one.
 *
 * ## The rule is the Sales page's, read from its relation
 *
 * Nothing here decides what a sale is. The answer comes from the Sales page's
 * own per-transaction relation (`listFeedSaleMarkers`, the `pay` relation of
 * `infra/repositories/merchant-sales-reads.ts`), restricted to its `account`
 * arm: `sale` (a recorded sale from someone other than the owner) and
 * `no_product` (no record, at least one leg from someone other than the owner)
 * mark the row; `own_move` and "no `pay` row" (a zero-value transfer, or one
 * not indexed yet) leave it as it was. The own half is the RECORDED
 * `sender_is_own_address` flag, never a live lookup, so the two pages agree.
 * The product label is the Sales page's too (`labelProducts`).
 *
 * Only while merchant services are on (`resolveSalesScope`): off, nothing is
 * marked and every row reads as it did before.
 *
 * ## Which rows can carry it
 *
 * An inbound row into the Sales account on its chain, in the chain's USDC (the
 * token `inbound_transfers` indexes): another token's leg in the same
 * transaction is never marked. Own money stays own money even where the
 * recorded flag says otherwise (owner decision 1 on #5000): a folded move
 * (#4268, `ownTransfer`) and an inbound row whose sender is another of the
 * user's own accounts (#4099's "From <account>") never carry the marker.
 *
 * ## What it does not do
 *
 * It reads; it never writes. A failed read leaves every row unmarked (the rows
 * read "Deposit", as before) and is logged: the marker is display, and a
 * Sales outage must not take the feed down. It is wired by the routes AFTER
 * `mergeSortDedupeAndEnrich` (and the fold), never inside
 * `enrichTransactionsWithAgents`, so it cannot reach the per-account route.
 */
import type { FastifyBaseLogger } from 'fastify'
import { settlementTokenForChain } from '../../domain/chains.js'
import { listFeedSaleMarkers } from '../../infra/repositories/merchant-sales-reads.js'
import { labelProducts, resolveSalesScope } from './merchant-sales-reads.js'
import { foldOwnAccountTransfers } from './orchestration.js'
import type { EnrichedTransaction, SmartAccountRow, TransactionSaleMarker } from './types.js'

function locationKey(address: string, chainId: number): string {
  return `${address.toLowerCase()}:${chainId}`
}

/**
 * The feed with each sale row marked. Rows that are not sales come back as
 * the same objects; the order and length never change.
 */
export async function attachSaleMarkers(
  userId: string,
  transactions: EnrichedTransaction[],
  ownAccounts: ReadonlyArray<Pick<SmartAccountRow, 'account_address' | 'chain_id'>>,
  log?: FastifyBaseLogger,
): Promise<EnrichedTransaction[]> {
  try {
    const scope = await resolveSalesScope(userId)
    if (scope === null) return transactions
    const usdc = settlementTokenForChain(scope.chainId)?.address?.toLowerCase()
    if (!usdc) return transactions

    const own = new Set(ownAccounts.map((account) => locationKey(account.account_address, account.chain_id)))
    const isCandidate = (tx: EnrichedTransaction): boolean =>
      tx.direction === 'in' &&
      tx.accountId === scope.accountId &&
      tx.chainId === scope.chainId &&
      tx.ownTransfer === undefined &&
      tx.tokenAddress?.toLowerCase() === usdc &&
      !own.has(locationKey(tx.from, tx.chainId))

    const hashes = transactions.filter(isCandidate).map((tx) => tx.hash.toLowerCase())
    if (hashes.length === 0) return transactions

    const rows = await listFeedSaleMarkers(scope, hashes)
    if (rows.length === 0) return transactions

    const products = new Map<string, string | null>()
    for (const row of rows) {
      if (row.kind === 'sale' && row.product_id !== null && !products.has(row.product_id)) {
        products.set(row.product_id, row.product_name)
      }
    }
    const labels =
      products.size === 0
        ? new Map<string, string>()
        : await labelProducts(
            scope.accountId,
            Array.from(products, ([productId, recordName]) => ({ productId, recordName })),
          )

    const markers = new Map<string, TransactionSaleMarker>()
    for (const row of rows) {
      const recorded = row.kind === 'sale'
      markers.set(row.tx_hash, {
        productId: recorded ? row.product_id : null,
        productName: recorded && row.product_id !== null ? (labels.get(row.product_id) ?? row.product_id) : null,
        receiptNumber: recorded ? row.receipt_number : null,
        merchantReference: recorded ? row.merchant_reference : null,
      })
    }

    return transactions.map((tx) => {
      if (!isCandidate(tx)) return tx
      const sale = markers.get(tx.hash.toLowerCase())
      return sale ? { ...tx, sale } : tx
    })
  } catch (err) {
    log?.warn({ err }, 'Sale marker read failed; rows left unmarked')
    return transactions
  }
}

/**
 * The step every feed route runs after `mergeSortDedupeAndEnrich`: the
 * own-account fold (#4265/#4268) when asked for, then the sale marker over
 * EVERY row, before any filter, so a search for a product label and #5001's
 * sales filter read the same rows the list shows. The marker comes after the
 * fold, so a folded move never carries it. The CSV export runs it too; its
 * columns and cells do not change.
 */
export async function foldAndMarkSales(
  userId: string,
  enriched: EnrichedTransaction[],
  accounts: SmartAccountRow[],
  options: { fold: boolean; log?: FastifyBaseLogger },
): Promise<EnrichedTransaction[]> {
  const folded = options.fold ? foldOwnAccountTransfers(enriched, accounts) : enriched
  return attachSaleMarkers(userId, folded, accounts, options.log)
}

/** The marker as `GET /transactions` sends it: the product id stays on the server. */
export function saleWire<T extends { sale?: TransactionSaleMarker }>(
  tx: T,
): Omit<T, 'sale'> & { sale?: Omit<TransactionSaleMarker, 'productId'> } {
  if (tx.sale === undefined) return tx
  const { productId: _productId, ...sale } = tx.sale
  return { ...tx, sale }
}
