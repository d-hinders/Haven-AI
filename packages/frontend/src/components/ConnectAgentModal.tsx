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
   * Fires after any delegation setup-state change the parent should react to
   * (typically: refresh the agents list).
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
        // #1418: ONE status voice. On steps 1-3 the wizard band is the only
        // status signal. On step 4 the shell ticker (Waiting — Connected —
        // Approved) takes over as the single voice — the epic's rule 2 —
        // so the wizard band does not render there: two stacked trackers in
        // the same dot/line language made the user decode which meant what,
        // on the screen whose whole job is calm. The ticker also carries the
        // remaining journey, so "step 4 of 4" loses no information.
        flow.step !== 'connect' ? (
          <StepProgress totalSteps={flow.setupStepCount} currentStep={Math.max(flow.currentStepIndex, 0)} />
        ) : undefined
      }
      showCloseButton
      closeButtonDisabled={flow.busy}
      width="xl"
      maxHeight="tight"
      closeOnBackdrop={!flow.busy}
      closeOnEscape={false}
      bodyClassName="p-5"
    >
      {/*
       * #1411: steps 1-3 share ONE 20px rhythm — the same `flex flex-col
       * gap-5` step 4's shell body carries (ConnectStepShell) — instead of
       * each setting its own `space-y-*` (DetailsStep/ReviewStep used 5,
       * PolicyStep used 4). Hoisted here rather than left inside each step
       * so no step can silently reintroduce a local rhythm. Keyed by
       * `flow.step` so the entrance animation retriggers on every step
       * change, the same way ConnectStepShell keys its body by `stateKey`.
       * Step 4 stays OUTSIDE this wrapper and keeps its own shell/rhythm —
       * changing it is explicitly out of scope for #1411.
       */}
      {flow.step !== 'connect' && (
        <div key={flow.step} className="v2-animate-step-rise flex flex-col gap-5">
          {flow.step === 'details' && <DetailsStep flow={flow} />}
          {flow.step === 'policy' && <PolicyStep flow={flow} />}
          {flow.step === 'review' && <ReviewStep flow={flow} />}
        </div>
      )}
      {flow.step === 'connect' && <ConnectStep flow={flow} />}
    </Modal>
  )
}
