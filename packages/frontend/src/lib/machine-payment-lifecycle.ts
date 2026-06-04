import type { StatusTone } from '@/components/ui/StatusBadge'
import type { AggregatedTransaction, Transaction } from '@/types/transactions'

export interface MachinePaymentLifecyclePresentation {
  label: string
  tone: StatusTone
}

export function machinePaymentLifecyclePresentation(
  tx: Pick<Transaction | AggregatedTransaction, 'paymentFlowStatus'>,
): MachinePaymentLifecyclePresentation | null {
  if (tx.paymentFlowStatus === 'needs_attention') {
    return { label: 'Needs attention', tone: 'warning' }
  }

  if (tx.paymentFlowStatus === 'confirming_merchant') {
    return { label: 'Confirming', tone: 'warning' }
  }

  return null
}
