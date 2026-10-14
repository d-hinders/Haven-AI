'use client'

import type { ReactNode } from 'react'

/**
 * #1377 C: the one persistent frame for everything after the setup prompt
 * exists. Step 3 used to swap between structurally unrelated bodies exactly
 * when the user was looking for reassurance; this shell keeps one silhouette
 * — a reserved body height — while the sub-states swap IN PLACE inside it.
 *
 * #3832 removed the shell's Waiting → Connected → Approved ticker. The
 * connect step's numbered list (`ConnectSteps`: copy → paste → approve) is
 * now the single progress signal on step 3 (#1418's one status voice), and a
 * ticker above it would be a second one. Terminal states (expired, cancelled,
 * failed, not found) render no list: their body explains.
 *
 * The body is keyed by `stateKey`, so it remounts — and plays the entry
 * transition — on every sub-state change, the step list included. That is
 * deliberate: a sub-state change is the screen moving forward (a row ticks,
 * the next one opens), which happens at most a few times per setup, and the
 * rise reads as that motion.
 */
export function ConnectStepShell({
  stateKey,
  children,
}: {
  /** Changes when the sub-state changes — re-triggers the entry transition. */
  stateKey: string
  children: ReactNode
}) {
  return (
    // Reserved height: the silhouette must not jump between sub-states.
    // #1392: the body is a flex column with ONE 20px rhythm (gap-5) — the
    // spacing the pre-#1380 `space-y-5` wrapper gave fragment sub-states,
    // restored at the source so no sub-state needs its own wrapper — and
    // `justify-center`, so a short sub-state's leftover reserved height
    // distributes around the content instead of pooling below its primary
    // button. Content at or above the floor is unaffected.
    <div
      key={stateKey}
      className="v2-animate-step-rise flex min-h-[340px] flex-col justify-center gap-5"
    >
      {children}
    </div>
  )
}
