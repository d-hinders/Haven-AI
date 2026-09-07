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
  // "Payment sent by you" is reserved for human-initiated payments; a row
  // with no human marker renders neutral copy — the Initiator field carries
  // the attribution state (#2097).
  if (tx.initiatedBy === 'human') return 'Payment sent by you'
  return 'Payment sent'
}

/**
 * Who initiated the row (#2097). "You" is reserved for human-initiated
 * payments (`initiatedBy === 'human'`); agent rows render the agent identity;
 * inbound rows carry no initiator; and missing attribution renders as
 * explicit "Unknown" — never "You".
 */
export function transactionInitiator(tx: AggregatedTransaction): string {
  // Delegate sweeps are agent-attributed regardless of direction — they read
  // as inbound rows (funds recovered TO the Haven wallet), so the sweep check
  // must precede the direction check.
  if (isDelegateSweep(tx)) return tx.agentName ?? 'Unknown'
  if (tx.direction === 'in') return ''
  if (tx.initiatedBy === 'human') return 'You'
  return tx.agentName ?? 'Unknown'
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
        from={tx.agentName ?? 'Agent'}
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

/**
 * Display label for the on-chain settlement scheme (epic #1704, #1707).
 * EIP-3009 is the delegate-signed transferWithAuthorization fallback;
 * ERC-7710 is smart-account redemption. Technical-but-calm per
 * `docs/product/copy-guidelines.md`. Null-in, null-out: an x402 row without
 * a recorded scheme renders nothing — never a guessed value. Kept separate
 * from `source` (protocol) and `execution_rail` (account architecture), which
 * are different axes; do not merge them in copy or naming.
 */
export function settlementSchemeLabel(
  scheme: AggregatedTransaction['settlementScheme'],
): 'EIP-3009' | 'ERC-7710' | null {
  if (scheme === 'eip3009') return 'EIP-3009'
  if (scheme === 'erc7710') return 'ERC-7710'
  return null
}
