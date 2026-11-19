'use client'

import { TransactionMovement } from '@/components/haven/TransactionMovement'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ListNoMatch, ListShowMore, ListToolbar } from '@/components/ui/ListToolbar'
import { InlineAlert } from '@/components/ui/InlineAlert'
import type { ListFacet } from '@/components/ui/FacetMenu'
import type { ListNoun } from '@/components/ui/list-controls-copy'
import type { ListState } from '@/components/ui/list-url-codec'
import {
  TransactionActivityDayHeader,
  TransactionActivityRow,
  TransactionActivityRowSkeleton,
  transactionDayGroups,
} from '@/components/haven/TransactionActivityRow'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { SALES_STATUS } from '@/lib/payment-status'
import { formatClockTime } from '@/lib/format'
import {
  SALES_PAGE_SIZE,
  STRIPE_MARK,
  isStripeHeld,
  payerSubline,
  salesAmountText,
  salesFiatAmount,
  usdcOf,
  type SalesMoney,
  type SalesPayment,
} from '@/lib/sales'
import type { UseSalesPaymentsResult } from '@/hooks/useSalesPayments'

/** The amount props a ledger row takes, in the display currency's mode. */
function rowAmount(raw: string, money: SalesMoney) {
  const fiat = salesFiatAmount(usdcOf(raw), money)
  // A row is never marked "≈" (the kinds table, #4963).
  if (fiat !== null) return { value: '', fiat: { amount: fiat, currency: money.currency } }
  return { value: salesAmountText(raw, money).replace(/ USDC$/, ''), asset: 'USDC' }
}

/**
 * One payment, as a ledger row (#4900): the SAME `TransactionActivityRow` the
 * Transactions ledger uses, in sale title mode (#4908) — the product is the
 * title and the payer the subline.
 *
 * - a sale: the product's name; the amount is income;
 * - a payment with no sale record: "No product recorded", muted — never a
 *   blank, never the payer moved up into the title;
 * - a move from the owner's own account or agent: "Moved between your
 *   accounts", the move mark and "Not counted", its amount not signed as income.
 *
 * - a sale received at a registered Stripe deposit address (#4954, `held_by`
 *   `stripe`): the product's name and the "Received in Stripe" mark, as a
 *   plain pill in `extraBadges` (nothing inside a ledger row is a control).
 */
export function SalesLedgerRow({
  payment,
  money,
  merchantName,
  insetDivider,
  onOpen,
}: {
  payment: SalesPayment
  money: SalesMoney
  merchantName: string
  insetDivider: boolean
  onOpen: () => void
}) {
  const shared = {
    ...rowAmount(payment.amount_raw, money),
    timestamp: formatClockTime(payment.block_time),
    density: 'compact' as const,
    insetDivider,
    onOpen,
  }

  if (payment.kind === 'own_move') {
    const from = payment.payer?.name ?? 'Your account'
    return (
      <TransactionActivityRow
        {...shared}
        title="Moved between your accounts"
        direction="move"
        description={<TransactionMovement from={from} to={merchantName} bare />}
        status={SALES_STATUS.not_counted.label}
        statusTone={SALES_STATUS.not_counted.tone}
      />
    )
  }

  const subline = payerSubline(payment.payer, payment.several_payers)
  if (payment.kind === 'no_product') {
    return (
      <TransactionActivityRow
        {...shared}
        title="No product recorded"
        mutedTitle
        direction="in"
        description={subline}
      />
    )
  }
  return (
    <TransactionActivityRow
      {...shared}
      title={payment.product_label ?? payment.product_id ?? 'Sale'}
      direction="in"
      description={subline}
      extraBadges={
        isStripeHeld(payment) ? <StatusBadge tone={STRIPE_MARK.tone}>{STRIPE_MARK.label}</StatusBadge> : undefined
      }
    />
  )
}

export const SALES_PAYMENT_NOUN: ListNoun = { one: 'payment', other: 'payments' }

/** The list controls the page owns (#4960): the URL state and its clear generation. */
export interface SalesListControls {
  state: ListState
  onChange: (next: ListState) => void
  searchEpoch: number
  bumpSearchEpoch: () => void
}

/**
 * The payments list under the breakdowns: the list controls (#4960: search,
 * and the Product, Payer and Recorded facets, in the shared `ListToolbar`),
 * the day-grouped ledger inside one Card, "Show N more" paging that asks for
 * exactly the next cursor, and the sentence that points to Transactions.
 *
 * The count is the read's own `total` for the filter set, beside the period's
 * unfiltered total while a filter is on ("12 of 60 payments"); the summary
 * line's Revenue reads the filtered summary, so line, rows and figures above
 * describe one set. With a filter on and nothing matching, the standard
 * no-match state stands in for the rows, under the toolbar that set it.
 */
export function SalesPaymentsList({
  list,
  periodTotal,
  revenueText,
  splitText = null,
  money,
  merchantName,
  onOpenPayment,
  controls,
  facets,
  filtered,
  onClearFilters,
  facetsFailed = false,
}: {
  list: UseSalesPaymentsResult
  /** The period's payments with no filter; null while unread. Only asked for while `filtered`. */
  periodTotal: number | null
  /** The filtered summary's Revenue, as text; null while it loads. */
  revenueText: string | null
  /** "{in Haven} in Haven · {in Stripe} in Stripe" when the period has Stripe-held sales (#4981); null when it has none. */
  splitText?: string | null
  money: SalesMoney
  merchantName: string
  onOpenPayment: (txHash: string) => void
  controls: SalesListControls
  facets: ListFacet[]
  /** True when a filter or a search reaches the reads. */
  filtered: boolean
  onClearFilters: () => void
  /** The facets read failed: the Product and Payer menus have no options, and the page says why. */
  facetsFailed?: boolean
}) {
  const { payments, loading, loadingMore, failed, hasMore, loadMore, refetch } = list
  const total = list.total ?? 0
  const count =
    list.total === null
      ? null
      : filtered
        ? periodTotal === null
          ? null
          : { shown: list.total, total: periodTotal }
        : { shown: list.total, total: list.total }
  const showNoMatch = filtered && !loading && !failed && list.total === 0
  // The period lives in the page header, not in this toolbar: a change the
  // toolbar makes (its own Clear filters included) never moves it.
  const onChange = (next: ListState) => controls.onChange({ ...next, period: controls.state.period })

  return (
    <section aria-labelledby="sales-payments-heading" data-testid="sales-payments">
      <h2 id="sales-payments-heading" className="mb-3 text-base font-semibold text-[var(--v2-ink)]">
        Payments
      </h2>
      <ListToolbar
        noun={SALES_PAYMENT_NOUN}
        state={controls.state}
        onChange={onChange}
        filtering="server"
        facets={facets}
        searchDescription="by product, payer or receipt number"
        searchEpoch={controls.searchEpoch}
        count={count}
        summary={
          revenueText !== null ? (
            <span className="v2-tabular" data-testid="sales-payments-summary">
              Revenue {revenueText}
              {splitText ? <> ({splitText})</> : null}
            </span>
          ) : undefined
        }
      />

      {/* The list controls' filter-options alert, under the summary line, as
          Transactions places it: the menus are empty for a reason. */}
      {facetsFailed ? (
        <div className="mt-2" data-testid="sales-facets-error">
          <InlineAlert>Product and payer filters could not load. Search still finds them.</InlineAlert>
        </div>
      ) : null}

      {showNoMatch ? (
        <div className="mt-3" data-testid="sales-no-match">
          <ListNoMatch noun={SALES_PAYMENT_NOUN} onClear={onClearFilters} />
        </div>
      ) : (
      <Card hover={false} className="mt-3 overflow-hidden">
        {loading ? (
          <div
            className="divide-y divide-[var(--v2-border)]"
            role="status"
            aria-busy="true"
            aria-label="Loading payments"
          >
            {[0, 1, 2].map((item) => (
              <TransactionActivityRowSkeleton key={item} density="compact" />
            ))}
          </div>
        ) : failed && payments.length === 0 ? (
          <div className="p-6">
            <EmptyState
              bare
              title="Payments could not load"
              body="Your payments are unchanged."
              className="py-8"
              action={
                <Button variant="ghost" size="sm" onClick={refetch}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : (
          <div className="divide-y divide-[var(--v2-border)]" data-testid="sales-ledger">
            {transactionDayGroups(payments, (payment) => payment.block_time).map((day) => (
              <div key={day.dayKey}>
                <TransactionActivityDayHeader label={day.label} />
                {day.items.map((payment, index) => (
                  <SalesLedgerRow
                    key={payment.tx_hash}
                    payment={payment}
                    money={money}
                    merchantName={merchantName}
                    insetDivider={index > 0}
                    onOpen={() => onOpenPayment(payment.tx_hash)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
        {!loading && failed && payments.length > 0 ? (
          <p role="alert" className="border-t border-[var(--v2-border)] px-5 py-3 text-xs text-[var(--v2-ink-3)]">
            More payments could not load. Try again.
          </p>
        ) : null}
        {!loading && (
          <ListShowMore
            loaded={payments.length}
            total={total}
            pageSize={SALES_PAGE_SIZE}
            hasMore={hasMore}
            loading={loadingMore}
            onShowMore={loadMore}
          />
        )}
      </Card>
      )}

      <p className="mt-3 px-0.5 text-xs text-[var(--v2-ink-3)]">
        The same payments, with every other account&apos;s, are in{' '}
        <Link
          href="/transactions"
          className="rounded font-medium text-[var(--v2-brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
        >
          Transactions
        </Link>
        . Sales adds what each payment was for and leaves your own moves out of the totals.
        {splitText ? ' Sales received in Stripe went to your Stripe address, so they are not in Transactions.' : null}
      </p>
    </section>
  )
}
