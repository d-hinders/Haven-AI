'use client'

import { ConnectAgentFlow } from './connect-agent/ConnectAgentFlow'
import { Modal } from './ui/Modal'

interface Props {
  open: boolean
  onClose: () => void
  accountAddress?: string
  accountId?: string | null
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
  /**
   * Open on an EXISTING setup instead of a blank flow (#2522). This is what
   * `/agents?setup=<id>` passes: the link an agent hands its user to land them
   * on that setup's current step.
   */
  resumeSetupId?: string | null
}

/**
 * The connect-agent flow in a dialog: chrome only (title, X, backdrop,
 * top placement, open-time focus).
 *
 * The flow itself — the hook call, step dispatch, step-change focus and the
 * stepper's props — is `ConnectAgentFlow` (#4065), shared with the inline
 * first-agent card on `/agents` so the two cannot drift.
 */
export default function ConnectAgentModal({
  open,
  onClose,
  accountAddress,
  accountId,
  onSetupUpdated,
  starterAllowance = false,
  resumeSetupId = null,
}: Props) {
  return (
    <ConnectAgentFlow
      open={open}
      onClose={onClose}
      accountAddress={accountAddress}
      accountId={accountId}
      onSetupUpdated={onSetupUpdated}
      starterAllowance={starterAllowance}
      resumeSetupId={resumeSetupId}
    >
      {({ flow, progress, steps, nameInputRef, coarsePointer }) =>
        open ? (
          <Modal
            open
            onClose={flow.handleClose}
            title="Connect agent"
            subtitle={flow.headerSubtitleText}
            headerAccessory={progress}
            showCloseButton
            initialFocusRef={coarsePointer ? undefined : nameInputRef}
            closeButtonDisabled={flow.busy}
            width="xl"
            maxHeight="tight"
            // Top-anchored: every screen of this flow has a different height, and a
            // centred dialog moved its header (and the band) with each one — the
            // title swung between y 130 and 294 at 1280×900. Anchored, the header
            // holds still and the body grows downward only.
            placement="top"
            closeOnBackdrop={!flow.busy}
            // The flow hook binds Escape itself (to `handleClose`, gated on a
            // create in flight), so Modal's own binding stays off.
            closeOnEscape={false}
            bodyClassName="p-5"
          >
            {steps}
          </Modal>
        ) : null
      }
    </ConnectAgentFlow>
  )
}
