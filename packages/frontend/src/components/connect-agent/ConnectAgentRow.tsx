/**
 * The connect flow's agent row (#4702, epic #4701).
 *
 * #4706 puts this above the connect checklist: the agent's name and one status
 * line, so the screen says **who** you are waiting for instead of only what is
 * left to do. "Research agent / Listening for it…" while the connector runs,
 * then "Connected just now" once it lands.
 *
 * It is presentational and owns no live region: the caller announces the
 * change once, alongside the row that changed (§ Step status checklist). It
 * never restates a step — the checklist below owns progress, and § Step status
 * checklist forbids a third signal that restates either the counter or the
 * rows.
 *
 * The mark is the shared `Monogram` (`xs`, decorative), the same agent mark the
 * dashboard's `AgentRow` uses, so an agent looks the same wherever it appears.
 * Once connected, a small success check sits on the mark's corner, so the row
 * reads "done" at a glance and not only from its subtitle (owner review of the
 * specimens on #4728, 2026-11-08). It is the AGENT's state, not a step: the
 * checklist below still owns progress. Decorative — the subtitle is the text.
 */

import { Check } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Monogram } from '@/components/ui/Monogram'

export type ConnectAgentRowState = 'waiting' | 'connected'

const STATUS_COPY: Record<ConnectAgentRowState, string> = {
  waiting: 'Listening for it…',
  connected: 'Connected just now',
}

export function ConnectAgentRow({
  name,
  state,
  className = '',
}: {
  /** The agent's name, as the user typed it. Never empty — the caller falls back. */
  name: string
  state: ConnectAgentRowState
  /** Extra classes for the row (placement, not identity). */
  className?: string
}) {
  return (
    <div className={`flex items-center gap-3 ${className}`.trim()}>
      <span className="relative inline-flex shrink-0">
        <Monogram name={name} size="xs" decorative />
        {state === 'connected' ? (
          <span
            data-testid="connect-agent-row-connected-mark"
            aria-hidden="true"
            className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--v2-success)] ring-2 ring-[var(--v2-bg)]"
          >
            <Icon icon={Check} className="h-3 w-3 text-[var(--v2-bg)]" strokeWidth={3} />
          </span>
        ) : null}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{name}</p>
        <p className="text-xs text-[var(--v2-ink-3)]">{STATUS_COPY[state]}</p>
      </div>
    </div>
  )
}

export default ConnectAgentRow
