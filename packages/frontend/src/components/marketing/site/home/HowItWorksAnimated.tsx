'use client'

import {
  HOW_CYCLE_MS,
  useCycle,
  useDocumentVisible,
  useInView,
  usePrefersReducedMotion,
  useTyping,
  type CycleStep,
} from './motion'
import { PRINT_START_MS, PRINT_STAGGER_MS } from './motion-timings'
import { PasskeyMiniCard, BudgetMiniCard, type PasskeyCardState, type BudgetCardState } from './StepMiniCards'
import { ConnectorTerminal, type TerminalRevealState } from './ConnectorTerminal'
import { CONNECTOR_TERMINAL } from './fixtures'

/**
 * The how-it-works steps' motion — the mockup's 12 s script
 * (`docs/product/site-mockup/index.html:266-288`) as three client
 * controllers (#3575), one per step card. Each runs the mockup's cycle —
 * `loop(…, 12000, …)` at `index.html:277` — through `useCycle`, whose step
 * count returns to zero at the cycle boundary: the mockup's reset-and-loop
 * (:285-287).
 *
 * Offsets, verbatim from the script's step list: the passkey scans at 700 ms
 * and completes at 2100 ms to a green "Account created" confirmation
 * (:278-279); the budget amount types from 0.00 to 250.00 from 2500 ms
 * (95 ms per keystroke, :280), the control reads "Signing…" at 3400 ms
 * (:281) and completes to "Budget approved" at 4500 ms (:282); the terminal
 * prints its lines in sequence from 5800 ms (:283-284 — the mockup printed
 * two lines; this page prints the four of its storytelling script, see
 * `fixtures.ts`, staggered 550 ms apart).
 *
 * Each controller owns only the loop's state; the settled markup lives once,
 * in `PasskeyMiniCard`, `BudgetMiniCard` and `ConnectorTerminal`, which
 * render slice 2's settled card whenever no state is passed — under reduced
 * motion, before the loop starts, out of view, hidden tab. Confirmations are
 * text with a check icon in the success colour — never a pill or a button.
 *
 * Inside a running cycle the budget card follows the mockup exactly: 0.00
 * until the typing step, the typed progression, 250.00 after, reset to 0.00
 * at the boundary. The SETTLED render — reduced motion, out of view, before
 * the loop starts — shows the fixture 250.00, which is slice 2's pinned
 * state and the one a `prefers-reduced-motion` visitor sees throughout.
 *
 * The two mini cards are decorative (their call sites wrap them in
 * `aria-hidden`). The terminal is real page content (slice 2's decision):
 * its lines never leave the DOM — the reveal is opacity-only — so what
 * assistive technology reads is the complete, settled content at every
 * moment, and nothing announces (no live region, nothing inserted or
 * removed).
 */

/** The gate every loop shares: animate only in view, visible, unimpeded. */
function useLoopGate() {
  const reduced = usePrefersReducedMotion()
  const visible = useDocumentVisible()
  const { ref, inView } = useInView<HTMLDivElement>()
  return { ref, looping: !reduced && visible && inView }
}

/** Step 1's controller. Offsets: scan (:278), complete (:279). */
export function AnimatedPasskeyMiniCard() {
  const { ref, looping } = useLoopGate()

  const steps: CycleStep[] = [
    { at: 700, act: () => {} },
    { at: 2100, act: () => {} },
  ]
  const { stepIndex } = useCycle(steps, HOW_CYCLE_MS, looping)

  const state: PasskeyCardState | undefined = looping
    ? stepIndex >= 2
      ? { done: true }
      : stepIndex >= 1
        ? { scanning: true }
        : {}
    : undefined

  return (
    <div ref={ref} data-testid="passkey-animated" className="flex min-w-0 flex-1 flex-col">
      <PasskeyMiniCard state={state} />
    </div>
  )
}

/** Step 2's controller. Offsets: type (:280), "Signing…" (:281), approved (:282). */
export function AnimatedBudgetMiniCard() {
  const { ref, looping } = useLoopGate()

  const steps: CycleStep[] = [
    { at: 2500, act: () => {} },
    { at: 3400, act: () => {} },
    { at: 4500, act: () => {} },
  ]
  const { stepIndex } = useCycle(steps, HOW_CYCLE_MS, looping)

  const typing = stepIndex >= 1 && stepIndex < 2
  const signing = stepIndex >= 2 && stepIndex < 3
  const approved = stepIndex >= 3
  const { typed } = useTyping('250.00', typing)

  const phase: BudgetCardState['phase'] = !looping
    ? undefined
    : approved
      ? 'approved'
      : signing
        ? 'signing'
        : typing
          ? 'typing'
          : 'waiting'
  const state: BudgetCardState | undefined =
    phase === undefined ? undefined : { phase, typedAmount: typed }

  return (
    <div ref={ref} data-testid="budget-animated" className="flex min-w-0 flex-1 flex-col">
      <BudgetMiniCard state={state} />
    </div>
  )
}

/** Step 3's controller: the script's output lines print in sequence. */
export function AnimatedConnectorTerminal() {
  const { ref, looping } = useLoopGate()

  const steps: CycleStep[] = CONNECTOR_TERMINAL.output.map((_, index) => ({
    at: PRINT_START_MS + index * PRINT_STAGGER_MS,
    act: () => {},
  }))
  const { stepIndex } = useCycle(steps, HOW_CYCLE_MS, looping)

  const state: TerminalRevealState | undefined = looping
    ? { looping: true, printed: stepIndex }
    : undefined

  return (
    <div ref={ref} data-testid="terminal-animated" className="flex min-w-0 flex-1 flex-col">
      <ConnectorTerminal state={state} />
    </div>
  )
}
