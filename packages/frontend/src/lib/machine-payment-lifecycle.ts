import type { MachinePaymentFlowStatus } from '@haven_ai/core'
import type { StatusTone } from '@/components/ui/StatusBadge'
import type { AggregatedTransaction, Transaction } from '@/types/transactions'

export interface MachinePaymentLifecyclePresentation {
  label: string
  tone: StatusTone
}

/**
 * Presentation over the SHARED lifecycle union (#987): the domain — which
 * rails count, the status values, the derivation — lives in `@haven_ai/core`;
 * this file only maps status → label/tone. The Record is exhaustive over
 * `MachinePaymentFlowStatus`, so a new state added in core fails frontend
 * compilation here instead of silently rendering without a badge.
 *
 * `paid` is deliberately unbadged: a settled machine payment renders as a
 * normal transaction row.
 */
const PRESENTATION: Record<MachinePaymentFlowStatus, MachinePaymentLifecyclePresentation | null> = {
  paid: null,
  confirming_merchant: { label: 'Confirming', tone: 'warning' },
  needs_attention: { label: 'Needs attention', tone: 'warning' },
}

export function machinePaymentLifecyclePresentation(
  tx: Pick<Transaction | AggregatedTransaction, 'paymentFlowStatus'>,
): MachinePaymentLifecyclePresentation | null {
  if (!tx.paymentFlowStatus) return null
  return PRESENTATION[tx.paymentFlowStatus]
}
