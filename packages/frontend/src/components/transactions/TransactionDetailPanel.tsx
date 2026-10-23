'use client'

import { type ReactNode } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { SidePanel } from '@/components/ui/SidePanel'
import { Amount, DirectionMark, NoticeRow } from '@/components/haven'
import { Button } from '@haven_ai/ui/Button'
import { CopyButton } from '@haven_ai/ui/CopyButton'
import { Icon } from '@/components/ui/Icon'
import { Monogram } from '@/components/ui/Monogram'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { AccountingBadge } from '@/components/accounting/AccountingBadge'
import { getExplorerUrlOrNull } from '@/lib/chains'
import NetworkPill from '@/components/NetworkPill'
import { truncate } from '@/lib/format'
import { parseX402Hostname, paymentSourceTitle } from '@/lib/transaction-labels'
import { strandedFundsCauseWithLocation } from '@/lib/stranded-funds-copy'
import {
  counterpartyLabel,
  isDelegateSweep,
  settlementSchemeLabel,
  transactionFiat,
  transactionInitiator,
  transactionRowBadge,
} from '@/lib/transaction-presentation'
import type { AggregatedTransaction } from '@/types/transactions'

interface Props {
  transaction: AggregatedTransaction | null
  open: boolean
  onClose: () => void
  resolveAddress?: (address: string) => string | null
  accountNamesByAddress?: Map<string, string>
}

// ── Small presentational helpers ───────────────────────────────────

/**
 * One label/value row — the `dl` row the Details block and the Technical
 * details disclosure share (design-system § Technical details disclosure), so
 * the opened block reads as part of the panel. `note` is a one-line
 * explanation under the value.
 */
function DetailRow({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] items-baseline gap-3 border-b border-[var(--v2-table-row-border)] py-2.5 last:border-b-0">
      <dt className="text-xs text-[var(--v2-ink-3)]">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-[var(--v2-ink-2)]">
        <div>{value}</div>
        {note ? <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">{note}</p> : null}
      </dd>
    </div>
  )
}

/**
 * An address or hash in Technical details (#4267): shortened (`0x0415…b195`),
 * never wrapping, with copy and an explorer link. The full value is one copy
 * or one click away — this supersedes #3811's "render it in full" rule, whose
 * two-line wraps the shortened form stops. A row on a chain the registry does
 * not know keeps the copy and drops the link.
 */
function OnChainValue({
  chainId,
  type,
  value,
}: {
  chainId: number
  type: 'tx' | 'address'
  value: string
}) {
  const href = getExplorerUrlOrNull(chainId, type, value)
  const noun = type === 'tx' ? 'transaction' : 'address'
  return (
    <span className="inline-flex max-w-full items-center justify-end gap-1 whitespace-nowrap">
      <span className="v2-tabular font-mono text-xs text-[var(--v2-ink-2)]" title={value}>
        {truncate(value)}
      </span>
      <CopyButton value={value} label={noun} />
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${noun} in explorer`}
          title={value}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--v2-ink-3)] hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
        >
          <Icon icon={ExternalLink} className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </span>
  )
}

// ── Field resolution ───────────────────────────────────────────────

type Kind = 'x402' | 'mpp' | 'sweep' | 'move' | 'send' | 'receive'

function rowKind(tx: AggregatedTransaction): Kind {
  if (isDelegateSweep(tx)) return 'sweep'
  if (tx.ownTransfer) return 'move'
  if (tx.source === 'x402') return 'x402'
  if (tx.source === 'mpp_demo') return 'mpp'
  return tx.direction === 'in' ? 'receive' : 'send'
}

/** The kind in words, under the title (#4267). */
function kindLabel(tx: AggregatedTransaction, kind: Kind): string {
  if (tx.isError) return 'Payment attempt'
  if (kind === 'x402') return 'Paid request'
  if (kind === 'receive') return 'Deposit'
  if (kind === 'move' || kind === 'sweep') return 'Transfer'
  return 'Payment'
}

/** The name an account carries; the backend's own fallback (#4265). */
function accountLabel(name: string | null | undefined): string {
  return name?.trim() || 'Unnamed account'
}

function savedName(
  tx: AggregatedTransaction,
  address: string,
  resolveAddress?: (address: string) => string | null,
  accountNamesByAddress?: Map<string, string>,
): string | null {
  if (!address) return null
  return (
    accountNamesByAddress?.get(`${address.toLowerCase()}:${tx.chainId}`) ??
    resolveAddress?.(address) ??
    null
  )
}

/**
 * A hash the explorer can open. Agent-tab rows built from
 * `payment_intents` carry a synthetic `activity-<type>-<id>` hash
 * (`AgentActivityTab`'s `activityToTransaction`), so the record decides,
 * never the status.
 */
function isRealHash(hash: string | null | undefined): hash is string {
  return !!hash && !hash.startsWith('activity-')
}

/**
 * The transaction that left or entered the user's account — on the eip3009
 * bridge, the FUNDING leg. This supersedes #3763's settlement-first link: the
 * merchant's settlement hash keeps its own row under Technical details.
 */
function accountTxHash(tx: AggregatedTransaction): string | null {
  const hash = tx.settlementScheme === 'eip3009' ? (tx.fundingTxHash ?? tx.hash) : tx.hash
  return isRealHash(hash) ? hash : null
}

/**
 * The footer's explorer URL. It honours `explorerUrl` as the row link always
 * did: `null` → no footer, a value → that value, otherwise the chain's
 * explorer for the account's transaction — none for a synthetic hash or a
 * chain the registry does not know.
 */
function footerExplorerUrl(tx: AggregatedTransaction): string | null {
  if (tx.explorerUrl === null) return null
  const hash = accountTxHash(tx)
  if (!hash) return null
  if (tx.explorerUrl) return tx.explorerUrl
  return getExplorerUrlOrNull(tx.chainId, 'tx', hash)
}

/**
 * The Receipt row's words, from `paymentProofStatus`. Never the raw value
 * ("protocol_receipt_attached"): the wire's three states read as attached or
 * not, the merchant's observed response said in words.
 */
function receiptLabel(status: string | null | undefined): string {
  if (status === 'protocol_receipt_attached') return 'Attached'
  if (status === 'merchant_response_observed') return 'Not attached (the merchant responded)'
  return 'Not attached'
}

/**
 * The header's one line: who, where and when. Owner attribution follows
 * #2097 — "you" only for a recorded owner send.
 */
function headerLine(tx: AggregatedTransaction, kind: Kind, when: string): string {
  const account = accountLabel(tx.accountName)
  if (kind === 'move') {
    return `From ${account} to ${accountLabel(tx.ownTransfer?.toAccountName)} · ${when}`
  }
  // A sweep's title already names the agent ("Returned from <agent>").
  if (kind === 'sweep' || kind === 'receive') return `Into ${account} · ${when}`
  const verb = tx.isError ? 'Attempted' : kind === 'send' ? 'Sent' : 'Paid'
  if (tx.initiatedBy === 'human') return `${verb} by you from ${account} · ${when}`
  if (tx.agentName) return `${verb} by ${tx.agentName} from ${account} · ${when}`
  return `${verb} from ${account} · ${when}`
}

// ── The panel ──────────────────────────────────────────────────────

/**
 * The transaction detail panel (#4267, epic #4263) — opened from
 * `/transactions` and the account and agent Activity tabs. It leads with the
 * answer: a header summary (who, how much, the status, when), a few
 * plain-word Details rows per kind, and every raw value — addresses, hashes,
 * the payment id, the settlement method — behind a Technical details
 * disclosure, closed by default. Amount, date, agent and account appear once,
 * in the header; nothing the panel showed before is gone.
 */
export default function TransactionDetailPanel({
  transaction: tx,
  open,
  onClose,
  resolveAddress,
  accountNamesByAddress,
}: Props) {
  if (!tx) return null

  const kind = rowKind(tx)
  // The rows' one precedence (`transactionRowBadge`, #4266); the panel
  // alone names a plain settled payment "Executed".
  const status = transactionRowBadge(tx) ?? { label: 'Executed', tone: 'success' as const }
  // The title matches the list row: who was paid (or who paid), never a raw
  // address; a folded move reads as the ledger row does.
  const title =
    kind === 'move'
      ? 'Moved between your accounts'
      : counterpartyLabel(tx, resolveAddress, accountNamesByAddress, { noAddress: true })
  const when = new Date(tx.timestamp * 1000).toLocaleString()
  const fiat = transactionFiat(tx, 'detail')
  const explorerUrl = footerExplorerUrl(tx)

  // The mark: a named counterparty gets its monogram. A deposit, a sweep, a
  // move between your own accounts and a send nothing names ("New recipient",
  // or an x402 row with no resource URL) have no counterparty to draw, so
  // they take the direction mark the ledger row shows.
  const unnamed = title === 'New recipient' || title === paymentSourceTitle(tx.source)
  const leading =
    kind === 'move' || kind === 'receive' || kind === 'sweep' || unnamed ? (
      <DirectionMark direction={kind === 'move' ? 'move' : tx.direction} />
    ) : (
      <Monogram name={title} decorative />
    )

  const nameOr = (address: string) =>
    savedName(tx, address, resolveAddress, accountNamesByAddress) ?? truncate(address)

  // ── Details: a few plain-word rows per kind ──
  // What the header line does not already say: amount, date, agent and
  // account appear once, in the header (#4267), so no row repeats them.
  const details: ReactNode[] = []
  if (kind === 'x402') {
    const host = parseX402Hostname(tx.x402ResourceUrl) ?? tx.x402ResourceUrl
    if (host) details.push(<DetailRow key="for" label="For" value={host} />)
    details.push(<DetailRow key="receipt" label="Receipt" value={receiptLabel(tx.paymentProofStatus)} />)
    // #3763: on the eip3009 bridge the merchant settles in a SECOND
    // transaction. The words state only what the record proves — the
    // settlement hash was reported by the agent or detected by Haven's
    // settlement sweep (#3888) and verified on-chain (#3475) — never that the
    // merchant confirmed anything, and a missing record is "not recorded",
    // never "failed": the SDK's default evidence post reports the funding
    // hash (refused by the writer), so many eip3009 rows never get one.
    // erc7710 is one transaction: the merchant's redemption IS the payment.
    if (tx.settlementScheme === 'eip3009') {
      details.push(
        tx.settlementTxHash ? (
          <DetailRow key="settlement" label="Settlement" value="Recorded (verified)" />
        ) : (
          <DetailRow
            key="settlement"
            label="Settlement"
            value="Not recorded yet"
            note="The payment left your account; no settlement from the merchant has been recorded."
          />
        ),
      )
    }
  } else if (kind === 'mpp' || kind === 'send') {
    details.push(<DetailRow key="to" label="To" value={nameOr(tx.to)} />)
  } else if (kind === 'receive') {
    details.push(
      <DetailRow
        key="from"
        label="From"
        value={savedName(tx, tx.from, resolveAddress, accountNamesByAddress) ?? 'An outside wallet'}
      />,
    )
  } else if (kind === 'move') {
    // "You" only for a recorded owner send; otherwise the wallet set (#2097).
    details.push(
      <DetailRow key="by" label="By" value={tx.initiatedBy === 'human' ? 'You' : 'Your accounts'} />,
    )
  } else {
    // A delegate sweep: the agent's unspent allowance funding, returned.
    details.push(
      <DetailRow key="what" label="What happened" value="Unspent funds returned from the agent's wallet" />,
    )
  }
  // #2870: only when the list joined a sync row for this payment — the same
  // absence contract as the row badge. The badge here keeps its link to
  // /accounting; the row's copy is a plain pill.
  if (tx.accounting) {
    details.push(
      <DetailRow key="accounting" label="Accounting" value={<AccountingBadge accounting={tx.accounting} />} />,
    )
    // The failure reason as plain text: the badge's tooltip has no tab stop
    // and no hover on touch (review, #2893).
    if ((tx.accounting.status === 'failed' || tx.accounting.status === 'skipped') && tx.accounting.error) {
      details.push(<DetailRow key="reason" label="Reason" value={tx.accounting.error} />)
    }
  }

  // ── Technical details: every raw value, shortened ──
  const onChain = (type: 'tx' | 'address', value: string) => (
    <OnChainValue chainId={tx.chainId} type={type} value={value} />
  )
  const technical: ReactNode[] = [
    <DetailRow key="network" label="Network" value={<NetworkPill chainId={tx.chainId} />} />,
  ]
  if (tx.paymentId) {
    technical.push(
      <DetailRow
        key="payment-id"
        label="Payment ID"
        value={
          <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
            <span className="v2-tabular font-mono text-xs" title={tx.paymentId}>
              {truncate(tx.paymentId)}
            </span>
            <CopyButton value={tx.paymentId} label="payment ID" />
          </span>
        }
      />,
    )
  }
  const scheme = kind === 'x402' ? settlementSchemeLabel(tx.settlementScheme) : null
  if (scheme) technical.push(<DetailRow key="scheme" label="Settlement method" value={scheme} />)
  if (kind === 'x402' && tx.deliveryReference) {
    technical.push(<DetailRow key="delivered" label="Delivered" value={tx.deliveryReference} />)
  }
  if (kind === 'x402' && tx.x402MerchantAddress) {
    technical.push(<DetailRow key="merchant" label="Merchant address" value={onChain('address', tx.x402MerchantAddress)} />)
  }
  if ((kind === 'send' || kind === 'mpp') && tx.to) {
    technical.push(<DetailRow key="to" label="To address" value={onChain('address', tx.to)} />)
  }
  if ((kind === 'receive' || kind === 'sweep') && tx.from) {
    technical.push(<DetailRow key="from" label="From address" value={onChain('address', tx.from)} />)
  }
  if (kind === 'move') {
    if (tx.accountAddress) {
      technical.push(<DetailRow key="from" label="From address" value={onChain('address', tx.accountAddress)} />)
    }
    if (tx.ownTransfer?.toAccountAddress) {
      technical.push(
        <DetailRow key="to" label="To address" value={onChain('address', tx.ownTransfer.toAccountAddress)} />,
      )
    }
  } else if (tx.accountAddress) {
    technical.push(<DetailRow key="account" label="Your account" value={onChain('address', tx.accountAddress)} />)
  }
  if (tx.tokenAddress) {
    technical.push(<DetailRow key="token" label="Token contract" value={onChain('address', tx.tokenAddress)} />)
  }
  const txHash = accountTxHash(tx)
  if (txHash) technical.push(<DetailRow key="tx" label="Transaction" value={onChain('tx', txHash)} />)
  if (tx.settlementScheme === 'eip3009' && tx.settlementTxHash) {
    technical.push(
      <DetailRow key="settlement-tx" label="Settlement transaction" value={onChain('tx', tx.settlementTxHash)} />,
    )
  }

  // ── The callout, when the record needs one ──
  let callout: ReactNode = null
  if (tx.paymentFlowStatus === 'needs_attention') {
    const cause =
      tx.paymentAttentionReason === 'merchant_retry_rejected_after_payment'
        ? strandedFundsCauseWithLocation(1)
        : 'This payment needs your attention.'
    callout = (
      <NoticeRow
        className="mt-4"
        action={
          tx.agentId ? (
            <Button variant="ghost" size="sm" href={`/agents/${tx.agentId}`}>
              Open agent
            </Button>
          ) : undefined
        }
      >
        {cause}
      </NoticeRow>
    )
  } else if (tx.isError && isRealHash(tx.hash)) {
    callout = (
      <NoticeRow className="mt-4">The transaction failed on-chain. Nothing left your account.</NoticeRow>
    )
  }

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      leading={leading}
      title={title}
      subtitle={kindLabel(tx, kind)}
      footer={
        explorerUrl ? (
          <Button variant="tertiary" size="sm" href={explorerUrl} target="_blank" rel="noopener noreferrer">
            View on explorer
            <Icon icon={ExternalLink} className="h-3.5 w-3.5" />
          </Button>
        ) : undefined
      }
    >
      <div data-testid="transaction-detail-header" className="mb-5">
        <div className="flex items-center justify-between gap-3">
          {/* The user's currency headlines — book-time `convertedAmount`
              plain, serve-time `approxAmount` with `≈` when the conversion
              changes the number (#4165) — and the exact token amount stays
              beside it (#3811). A move between your own accounts is neither
              in nor out, so it passes no sign. */}
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <Amount
              amount={fiat.amount}
              currency={fiat.currency}
              approx={fiat.approx}
              direction={kind === 'move' ? undefined : tx.direction}
              failed={tx.isError}
              size="lg"
            />
            <Amount value={tx.valueFormatted} symbol={tx.asset} />
          </div>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        </div>
        <p className="mt-2 text-sm text-[var(--v2-ink-2)]">{headerLine(tx, kind, when)}</p>
        {callout}
      </div>

      <dl data-testid="transaction-detail-details">{details}</dl>

      <details data-testid="transaction-technical-details" className="group mt-5 border-t border-[var(--v2-border)] pt-3">
        <summary className="flex w-full cursor-pointer select-none list-none items-center justify-between rounded py-1 text-sm font-medium text-[var(--v2-ink)] [&::-webkit-details-marker]:hidden">
          Technical details
          {/* `mr-1`: mid-rotation the chevron's box is ~3px wider than the
              icon, and flush to the panel edge that overflows the scroll
              body for the length of the transition. */}
          <Icon
            icon={ChevronDown}
            className="mr-1 h-4 w-4 flex-shrink-0 text-[var(--v2-ink-3)] transition-transform group-open:rotate-180"
          />
        </summary>
        <dl className="mt-2">{technical}</dl>
      </details>
    </SidePanel>
  )
}
