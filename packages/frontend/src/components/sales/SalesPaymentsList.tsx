'use client'

import { TransactionMovement } from '@/components/haven/TransactionMovement'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ListShowMore } from '@/components/ui/ListToolbar'
import {
  TransactionActivityDayHeader,
  TransactionActivityRow,
  TransactionActivityRowSkeleton,
  transactionDayGroups,
} from '@/components/haven/TransactionActivityRow'
import { SALES_STATUS } from '@/lib/payment-status'
import { formatClockTime } from '@/lib/format'
import {
  SALES_PAGE_SIZE,
  payerSubline,
  salesAmountText,
  salesInFiat,
  usdcOf,
  type SalesPayment,
} from '@/lib/sales'
import type { UseSalesPaymentsResult } from '@/hooks/useSalesPayments'

type DisplayCurrency = 'USD' | 'EUR' | 'SEK'

/** The amount props a ledger row takes, in the display currency's mode. */
function rowAmount(raw: string, currency: DisplayCurrency) {
  if (salesInFiat(currency)) return { value: '', fiat: { amount: usdcOf(raw), currency: 'USD' as const } }
  return { value: salesAmountText(raw, currency).replace(/ USDC$/, ''), asset: 'USDC' }
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
 * The row has no second mark yet. A later mark ("Received in Stripe", #4954,
 * `held_by` on the wire) goes in `extraBadges`; today every payment, whatever
 * its `held_by`, renders as any sale.
 */
export function SalesLedgerRow({
  payment,
  currency,
  merchantName,
  insetDivider,
  onOpen,
}: {
  payment: SalesPayment
  currency: DisplayCurrency
  merchantName: string
  insetDivider: boolean
  onOpen: () => void
}) {
  const shared = {
    ...rowAmount(payment.amount_raw, currency),
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
    />
  )
}

/**
 * The payments list under the breakdowns: a summary line, the day-grouped
 * ledger inside one Card, "Show N more" paging that asks for exactly the next
 * cursor, and the sentence that points to Transactions. No search and no
 * facets: the reads cannot filter, so a control would be dead.
 */
export function SalesPaymentsList({
  list,
  total,
  revenueText,
  currency,
  merchantName,
  onOpenPayment,
}: {
  list: UseSalesPaymentsResult
  /** Every payment the period has, from the summary — never the loaded count. */
  total: number
  revenueText: string
  currency: DisplayCurrency
  merchantName: string
  onOpenPayment: (txHash: string) => void
}) {
  const { payments, loading, loadingMore, failed, hasMore, loadMore, refetch } = list

  return (
    <section aria-labelledby="sales-payments-heading" data-testid="sales-payments">
      <h2 id="sales-payments-heading" className="text-base font-semibold text-[var(--v2-ink)]">
        Payments
      </h2>
      <p className="v2-tabular mt-2 flex flex-wrap gap-x-4 text-sm text-[var(--v2-ink-2)]" data-testid="sales-payments-summary">
        <span>
          {total} {total === 1 ? 'payment' : 'payments'}
        </span>
        <span>Revenue {revenueText}</span>
      </p>

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
                    currency={currency}
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

      <p className="mt-3 px-0.5 text-xs text-[var(--v2-ink-3)]">
        The same payments, with every other account&apos;s, are in{' '}
        <Link
          href="/transactions"
          className="rounded font-medium text-[var(--v2-brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
        >
          Transactions
        </Link>
        . Sales adds what each payment was for and leaves your own moves out of the totals.
      </p>
    </section>
  )
}
