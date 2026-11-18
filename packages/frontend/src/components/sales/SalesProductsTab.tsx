'use client'

import { useState } from 'react'
import { Package } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/Icon'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Row } from '@/components/ui/Row'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Table } from '@/components/ui/Table'
import NetworkPill from '@/components/NetworkPill'
import { NoticeRow } from '@/components/haven/NoticeRow'
import { useMerchantServicesContext } from '@/context/MerchantServicesContext'
import { useSalesSummary } from '@/hooks/useSalesSummary'
import type { UseMerchantCatalogueResult } from '@/hooks/useMerchantCatalogue'
import { resolveChainOrNull } from '@/lib/chains'
import { formatDateTime, timeAgo, truncate } from '@/lib/format'
import { SALES_STATUS } from '@/lib/payment-status'
import {
  catalogueChainId,
  catalogueHost,
  catalogueView,
  salesRangeDays,
  usdcExactText,
  type SalesCatalogue,
  type SalesCatalogueProduct,
  type SalesDayRange,
  type SalesSummary,
} from '@/lib/sales'

const CELL = 'px-4 py-3'

/** What the Products description says in every state: Haven reads, the owner edits in the kit. */
const DESCRIPTION = 'Read from your kit. To change a product, change it in your kit; Haven picks it up on the next read.'

function chainName(chainId: number | undefined): string | null {
  return chainId === undefined ? null : (resolveChainOrNull(chainId)?.name ?? null)
}

/** The warning the mismatch state shows: where the kit's list says payments go, against this account. */
export function mismatchText(
  catalogue: SalesCatalogue,
  account: { name: string; chain_id: number } | null,
): string {
  const theirs = chainName(catalogueChainId(catalogue.document_network))
  const ours = account ? chainName(account.chain_id) : null
  const where =
    catalogue.document_pay_to && theirs && ours && account
      ? `Its product list says payments go to ${truncate(catalogue.document_pay_to)} on ${theirs}, not to ${account.name} on ${ours}.`
      : 'Its product list names a different receiving address or network.'
  return `${where} Haven isn’t using these product names until they match. Update the payment address and network in your kit.`
}

/** Sales per product in the period, from the summary's by-product lines; "—" when the summary has no answer for it. */
function salesCount(summary: SalesSummary | null, productId: string): string {
  if (summary === null) return '—'
  const line = summary.by_product.find((p) => p.product_id === productId)
  if (line) return String(line.sales)
  return summary.by_product_other.products > 0 ? '—' : '0'
}

/** The freshness line in `Card.Header`'s actions slot (design-system § Card header freshness line). */
function FreshnessSlot({ catalogue, reading, onReadNow }: { catalogue: SalesCatalogue; reading: boolean; onReadNow: () => void }) {
  const host = catalogue.deployment_url ? catalogueHost(catalogue.deployment_url) : ''
  const failedRead = ['unreachable', 'malformed', 'refused'].includes(catalogue.last_read_status)
  const when = catalogue.last_read_at
  return (
    // Stacked below `sm`: `Card.Header`'s actions slot never shrinks, so a
    // single row of line plus button is wider than a phone's card (measured at
    // 390px: "Read now" clipped). The cap keeps a long host inside the viewport.
    <div
      className="flex max-w-[calc(100vw-6rem)] flex-col items-start gap-2 sm:max-w-none sm:flex-row sm:items-center sm:gap-3"
      data-testid="sales-products-freshness"
    >
      <span className="min-w-0 break-words text-xs text-[var(--v2-ink-3)]" title={when ? formatDateTime(when) : undefined}>
        {when === null
          ? `Not read yet from ${host}`
          : failedRead
            ? `Last tried ${timeAgo(when)} · ${host}`
            : `Read from ${host} · ${timeAgo(when)}`}
      </span>
      <Button variant="ghost" size="sm" onClick={onReadNow} disabled={reading}>
        {reading ? 'Reading…' : 'Read now'}
      </Button>
    </div>
  )
}

function ProductStatus({ product }: { product: SalesCatalogueProduct }) {
  return product.offered ? (
    <span className="text-sm text-[var(--v2-ink-2)]">Offered</span>
  ) : (
    <StatusBadge tone={SALES_STATUS.no_longer_offered.tone}>{SALES_STATUS.no_longer_offered.label}</StatusBadge>
  )
}

function ProductsTable({
  products,
  summary,
  days,
  dimmed,
}: {
  products: SalesCatalogueProduct[]
  summary: SalesSummary | null
  days: number
  dimmed: boolean
}) {
  return (
    <div className={dimmed ? 'opacity-75' : undefined} data-testid="sales-products-table">
      <div className="hidden lg:block">
        <Table>
          <Table.Head collapseWhenNarrow={false}>
            <tr>
              <Table.HeaderCell align="left">Product</Table.HeaderCell>
              <Table.HeaderCell align="right">Price</Table.HeaderCell>
              <Table.HeaderCell align="left">Network</Table.HeaderCell>
              <Table.HeaderCell align="right">{`Sales, ${days} days`}</Table.HeaderCell>
              <Table.HeaderCell align="left">Status</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {products.map((product) => {
              const chainId = catalogueChainId(product.network)
              return (
                <tr
                  key={product.product_id}
                  className="transition-colors duration-150 hover:bg-[var(--v2-surface-hover)]"
                >
                  <td className={CELL}>
                    <span className="inline-flex flex-col">
                      <span className={`text-sm font-medium ${product.offered ? 'text-[var(--v2-ink)]' : 'text-[var(--v2-ink-3)]'}`}>
                        {product.name ?? product.product_id}
                      </span>
                      {product.name ? (
                        <span className="font-mono text-xs text-[var(--v2-ink-3)]">{product.product_id}</span>
                      ) : null}
                    </span>
                  </td>
                  <td className={`${CELL} text-right`}>
                    <span className="v2-tabular text-sm font-medium text-[var(--v2-ink)]">{usdcExactText(product.price_atomic)}</span>
                  </td>
                  <td className={CELL}>
                    {chainId !== undefined ? (
                      <NetworkPill chainId={chainId} />
                    ) : (
                      <span className="text-xs text-[var(--v2-ink-3)]">{product.network}</span>
                    )}
                  </td>
                  <td className={`${CELL} text-right`}>
                    <span className="v2-tabular text-sm text-[var(--v2-ink-2)]">{salesCount(summary, product.product_id)}</span>
                  </td>
                  <td className={CELL}>
                    <ProductStatus product={product} />
                  </td>
                </tr>
              )
            })}
          </Table.Body>
        </Table>
      </div>

      <div className="divide-y divide-[var(--v2-table-row-border)] lg:hidden">
        {products.map((product) => {
          const count = salesCount(summary, product.product_id)
          return (
            <div key={product.product_id} className="px-4 py-3">
              <Row
                title={<span className={`truncate ${product.offered ? '' : 'text-[var(--v2-ink-3)]'}`}>{product.name ?? product.product_id}</span>}
                subtitle={
                  <span className="v2-tabular">
                    {product.name ? <span className="font-mono">{product.product_id}</span> : null}
                    {product.name ? ' · ' : null}
                    {count} {count === '1' ? 'sale' : 'sales'}
                    {product.offered ? null : (
                      <>
                        {' · '}
                        <StatusBadge tone={SALES_STATUS.no_longer_offered.tone}>{SALES_STATUS.no_longer_offered.label}</StatusBadge>
                      </>
                    )}
                  </span>
                }
                trailing={<span className="v2-tabular text-sm font-medium text-[var(--v2-ink)]">{usdcExactText(product.price_atomic)}</span>}
                density="flush"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The Products tab (#4900, approved on #4894): the product list Haven read
 * from the kit's discovery document, prices in exact USDC (a token surface),
 * the network, how each product sold in the page's period, and whether the kit
 * still offers it. Haven does not edit products; the owner changes them in the
 * kit.
 *
 * States, from the one catalogue read: no address saved (a bare empty state
 * pointing to Setup); a good list; a mismatch (the kit's document names another
 * receiving address or network, so Haven is not using its names); and a kit
 * that could not be read (the last good list stays, sales keep counting). The
 * freshness line sits in the card header with "Read now".
 */
export function SalesProductsTab({
  catalogue,
  range,
  onOpenSetup,
}: {
  catalogue: UseMerchantCatalogueResult
  range: SalesDayRange
  onOpenSetup: () => void
}) {
  const { merchantAccount } = useMerchantServicesContext()
  const summary = useSalesSummary(range)
  const [readError, setReadError] = useState<string | null>(null)
  const days = salesRangeDays(range)

  const readNow = async () => {
    setReadError(null)
    const result = await catalogue.readNow()
    if (!result.ok) setReadError(result.message)
  }

  const { data, loading, failed } = catalogue

  if (loading && data === null) {
    return (
      <div className="mt-6" data-testid="sales-products-tab">
        <Card hover={false} className="overflow-hidden">
          <Card.Header as="h2" title="Products" description={DESCRIPTION} />
          <div role="status" aria-busy="true" aria-label="Loading products" className="space-y-3 p-5">
            <Skeleton variant="text" className="h-4 w-full" />
            <Skeleton variant="text" className="h-4 w-full" />
            <Skeleton variant="text" className="h-4 w-2/3" />
          </div>
        </Card>
      </div>
    )
  }

  if (failed || data === null) {
    return (
      <div className="mt-6" data-testid="sales-products-tab">
        <EmptyState
          title="Products could not load"
          body="Your payments are unchanged."
          action={
            <Button variant="ghost" size="sm" onClick={catalogue.reload}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  const view = catalogueView(data)

  if (view === 'none') {
    return (
      <div className="mt-6" data-testid="sales-products-tab">
        <Card hover={false} className="overflow-hidden">
          <Card.Header as="h2" title="Products" description="Read from your kit. Haven doesn’t edit them." />
          <div className="p-5" data-testid="sales-products-none">
            <EmptyState
              bare
              icon={<Icon icon={Package} className="h-full w-full" />}
              tone="brand"
              title="No kit address yet"
              body="Add your kit’s address on Setup, and Haven reads your product list from it. Until then, sales show the product name your kit sends."
              action={
                <Button variant="ghost" size="sm" onClick={onOpenSetup}>
                  Go to Setup
                </Button>
              }
            />
          </div>
        </Card>
      </div>
    )
  }

  const warning: { headline: string; text: string } | null =
    view === 'mismatch'
      ? { headline: 'Your kit isn’t set up for this Sales account.', text: mismatchText(data, merchantAccount) }
      : view === 'unreachable'
        ? {
            headline: 'Haven couldn’t read your kit just now.',
            text: 'The address didn’t answer. This list is from the last good read, and sales keep counting. Haven tries again every 15 minutes.',
          }
        : view === 'malformed'
          ? {
              headline: 'Haven couldn’t find a product list at your kit’s address.',
              text: 'This list is from the last good read, and sales keep counting. Check that the address is where your kit runs.',
            }
          : view === 'refused'
            ? {
                headline: 'Haven can’t read that address.',
                text: 'Use the public https address of your kit, without a port or login. Sales keep counting.',
              }
            : null

  return (
    <div className="mt-6 space-y-4" data-testid="sales-products-tab">
      {warning ? (
        <div data-testid={`sales-products-${view}`}>
          <NoticeRow
            action={
              view === 'refused' || view === 'malformed' ? (
                <Button variant="ghost" size="sm" onClick={onOpenSetup}>
                  Go to Setup
                </Button>
              ) : undefined
            }
          >
            <strong className="font-semibold text-[var(--v2-ink)]">{warning.headline}</strong> {warning.text}
          </NoticeRow>
        </div>
      ) : null}

      <Card hover={false} className="overflow-hidden">
        <Card.Header
          as="h2"
          title="Products"
          description={DESCRIPTION}
          actions={<FreshnessSlot catalogue={data} reading={catalogue.reading} onReadNow={() => void readNow()} />}
        />
        {readError ? (
          <div className="px-5 pt-4" data-testid="sales-products-read-error">
            <InlineAlert>{readError}</InlineAlert>
          </div>
        ) : null}
        {data.products.length > 0 ? (
          <ProductsTable products={data.products} summary={summary.data} days={days} dimmed={view === 'mismatch'} />
        ) : view === 'ok' || view === 'never' ? (
          <div className="p-5" data-testid="sales-products-empty">
            <EmptyState
              bare
              icon={<Icon icon={Package} className="h-full w-full" />}
              tone="brand"
              title={view === 'never' ? 'No products read yet' : 'Your kit lists no products'}
              body={
                view === 'never'
                  ? 'Haven reads your kit’s address on a schedule. Press Read now to do it straight away.'
                  : 'Haven read your kit, and its product list is empty. Add products in your kit; Haven picks them up on the next read.'
              }
            />
          </div>
        ) : null}
      </Card>
    </div>
  )
}

export default SalesProductsTab
