'use client'

import { useEffect, useRef, useState } from 'react'
import { useAgentConnectionSetup } from '@/hooks/useAgentConnectionSetup'
import { ConnectStep } from './connect-agent/ConnectStep'
import { DetailsStep } from './connect-agent/DetailsStep'
import { PolicyStep } from './connect-agent/PolicyStep'
import { Modal } from './ui/Modal'
import { StepProgress } from './ui/StepProgress'

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
 * A touch-first pointer (#3687, owner decision 2026-10-06): focusing a text
 * field there opens the on-screen keyboard over the dialog (the installed
 * iPhone web app, #2736), so the name input is never auto-focused on one.
 */
function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(pointer: coarse)').matches
}

/** Stepper labels, index-aligned with the hook's `setupSteps` (details → policy → connect). */
const SETUP_STEP_LABELS = ['Name', 'Budget', 'Connect'] as const

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
  accountAddress,
  accountId,
  onSetupUpdated,
  starterAllowance = false,
  resumeSetupId = null,
}: Props) {
  const flow = useAgentConnectionSetup({
    open,
    onClose,
    accountAddress,
    accountId,
    onSetupUpdated,
    starterAllowance,
    resumeSetupId,
  })

  // #3687: open with the caret in *Agent name* (fine pointer only). Read once:
  // a changing `initialFocusRef` would re-run Modal's focus-on-open effect.
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [coarsePointer] = useState(isCoarsePointer)

  // #3687, after #3331 F11 (FundMerchantModal): every step change unmounts the
  // button that triggered it, dropping focus to <body> — outside the dialog.
  // Move it into the new step on a CHANGE, never on a step's first render
  // (Modal places the open-time focus). Back to details focuses the name
  // input; anything else focuses the step region, so a screen-reader user
  // hears where they landed.
  const stepRegionRef = useRef<HTMLDivElement>(null)
  const previousStepRef = useRef(flow.step)
  useEffect(() => {
    if (previousStepRef.current !== flow.step) {
      if (flow.step === 'details' && !coarsePointer) nameInputRef.current?.focus()
      else stepRegionRef.current?.focus()
    }
    previousStepRef.current = flow.step
  }, [flow.step, coarsePointer])

  if (!open) return null

  return (
    <Modal
      open
      onClose={flow.handleClose}
      title="Connect agent"
      subtitle={flow.headerSubtitleText}
      headerAccessory={
        // ONE counter for the whole flow (owner review, 2026-10-16, superseding
        // #1418's hide-the-band rule): the wizard band renders on every step,
        // Connect active on step 3. Hiding it there swapped one progress model
        // for another mid-flow — a horizontal 1 → 2 → 3 band, then a vertical
        // numbered list — so the user met two counters. The step-3 list
        // (ConnectSteps) is now an unnumbered status checklist: it reports
        // progress WITHIN the Connect step and never counts.
        <StepProgress
          totalSteps={flow.setupStepCount}
          currentStep={Math.max(flow.currentStepIndex, 0)}
          labels={SETUP_STEP_LABELS}
        />
      }
      showCloseButton
      initialFocusRef={coarsePointer ? undefined : nameInputRef}
      closeButtonDisabled={flow.busy}
      width="xl"
      maxHeight="tight"
      closeOnBackdrop={!flow.busy}
      closeOnEscape={false}
      bodyClassName="p-5"
    >
      {/*
       * #1411: steps 1-2 share ONE 20px rhythm — the same `flex flex-col
       * gap-5` step 3's shell body carries (ConnectStepShell) — instead of
       * each setting its own `space-y-*` (DetailsStep used 5, PolicyStep
       * used 4). Hoisted here rather than left inside each step
       * so no step can silently reintroduce a local rhythm. Keyed by
       * `flow.step` so the entrance animation retriggers on every step
       * change, the same way ConnectStepShell keys its body by `stateKey`.
       * Step 3 stays OUTSIDE this wrapper and keeps its own shell/rhythm —
       * changing it was explicitly out of scope for #1411.
       *
       * Both wrappers are the step-change focus target (#3687): `tabIndex=-1`
       * keeps them out of the Tab order and Modal's first-focusable query,
       * `outline-none` keeps a programmatic focus from drawing a ring.
       */}
      {flow.step !== 'connect' && (
        <div
          key={flow.step}
          ref={stepRegionRef}
          tabIndex={-1}
          className="v2-animate-step-rise flex flex-col gap-5 outline-none"
        >
          {flow.step === 'details' && <DetailsStep flow={flow} nameInputRef={nameInputRef} />}
          {flow.step === 'policy' && <PolicyStep flow={flow} />}
        </div>
      )}
      {flow.step === 'connect' && (
        <div ref={stepRegionRef} tabIndex={-1} className="outline-none">
          <ConnectStep flow={flow} />
        </div>
      )}
    </Modal>
  )
}
