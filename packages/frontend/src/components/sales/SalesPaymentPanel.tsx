'use client'

import { useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { HAVEN_FALLBACK_NAME } from '@haven_ai/core'
import { Amount, DirectionMark, NoticeRow } from '@/components/haven'
import ConfirmDialog from '@/components/ConfirmDialog'
import NetworkPill from '@/components/NetworkPill'
import { DetailRow, OnChainValue } from '@/components/transactions/TransactionDetailPanel'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Monogram } from '@/components/ui/Monogram'
import { SidePanel } from '@/components/ui/SidePanel'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useToast } from '@/components/ui/Toast'
import { useMerchantServicesContext } from '@/context/MerchantServicesContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useSalesPaymentDetail } from '@/hooks/useSalesPaymentDetail'
import { api, ApiRequestError } from '@/lib/api'
import { getExplorerUrlOrNull } from '@/lib/chains'
import { formatDateTime, truncate } from '@/lib/format'
import { SALES_STATUS } from '@/lib/payment-status'
import {
  isOnChainHash,
  salesApprox,
  salesFiatAmount,
  tokenText,
  usdcOf,
  type SalesMoney,
  type SalesPayer,
  type SalesPaymentDetail,
} from '@/lib/sales'

/**
 * One sale's detail panel (#4900, approved on #4894): the Transaction detail
 * panel's anatomy on the Sales reads — a header that leads with the product,
 * the amount and its status, one line saying who paid and when, a few
 * plain-word Details rows, and every address and hash behind the Technical
 * details disclosure. It reuses `SidePanel` and the transaction panel's own
 * `DetailRow` / `OnChainValue`; nothing here is a second copy of them.
 *
 * The page's contract is `txHash` (the payment, `null` is closed) and
 * `onClose`. Two optional callbacks let the page refresh what is under the
 * panel: `onCleared` after a sale record is cleared, and `onOpenSetup` for the
 * notice in the clear dialog that points to the Sales keys.
 *
 * **Received is Sales-only.** `SALES_STATUS.received` is the status here for a
 * sale and for a payment with no sale record; /transactions' panel keeps its
 * own "Sent" fallback for deposits.
 *
 * The panel reads only what the reads carry. It omits, rather than invents,
 * whatever a row lacks: `legs` is empty for a payment with no inbound leg, and
 * a payment held by Stripe (#4952) has no on-chain hash to show or link.
 */
export interface SalesPaymentPanelProps {
  /** The payment to show; `null` keeps the panel closed. */
  txHash: string | null
  onClose: () => void
  /** The sale record was cleared: refresh the list row and the summary under the panel. */
  onCleared?: () => void
  /** Go to the Setup tab, where the Sales keys are. Closes the panel on the page's side. */
  onOpenSetup?: () => void
}

export function SalesPaymentPanel({ txHash, onClose, onCleared, onOpenSetup }: SalesPaymentPanelProps) {
  if (txHash === null) return null
  return <OpenPanel key={txHash} txHash={txHash} onClose={onClose} onCleared={onCleared} onOpenSetup={onOpenSetup} />
}

/** The payer in words for the Details row, with the line under it. */
function payerDetail(payment: SalesPaymentDetail): { value: string; note?: string } | null {
  const payer = payment.payer
  if (payer === null) {
    return payment.several_payers ? { value: 'Several wallets', note: 'More than one wallet paid in this transaction' } : null
  }
  if (payer.kind === 'contact' && payer.name) return { value: payer.name, note: 'One of your contacts' }
  if (payer.kind === 'own' && payer.name) return { value: payer.name, note: 'Your own account or agent' }
  return { value: 'Wallet', note: 'Not one of your contacts or agents' }
}

/** The payer in the header line: a name, or a wallet with its short address. */
export function payerPhrase(payer: SalesPayer | null, severalPayers: boolean): string | null {
  if (payer === null) return severalPayers ? 'several wallets' : null
  if (payer.kind !== 'wallet' && payer.name) return payer.name
  return `Wallet (${truncate(payer.address)})`
}

function whoLine(payment: SalesPaymentDetail, accountName: string): string {
  const payer = payerPhrase(payment.payer, payment.several_payers)
  if (payment.kind === 'own_move') return `By ${payer ?? 'your account'} into ${accountName}`
  return payer ? `Paid by ${payer} into ${accountName}` : `Paid into ${accountName}`
}

function PanelBodySkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading payment" data-testid="sales-payment-loading">
      <Skeleton variant="text" className="h-7 w-32" />
      <Skeleton variant="text" className="mt-3 h-3 w-56" />
      <Skeleton variant="text" className="mt-6 h-3 w-full" />
      <Skeleton variant="text" className="mt-3 h-3 w-full" />
      <Skeleton variant="text" className="mt-3 h-3 w-full" />
    </div>
  )
}

function OpenPanel({
  txHash,
  onClose,
  onCleared,
  onOpenSetup,
}: SalesPaymentPanelProps & { txHash: string }) {
  const { currency } = usePreferences()
  const { merchantAccount } = useMerchantServicesContext()
  const { toast } = useToast()
  const { detail, loading, notFound, failed, refetch } = useSalesPaymentDetail(txHash)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

  const accountName = merchantAccount?.name ?? 'Sales'
  const chainId = merchantAccount?.chain_id ?? null

  const closeConfirm = () => {
    setConfirmOpen(false)
    setClearError(null)
  }

  const clearRecord = async () => {
    setClearing(true)
    setClearError(null)
    try {
      await api.delete(`/merchant-sales/payments/${encodeURIComponent(txHash)}/record`)
      setConfirmOpen(false)
      toast.success('Sale record cleared. The payment stays.')
      refetch()
      onCleared?.()
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        // Already gone (cleared elsewhere, or never there): the panel is stale, not the action wrong.
        setClearError('This payment has no sale record to clear. It may already be cleared.')
        refetch()
        onCleared?.()
      } else if (err instanceof ApiRequestError && err.message) {
        setClearError(err.message)
      } else {
        setClearError('The sale record could not be cleared. Nothing changed. Try again.')
      }
    } finally {
      setClearing(false)
    }
  }

  if (loading || detail === null) {
    return (
      <SidePanel open onClose={onClose} title="Payment">
        {loading ? (
          <PanelBodySkeleton />
        ) : (
          <div data-testid="sales-payment-error" className="space-y-3 text-sm text-[var(--v2-ink-2)]">
            <p>
              {notFound ? 'This payment is not on your Sales account.' : 'This payment could not load. Your payments are unchanged.'}
            </p>
            {failed ? (
              <Button variant="ghost" size="sm" onClick={refetch}>
                Try again
              </Button>
            ) : null}
          </div>
        )}
      </SidePanel>
    )
  }

  const own = detail.kind === 'own_move'
  const hasRecord = detail.kind === 'sale'
  const status = own ? SALES_STATUS.not_counted : SALES_STATUS.received
  const title = own
    ? HAVEN_FALLBACK_NAME.movedBetweenAccounts
    : detail.kind === 'no_product'
      ? 'No product recorded'
      : (detail.product_label ?? detail.product_id ?? 'Sale')
  const payerIsContact = !own && detail.payer?.kind === 'contact' && !!detail.payer.name
  const leading = payerIsContact ? (
    <Monogram name={detail.payer!.name!} decorative />
  ) : (
    <DirectionMark direction={own ? 'move' : 'in'} />
  )

  const human = usdcOf(detail.amount_raw)
  // The panel strikes its figure with the DETAIL read's own rate.
  const money: SalesMoney = { currency, chainId, rates: detail.usdc_rates ?? undefined }
  const fiatAmount = salesFiatAmount(human, money)
  const tokenFigure = tokenText(human).replace(/ USDC$/, '')
  const direction = own ? undefined : ('in' as const)
  const payerRow = payerDetail(detail)

  const details = []
  if (own) {
    details.push(<DetailRow key="by" label="By" value={detail.payer?.name ?? 'Your account'} />)
    details.push(<DetailRow key="to" label="Into" value={accountName} />)
  } else {
    details.push(
      <DetailRow
        key="product"
        label="Product"
        value={
          detail.kind === 'no_product' ? (
            <span className="text-[var(--v2-ink-3)]">None</span>
          ) : (
            (detail.product_label ?? detail.product_id ?? '—')
          )
        }
        note={detail.kind === 'sale' && detail.product_id && detail.product_id !== detail.product_label ? detail.product_id : undefined}
      />,
    )
    if (payerRow) details.push(<DetailRow key="payer" label="Payer" value={payerRow.value} note={payerRow.note} />)
    details.push(<DetailRow key="record" label="Sale record" value={hasRecord ? 'Sent' : 'Not sent'} />)
    if (detail.receipt_number) details.push(<DetailRow key="receipt" label="Receipt number" value={detail.receipt_number} />)
    if (detail.merchant_reference) {
      details.push(<DetailRow key="reference" label="Your reference" value={<span className="font-mono text-xs">{detail.merchant_reference}</span>} />)
    }
  }

  // Technical details: only what this row carries. A payment held by Stripe has
  // no on-chain hash, and a payment with no legs may have no payer address.
  const onChainHash = detail.held_by === 'account' && isOnChainHash(detail.tx_hash)
  const payerAddresses = [
    ...new Map(
      [...(detail.payer ? [detail.payer] : []), ...detail.legs.map((leg) => leg.payer)].map((payer) => [
        payer.address.toLowerCase(),
        payer.address,
      ]),
    ).values(),
  ]
  const technical = []
  if (chainId !== null) technical.push(<DetailRow key="network" label="Network" value={<NetworkPill chainId={chainId} />} />)
  if (chainId !== null) {
    payerAddresses.forEach((address, index) => {
      technical.push(
        <DetailRow
          key={`from-${address}`}
          label={payerAddresses.length > 1 ? `Paid from ${index + 1}` : 'Paid from'}
          value={<OnChainValue chainId={chainId} type="address" value={address} />}
        />,
      )
    })
    if (merchantAccount && onChainHash) {
      technical.push(
        <DetailRow
          key="to"
          label="Paid to"
          value={<OnChainValue chainId={chainId} type="address" value={merchantAccount.account_address} />}
          note={accountName}
        />,
      )
    }
    if (onChainHash) {
      technical.push(
        <DetailRow key="tx" label="Transaction" value={<OnChainValue chainId={chainId} type="tx" value={detail.tx_hash} />} />,
      )
    }
  }

  const explorerUrl = onChainHash ? getExplorerUrlOrNull(chainId, 'tx', detail.tx_hash) : null
  const footer =
    hasRecord || explorerUrl ? (
      <div className="flex items-center justify-between gap-3">
        <span>
          {hasRecord ? (
            <Button
              variant="tertiary"
              size="sm"
              // Plain tertiary, not a red one: `Button` has no danger-tertiary
              // variant (its ring colour travels with the variant, and a caller
              // cannot override it). The destructive weight is in the
              // confirmation's danger button.
              className="-ml-3.5"
              onClick={() => setConfirmOpen(true)}
            >
              Clear sale record
            </Button>
          ) : null}
        </span>
        {explorerUrl ? (
          <Button
            variant="tertiary"
            size="sm"
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            trailingIcon={ExternalLink}
          >
            View on explorer
          </Button>
        ) : null}
      </div>
    ) : undefined

  return (
    <>
      <SidePanel
        open
        onClose={onClose}
        leading={leading}
        title={title}
        subtitle={own ? 'Transfer' : 'Sale'}
        footer={footer}
      >
        <div data-testid="sales-payment-header" className="mb-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              {fiatAmount !== null ? (
                <>
                  <Amount
                    amount={fiatAmount}
                    currency={currency}
                    approx={salesApprox(money, 'detail')}
                    direction={direction}
                    size="lg"
                  />
                  <Amount value={tokenFigure} symbol="USDC" />
                </>
              ) : (
                <Amount value={tokenFigure} symbol="USDC" direction={direction} size="lg" />
              )}
            </div>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </div>
          <p className="mt-2 text-sm text-[var(--v2-ink-2)]">
            {whoLine(detail, accountName)} <span className="whitespace-nowrap">· {formatDateTime(detail.block_time)}</span>
          </p>
          {own ? (
            <NoticeRow className="mt-4">
              A payment from your own agent or account is a move, not a sale, so it is not in your revenue.
            </NoticeRow>
          ) : detail.kind === 'no_product' ? (
            <NoticeRow className="mt-4">
              Your kit sent no sale record for this payment. It still counts as revenue.
            </NoticeRow>
          ) : null}
        </div>

        <h3 className="mb-1 text-[13px] font-semibold text-[var(--v2-ink-3)]">Details</h3>
        <dl data-testid="sales-payment-details">{details}</dl>

        {technical.length > 0 ? (
          <details data-testid="sales-payment-technical" className="group mt-5 border-t border-[var(--v2-border)] pt-3">
            <summary className="flex w-full cursor-pointer select-none list-none items-center justify-between rounded py-1 text-sm font-medium text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 [&::-webkit-details-marker]:hidden">
              Technical details
              <Icon
                icon={ChevronDown}
                className="mr-1 h-4 w-4 flex-shrink-0 text-[var(--v2-ink-3)] transition-transform group-open:rotate-180"
              />
            </summary>
            <dl className="mt-2">{technical}</dl>
          </details>
        ) : null}
      </SidePanel>

      <ConfirmDialog
        open={confirmOpen}
        onCancel={closeConfirm}
        onConfirm={clearRecord}
        title="Clear this sale record?"
        body={
          <div className="space-y-3">
            <p className="text-[var(--v2-ink-2)]">
              The payment stays and still counts as revenue. It shows with no product until your kit reports it again.
            </p>
            <NoticeRow
              action={
                onOpenSetup ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      closeConfirm()
                      onOpenSetup()
                    }}
                  >
                    Sales keys
                  </Button>
                ) : undefined
              }
            >
              <strong className="font-semibold text-[var(--v2-ink)]">Think your Sales key leaked?</strong> Revoke it
              first. Until it is revoked, it can take this payment&apos;s record again.
            </NoticeRow>
          </div>
        }
        confirmLabel="Clear record"
        busyLabel="Clearing…"
        loading={clearing}
        error={clearError ? <InlineAlert>{clearError}</InlineAlert> : undefined}
      />
    </>
  )
}

export default SalesPaymentPanel
