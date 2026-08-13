'use client'

import { X } from 'lucide-react'
import { useRef } from 'react'
import { Icon } from '@/components/ui/Icon'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useAgentConnectionSetup } from '@/hooks/useAgentConnectionSetup'
import { ConnectStep } from './connect-agent/ConnectStep'
import { DetailsStep } from './connect-agent/DetailsStep'
import { PolicyStep } from './connect-agent/PolicyStep'
import { ReviewStep } from './connect-agent/ReviewStep'
import { StepProgress } from './ui/StepProgress'

interface Props {
  open: boolean
  onClose: () => void
  safeAddress?: string
  safeId?: string | null
  /**
   * Fires after any setup-state change the parent should react to (typically:
   * refresh the agents list). When the on-chain approval has just been
   * recorded, `delegateAddress` is passed so the parent can optimistically
   * suppress the "Unmanaged Delegate" classification — the agent appears
   * on-chain a moment before the `/agents` list flips it from
   * `pending_approval` to `active`.
   */
  onSetupUpdated?: (info?: { delegateAddress?: string | null }) => void
  /**
   * Prefill the policy step with a starter allowance (10 USDC, daily reset)
   * when the form is empty. Used by the first-agent onboarding hand-off so a
   * new user lands in a payment-ready default they can still edit before
   * confirming. Never overwrites allowances the user already added.
   */
  starterAllowance?: boolean
}

/**
 * The connect-agent flow's shell: dialog chrome, stepper, and step dispatch.
 *
 * All state and orchestration live in `useAgentConnectionSetup` (#989) so the
 * flow logic is testable without rendering this modal; each step's markup
 * lives in `./connect-agent/`.
 */
export default function ConnectAgentModal({
  open,
  onClose,
  safeAddress,
  safeId,
  onSetupUpdated,
  starterAllowance = false,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  const flow = useAgentConnectionSetup({
    open,
    onClose,
    safeAddress,
    safeId,
    onSetupUpdated,
    starterAllowance,
  })

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-3 v2-modal-backdrop">
      <div className="absolute inset-0" onClick={flow.busy ? undefined : flow.handleClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect agent"
        className="relative w-full max-w-xl max-h-[calc(100vh-24px)] overflow-y-auto overflow-x-hidden rounded-[14px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Connect agent</h2>
            </div>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">{flow.headerSubtitleText}</p>
          </div>
          <button
            type="button"
            onClick={flow.handleClose}
            disabled={flow.busy}
            aria-label="Close"
            className="p-1 -mr-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface-2)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <Icon icon={X} className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-[var(--v2-border)] px-5 py-3">
          <StepProgress totalSteps={flow.setupStepCount} currentStep={Math.max(flow.currentStepIndex, 0)} />
        </div>

        <div className="p-5">
          {flow.step === 'details' && <DetailsStep flow={flow} />}
          {flow.step === 'policy' && <PolicyStep flow={flow} />}
          {flow.step === 'review' && <ReviewStep flow={flow} />}
          {flow.step === 'connect' && <ConnectStep flow={flow} />}
        </div>
      </div>
    </div>
  )
}
