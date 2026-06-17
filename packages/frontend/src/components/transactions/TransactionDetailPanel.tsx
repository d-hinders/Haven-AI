'use client'

import { type ReactNode } from 'react'
import { SidePanel } from '@/components/ui/SidePanel'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { getExplorerUrl } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { parseX402Hostname } from '@/lib/transaction-labels'
import {
  isDelegateSweep,
  transactionStatus,
  transactionTitle,
} from '@/lib/transaction-presentation'
import { machinePaymentLifecyclePresentation } from '@/lib/machine-payment-lifecycle'
import type { AggregatedTransaction } from '@/types/transactions'

interface Props {
  transaction: AggregatedTransaction | null
  open: boolean
  onClose: () => void
  resolveAddress?: (address: string) => string | null
  safeNamesByAddress?: Map<string, string>
}

// ── Small presentational helpers ───────────────────────────────────

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--v2-table-row-border)] py-2.5 last:border-b-0">
      <span className="text-xs text-[var(--v2-ink-3)]">{label}</span>
      <span className="min-w-0 text-right text-sm text-[var(--v2-ink)]">{value}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">
        {title}
      </p>
      <div>{children}</div>
    </div>
  )
}

function ExplorerLink({
  chainId,
  type,
  value,
  label,
}: {
  chainId: number
  type: 'tx' | 'address'
  value: string
  label?: string
}) {
  return (
    <a
      href={getExplorerUrl(chainId, type, value)}
      target="_blank"
      rel="noopener noreferrer"
      className="v2-tabular text-[var(--v2-brand)] underline-offset-2 hover:underline"
      title={value}
    >
      {label ?? truncate(value)}
    </a>
  )
}

// ── Field resolution ───────────────────────────────────────────────

function counterpartyName(
  tx: AggregatedTransaction,
  address: string,
  resolveAddress?: (address: string) => string | null,
  safeNamesByAddress?: Map<string, string>,
): string | null {
  return (
    resolveAddress?.(address) ??
    safeNamesByAddress?.get(`${address.toLowerCase()}:${tx.chainId}`) ??
    null
  )
}

function AddressValue({
  tx,
  address,
  resolveAddress,
  safeNamesByAddress,
}: {
  tx: AggregatedTransaction
  address: string
  resolveAddress?: (address: string) => string | null
  safeNamesByAddress?: Map<string, string>
}) {
  const name = counterpartyName(tx, address, resolveAddress, safeNamesByAddress)
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      {name ? <span className="text-[var(--v2-ink)]">{name}</span> : null}
      <ExplorerLink chainId={tx.chainId} type="address" value={address} />
    </span>
  )
}

// ── Per-type bodies ────────────────────────────────────────────────

function rowType(tx: AggregatedTransaction): 'x402' | 'mpp' | 'sweep' | 'send' | 'receive' {
  if (isDelegateSweep(tx)) return 'sweep'
  if (tx.source === 'x402') return 'x402'
  if (tx.source === 'mpp_demo') return 'mpp'
  return tx.direction === 'in' ? 'receive' : 'send'
}

export default function TransactionDetailPanel({
  transaction: tx,
  open,
  onClose,
  resolveAddress,
  safeNamesByAddress,
}: Props) {
  if (!tx) return null

  const kind = rowType(tx)
  const status =
    transactionStatus(tx) ??
    machinePaymentLifecyclePresentation(tx) ??
    tx.statusBadge ??
    (tx.isError ? { label: 'Failed', tone: 'danger' as const } : { label: 'Executed', tone: 'success' as const })
  const sign = tx.direction === 'in' ? '+' : '-'
  const amountTone =
    tx.isError ? 'text-[var(--v2-danger)]' : tx.direction === 'in' ? 'text-[var(--v2-success)]' : 'text-[var(--v2-ink)]'

  const addr = (address: string) => (
    <AddressValue
      tx={tx}
      address={address}
      resolveAddress={resolveAddress}
      safeNamesByAddress={safeNamesByAddress}
    />
  )

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={transactionTitle(tx)}
      subtitle={`${tx.safeName} · ${new Date(tx.timestamp * 1000).toLocaleString()}`}
    >
      <div className="mb-5 flex items-center justify-between gap-3">
        <span className={`v2-tabular text-2xl font-semibold ${amountTone}`}>
          {sign}{tx.valueFormatted} {tx.asset}
        </span>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </div>

      {kind === 'x402' ? (
        <Section title="Payment">
          {tx.x402ResourceUrl ? (
            <DetailRow label="Resource" value={parseX402Hostname(tx.x402ResourceUrl) ?? tx.x402ResourceUrl} />
          ) : null}
          {tx.x402MerchantAddress ? <DetailRow label="Merchant" value={addr(tx.x402MerchantAddress)} /> : null}
          {tx.agentName ? <DetailRow label="Agent" value={tx.agentName} /> : null}
          <DetailRow label="Amount" value={`${tx.valueFormatted} ${tx.asset}`} />
          {tx.paymentId ? <DetailRow label="Payment ID" value={<span className="v2-tabular">{truncate(tx.paymentId)}</span>} /> : null}
          {tx.paymentProofStatus ? <DetailRow label="Proof" value={tx.paymentProofStatus} /> : null}
        </Section>
      ) : null}

      {kind === 'mpp' ? (
        <Section title="Machine payment">
          {tx.agentName ? <DetailRow label="Agent" value={tx.agentName} /> : null}
          <DetailRow label="Recipient" value={addr(tx.to)} />
          <DetailRow label="Amount" value={`${tx.valueFormatted} ${tx.asset}`} />
          {tx.paymentId ? <DetailRow label="Payment ID" value={<span className="v2-tabular">{truncate(tx.paymentId)}</span>} /> : null}
        </Section>
      ) : null}

      {kind === 'send' ? (
        <Section title="Transfer">
          <DetailRow label="To" value={addr(tx.to)} />
          <DetailRow label="Amount" value={`${tx.valueFormatted} ${tx.asset}`} />
          <DetailRow label="Initiator" value={tx.agentName ?? 'You'} />
        </Section>
      ) : null}

      {kind === 'receive' ? (
        <Section title="Transfer">
          <DetailRow label="From" value={addr(tx.from)} />
          <DetailRow label="Amount" value={`${tx.valueFormatted} ${tx.asset}`} />
        </Section>
      ) : null}

      {kind === 'sweep' ? (
        <Section title="Allowance funding">
          <DetailRow label="From" value={addr(tx.from)} />
          <DetailRow label="To" value={addr(tx.to)} />
          <DetailRow label="Amount" value={`${tx.valueFormatted} ${tx.asset}`} />
          {tx.agentName ? <DetailRow label="Agent" value={tx.agentName} /> : null}
        </Section>
      ) : null}

      <Section title="On-chain">
        <DetailRow label="Token" value={tx.tokenSymbol ?? tx.asset} />
        {tx.tokenAddress ? <DetailRow label="Token address" value={addr(tx.tokenAddress)} /> : null}
        <DetailRow label="Account" value={addr(tx.safeAddress)} />
        <DetailRow label="Network" value={`Chain ${tx.chainId}`} />
        <DetailRow label="Transaction" value={<ExplorerLink chainId={tx.chainId} type="tx" value={tx.hash} />} />
        <DetailRow label="Date" value={new Date(tx.timestamp * 1000).toLocaleString()} />
      </Section>
    </SidePanel>
  )
}
