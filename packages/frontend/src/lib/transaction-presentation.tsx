import { TransactionMovement } from '@/components/haven'
import type { StatusTone } from '@/components/ui/StatusBadge'
import { isMachinePaymentSource, parseX402Hostname, paymentSourceTitle } from '@/lib/transaction-labels'
import { truncate } from '@/lib/format'
import type { AggregatedTransaction } from '@/types/transactions'

export function isDelegateSweep(tx: Pick<AggregatedTransaction, 'activityType'>): boolean {
  return tx.activityType === 'delegate_sweep'
}

export function transactionTitle(tx: AggregatedTransaction): string {
  if (tx.titleOverride) return tx.titleOverride
  if (isDelegateSweep(tx)) return 'Agent funds swept back'
  if (tx.direction === 'in') return 'Received payment'

  const sourceTitle = paymentSourceTitle(tx.source)
  if (sourceTitle && tx.agentName) return `${sourceTitle} by ${tx.agentName}`
  if (sourceTitle) return sourceTitle
  if (tx.agentName) return `Agent payment by ${tx.agentName}`
  return 'Payment sent by you'
}

export function transactionInitiator(tx: AggregatedTransaction): string {
  if (isDelegateSweep(tx)) return tx.agentName ?? 'Agent'
  return tx.agentName ?? (tx.direction === 'in' ? '' : 'You')
}

export function transactionStatus(
  tx: AggregatedTransaction,
): { label: string; tone: StatusTone } | null {
  if (!isDelegateSweep(tx)) return null
  return { label: 'Recovered', tone: 'success' }
}

export function transactionMovement(
  tx: AggregatedTransaction,
  resolveAddress?: (address: string) => string | null,
  safeNamesByAddress?: Map<string, string>,
) {
  if (tx.movementOverride) return tx.movementOverride

  if (isDelegateSweep(tx)) {
    return (
      <TransactionMovement
        from={`${tx.agentName ?? 'Agent'} delegate`}
        to={tx.safeName}
      />
    )
  }

  const counterparty = counterpartyLabel(tx, resolveAddress, safeNamesByAddress)
  const from = tx.direction === 'in' ? counterparty : tx.safeName
  const to = tx.direction === 'in' ? tx.safeName : counterparty

  return <TransactionMovement from={from} to={to} />
}

function counterpartyLabel(
  tx: AggregatedTransaction,
  resolveAddress?: (address: string) => string | null,
  safeNamesByAddress?: Map<string, string>,
): string {
  if (isMachinePaymentSource(tx.source)) {
    return parseX402Hostname(tx.x402ResourceUrl) ?? truncate(tx.to)
  }

  const address = tx.direction === 'in' ? tx.from : tx.to
  const addressKey = address.toLowerCase()
  const safeName =
    safeNamesByAddress?.get(`${addressKey}:${tx.chainId}`) ??
    safeNamesByAddress?.get(addressKey)
  const contactName = resolveAddress?.(address)

  return safeName ?? contactName ?? truncate(address)
}
