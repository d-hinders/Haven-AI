'use client'

import { useAgentConnectionSetup } from '@/hooks/useAgentConnectionSetup'
import { ConnectStep } from './connect-agent/ConnectStep'
import { DetailsStep } from './connect-agent/DetailsStep'
import { PolicyStep } from './connect-agent/PolicyStep'
import { ReviewStep } from './connect-agent/ReviewStep'
import { Modal } from './ui/Modal'
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
    <Modal
      open
      onClose={flow.handleClose}
      title="Connect agent"
      subtitle={flow.headerSubtitleText}
      headerAccessory={
        <StepProgress totalSteps={flow.setupStepCount} currentStep={Math.max(flow.currentStepIndex, 0)} />
      }
      showCloseButton
      closeButtonDisabled={flow.busy}
      width="xl"
      maxHeight="tight"
      closeOnBackdrop={!flow.busy}
      closeOnEscape={false}
      bodyClassName="p-5"
    >
      {flow.step === 'details' && <DetailsStep flow={flow} />}
      {flow.step === 'policy' && <PolicyStep flow={flow} />}
      {flow.step === 'review' && <ReviewStep flow={flow} />}
      {flow.step === 'connect' && <ConnectStep flow={flow} />}
    </Modal>
  )
}
