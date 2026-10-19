'use client'

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  useAgentConnectionSetup,
  type AgentConnectionSetupFlow,
  type UseAgentConnectionSetupOptions,
} from '@/hooks/useAgentConnectionSetup'
import { StepProgress } from '../ui/StepProgress'
import { ConnectStep } from './ConnectStep'
import { DetailsStep } from './DetailsStep'
import { PolicyStep } from './PolicyStep'

/**
 * A touch-first pointer (#3687, owner decision 2026-10-06): focusing a text
 * field there opens the on-screen keyboard over the page (the installed
 * iPhone web app, #2736), so the name input is never auto-focused on one.
 */
function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(pointer: coarse)').matches
}

/** Stepper labels, index-aligned with the hook's `setupSteps` (details → policy → connect). */
const SETUP_STEP_LABELS = ['Name', 'Budget', 'Connect'] as const

/** Connect-step views where the flow has stopped: nothing more happens on this setup. */
const HALTED_VIEWS = new Set(['expired', 'cancelled', 'failed'])

/** What a container receives to frame the flow. */
export interface ConnectAgentFlowParts {
  /** The hook's state — the container reads its chrome from it (`handleClose`, `headerSubtitleText`, `busy`). */
  flow: AgentConnectionSetupFlow
  /** The labelled 1 → 2 → 3 band. */
  progress: ReactNode
  /** The current step's body, with the step-change focus target. */
  steps: ReactNode
  /** The *Agent name* input; the modal hands it to `Modal` as its open-time focus. */
  nameInputRef: RefObject<HTMLInputElement | null>
  /** Read once at mount (#3687): a touch-first pointer never auto-focuses the name input. */
  coarsePointer: boolean
}

export interface ConnectAgentFlowProps extends UseAgentConnectionSetupOptions {
  /**
   * #4065: the flow is rendered inline on `/agents` (inside a `Card`), not in
   * the modal. Inline differs in exactly three ways, all chosen here so no
   * container can forget one:
   * - Escape is not bound (`escapeToClose: false`): there is no dialog to
   *   dismiss, and Escape would reset the form and drop the setup token;
   * - step 1 has no Cancel (owner decision 2026-10-19);
   * - step 3's disclosure CopyBlocks drop their own `Card` shell, which
   *   inside the inline `Card` would be a nested filled card.
   */
  inline?: boolean
  /**
   * #4065: fires whenever a setup exists or is being created (the user is
   * mid-flow). The `/agents` panel latches the inline flow on it: from
   * here a `pending_approval` agent can join the list and an approval can be
   * in flight, and neither may unmount the flow. Before it — a pristine
   * step 1 or 2 — nothing is lost, so an agent created elsewhere may still
   * replace the inline flow with the list.
   */
  onSetupStarted?: () => void
  children: (parts: ConnectAgentFlowParts) => ReactNode
}

/**
 * The connect-agent flow: one hook call, the step dispatch, the step-change
 * focus rule and the stepper's props — shared by its two containers (#4065):
 * `ConnectAgentModal` (dialog chrome) and `InlineAgentSetup` (the first-agent
 * card on `/agents`). Owner decision 2026-10-16: the inline flow must be the
 * same code as the modal, so the containers own chrome only and cannot drift.
 *
 * All state and orchestration live in `useAgentConnectionSetup` (#989); each
 * step's markup lives in this directory.
 */
export function ConnectAgentFlow({
  inline = false,
  onSetupStarted,
  children,
  ...options
}: ConnectAgentFlowProps) {
  const flow = useAgentConnectionSetup({
    ...options,
    escapeToClose: inline ? false : options.escapeToClose,
  })

  // In flight counts too: an agent appearing while the create POST is out
  // would otherwise unmount the flow and orphan the setup it is creating.
  const setupStarted = flow.creating || flow.setup != null
  useEffect(() => {
    if (setupStarted) onSetupStarted?.()
  }, [setupStarted, onSetupStarted])

  // #3687: the modal opens with the caret in *Agent name* (fine pointer only).
  // Read once: a changing `initialFocusRef` would re-run Modal's focus-on-open
  // effect.
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [coarsePointer] = useState(isCoarsePointer)

  // #3687, after #3331 F11 (FundMerchantModal): every step change unmounts the
  // button that triggered it, dropping focus to <body>. Move it into the new
  // step on a CHANGE, never on a step's first render (the modal places the
  // open-time focus; inline places none, #4065 — focusing on page load would
  // scroll the page and open the phone keyboard). Back to details focuses the
  // name input; anything else focuses the step region, so a screen-reader
  // user hears where they landed.
  const stepRegionRef = useRef<HTMLDivElement>(null)
  const previousStepRef = useRef(flow.step)
  useEffect(() => {
    if (previousStepRef.current !== flow.step) {
      if (flow.step === 'details' && !coarsePointer) nameInputRef.current?.focus()
      else stepRegionRef.current?.focus()
    }
    previousStepRef.current = flow.step
  }, [flow.step, coarsePointer])

  // ONE counter for the whole flow (owner review, 2026-10-16, superseding
  // #1418's hide-the-band rule): the wizard band renders on every step,
  // Connect active on step 3. Hiding it there swapped one progress model for
  // another mid-flow — a horizontal 1 → 2 → 3 band, then a vertical numbered
  // list — so the user met two counters. The step-3 list (ConnectSteps) is
  // now an unnumbered status checklist: it reports progress WITHIN the
  // Connect step and never counts. Once the budget is approved the flow is
  // finished, so the band reads all-done rather than Connect still in
  // progress over a success screen. On an expired, cancelled or failed setup
  // the band reads stopped: Connect goes neutral instead of showing the brand
  // "in progress" ring over a screen that says nothing more will happen.
  const progress = (
    <StepProgress
      totalSteps={flow.setupStepCount}
      currentStep={
        flow.connectView?.kind === 'active' ? flow.setupStepCount : Math.max(flow.currentStepIndex, 0)
      }
      labels={SETUP_STEP_LABELS}
      // Gated on the step: "Create a new setup" moves to policy before the
      // status hook clears the old terminal view, which would otherwise
      // flash Budget as stopped for a render.
      halted={flow.step === 'connect' && HALTED_VIEWS.has(flow.connectView?.kind ?? '')}
    />
  )

  /*
   * #1411: steps 1-2 share ONE 20px rhythm — the same `flex flex-col gap-5`
   * step 3's shell body carries (ConnectStepShell) — instead of each setting
   * its own `space-y-*` (DetailsStep used 5, PolicyStep used 4). Hoisted here
   * rather than left inside each step so no step can silently reintroduce a
   * local rhythm. Keyed by `flow.step` so the entrance animation retriggers on
   * every step change, the same way ConnectStepShell keys its body by
   * `stateKey`. Step 3 stays OUTSIDE this wrapper and keeps its own
   * shell/rhythm — changing it was explicitly out of scope for #1411.
   *
   * Both wrappers are the step-change focus target (#3687): `tabIndex=-1`
   * keeps them out of the Tab order and Modal's first-focusable query,
   * `outline-none` keeps a programmatic focus from drawing a ring.
   */
  const steps =
    flow.step === 'connect' ? (
      <div ref={stepRegionRef} tabIndex={-1} className="outline-none">
        <ConnectStep flow={flow} nestedCopyBlocks={inline} />
      </div>
    ) : (
      <div
        key={flow.step}
        ref={stepRegionRef}
        tabIndex={-1}
        className="v2-animate-step-rise flex flex-col gap-5 outline-none"
      >
        {flow.step === 'details' && (
          <DetailsStep flow={flow} nameInputRef={nameInputRef} showCancel={!inline} />
        )}
        {flow.step === 'policy' && <PolicyStep flow={flow} />}
      </div>
    )

  return <>{children({ flow, progress, steps, nameInputRef, coarsePointer })}</>
}
