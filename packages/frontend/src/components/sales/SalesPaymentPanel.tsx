'use client'

import { SidePanel } from '@/components/ui/SidePanel'

/**
 * One sale's detail panel (#4900 part 2 replaces this file): the
 * `TransactionDetailPanel` shape with the Technical details disclosure and the
 * "Clear sale record" action. Part 1 owns the contract the list opens it
 * through — `txHash` names the payment, `null` is closed — and a placeholder
 * body.
 */
export interface SalesPaymentPanelProps {
  /** The payment to show; `null` keeps the panel closed. */
  txHash: string | null
  onClose: () => void
}

export function SalesPaymentPanel({ txHash, onClose }: SalesPaymentPanelProps) {
  return (
    <SidePanel open={txHash !== null} onClose={onClose} title="Payment">
      <p className="text-sm text-[var(--v2-ink-2)]" data-testid="sales-payment-panel">
        The payment&apos;s details will show here.
      </p>
    </SidePanel>
  )
}

export default SalesPaymentPanel
