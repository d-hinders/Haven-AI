'use client'

import type { ReactNode } from 'react'

/**
 * #1377 C: the one persistent frame for everything after the setup prompt
 * exists. Step 4 used to swap between structurally unrelated bodies exactly
 * when the user was looking for reassurance; this shell keeps one silhouette
 * — a stable progress header (Waiting → Connected → Approved) and a reserved
 * body height — while the sub-states swap IN PLACE beneath it.
 *
 * `phase` drives the header ticker only; the body is whatever sub-state the
 * flow resolved. Terminal states (expired/cancelled/failed) pass 'halted':
 * the ticker stays visible but nothing is highlighted — the body explains.
 */
export type ConnectShellPhase = 'waiting' | 'connected' | 'approved' | 'halted'

const PHASES: Array<{ id: Exclude<ConnectShellPhase, 'halted'>; label: string }> = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'connected', label: 'Connected' },
  { id: 'approved', label: 'Approved' },
]

function phaseIndex(phase: ConnectShellPhase): number {
  if (phase === 'halted') return -1
  return PHASES.findIndex((p) => p.id === phase)
}

export function ConnectStepShell({
  phase,
  stateKey,
  children,
}: {
  phase: ConnectShellPhase
  /** Changes when the sub-state changes — re-triggers the entry transition. */
  stateKey: string
  children: ReactNode
}) {
  const active = phaseIndex(phase)
  return (
    <div className="space-y-5">
      <div className="flex h-8 items-center justify-center gap-2" aria-label="Connection progress">
        {PHASES.map((p, index) => {
          const done = active > index
          const current = active === index
          return (
            <div key={p.id} className="flex items-center gap-2">
              {index > 0 && (
                <div
                  className={`h-px w-8 ${done || current ? 'bg-[var(--v2-brand)]/40' : 'bg-[var(--v2-border)]'}`}
                />
              )}
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    done
                      ? 'bg-[var(--v2-success)]'
                      : current
                        ? 'bg-[var(--v2-brand)] motion-safe:animate-pulse'
                        : 'bg-[var(--v2-border)]'
                  }`}
                />
                <span
                  className={`text-xs ${
                    current
                      ? 'font-medium text-[var(--v2-ink)]'
                      : done
                        ? 'text-[var(--v2-ink-2)]'
                        : 'text-[var(--v2-ink-3)]'
                  }`}
                >
                  {p.label}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      {/* Reserved height: the silhouette must not jump between sub-states.
          #1392: the body is a flex column with ONE 20px rhythm (gap-5) — the
          spacing the pre-#1380 `space-y-5` wrapper gave fragment sub-states,
          restored at the source so no sub-state needs its own wrapper — and
          `justify-center`, so a short sub-state's leftover reserved height
          distributes around the content instead of pooling below its primary
          button. Content at or above the floor is unaffected. */}
      <div
        key={stateKey}
        className="v2-animate-step-rise flex min-h-[340px] flex-col justify-center gap-5"
      >
        {children}
      </div>
    </div>
  )
}
