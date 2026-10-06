'use client'

import { useCycle, useLoopGate, type CycleStep } from './motion'
import { DEV_CYCLE_MS, DEV_STEPS_MS } from './motion-timings'
import { DevTerminal, type DevRevealState } from './DevTerminal'

/**
 * The developers band's controller (#3684): the transcript prints line by
 * line — mockup V19's script (artifact version `1791288451-c24e`,
 * `index.html:289-298`) — on a 13 s cycle through the shared gate and
 * engine (`useLoopGate`, `useCycle`). Twelve reveal steps at the fixture's
 * offsets; the thirteenth step, at 9400 ms, removes the cursor. `useCycle`
 * returns to zero at the boundary, so the full transcript holds from 9400
 * to 13000 and then fades out and replays.
 *
 * Under reduced motion, out of view, or before the loop starts, no state is
 * passed and `DevTerminal` renders slice 2's settled transcript — the full
 * text, no cursor.
 */
export function AnimatedDevTerminal() {
  const { ref, looping } = useLoopGate()

  const steps: CycleStep[] = DEV_STEPS_MS.map((at) => ({ at, act: () => {} }))
  const { stepIndex } = useCycle(steps, DEV_CYCLE_MS, looping)

  const state: DevRevealState | undefined = looping ? { looping: true, printed: stepIndex } : undefined

  return (
    <div ref={ref} data-testid="dev-animated" className="min-w-0">
      <DevTerminal state={state} />
    </div>
  )
}
