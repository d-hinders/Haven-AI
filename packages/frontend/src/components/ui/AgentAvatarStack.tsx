'use client'

/**
 * The overlapping agent avatar stack (#4480) — the "Paid by" column's marks,
 * as one shared piece rather than a per-table arrangement.
 *
 * ## What it is
 *
 * A row of `Monogram`s (`xxs`, 24px) that overlap by a negative inline margin,
 * capped at three with one `+N` overflow mark past the cap. It is generic over
 * agents: the caller hands it `{ id, name, avatarTint }` and nothing here knows
 * what an agent is beyond those three fields.
 *
 * ## Colour is not invented here
 *
 * Each mark is `<Monogram tint={agent.avatarTint} …/>`, which resolves through
 * `resolveAvatarTint` — the SAME stored tint `seriesColorForAgent` fills the
 * agent's chart series with (#4428). So an agent's stack mark and its chart
 * fill are one colour, and this component owns no colour logic of its own. The
 * `+N` mark is neutral ink (`--v2-surface-2` ground, `--v2-ink-2` figure),
 * never a tint: it counts agents, it is not one.
 *
 * ## One focus stop, not one per mark
 *
 * A standalone `Tooltip` makes its wrapper `tabIndex=0` with
 * `aria-describedby` (`packages/ui/src/Tooltip.tsx`), so a tooltip per mark
 * would add three tab stops per row — up to thirty in the merchants table —
 * each wrapped around `aria-hidden` content. Instead:
 *
 * - every monogram and the `+N` mark is `decorative` (they are `aria-hidden`);
 * - the stack root is `role="img"` with ONE `aria-label` naming the agents in
 *   the roster's words ("Atlas, Data agent and 1 more") — `role="img"` is what
 *   makes an `aria-label` on a non-interactive element authoritative, and it
 *   makes the marks inside it presentational;
 * - ONE shared `Tooltip` around the whole stack shows the same names on hover
 *   or focus. Never a bare `title=`.
 *
 * ## The ground it sits on
 *
 * The overlap needs a ring in the ground so two marks stay separable in both
 * themes, and the ring is `--v2-bg` — the default `Card` ground
 * (`packages/ui/src/Card.tsx`; the frontend `components/ui/Card.tsx` is a
 * re-export). Supported: the default card. NOT supported: the `anchor` card
 * (`--v2-surface-anchor`) and table header bands, where the ring would read as
 * a light halo. On a hovered table row the ring stays `--v2-bg` and reads as a
 * thin outline on the hover tint. No new token, and no design-lint rule covers
 * rings or negative margins.
 *
 * ## Edge inputs
 *
 * Zero agents renders nothing (`null`) — the caller keeps its own text for
 * that case. An agent whose name is unknown is passed with the caller's
 * fallback label as `name` and `avatarTint: null` (the name hash); the stack
 * never invents a name.
 */

import { Monogram } from '@/components/ui/Monogram'
import { Tooltip } from '@/components/ui/Tooltip'

/** The agents the stack shows, in the caller's order. */
export type StackedAgent = {
  id: string
  name: string
  /** The agent's STORED tint (`agents.avatar_tint`, 1..6); `null` for the hash. */
  avatarTint: number | null
}

/** The default cap: three marks, matching `MAX_AGENT_NAMES` in the merchants
 *  table. Three is the issue's number, not this component's opinion of it. */
export const AGENT_AVATAR_STACK_CAP = 3

/**
 * The roster sentence a list of names and a total reads as: "Atlas, Data agent
 * and 1 more". Shared with the merchants table's "Paying agents" line, which
 * is the same sentence in the same words — one rule, one home. A total of zero
 * is the CALLER's copy ("No paying agents reported"), not this function's: the
 * stack renders nothing for zero agents, so it never needs a sentence for it.
 */
export function rosterLine(names: string[], total: number): string {
  const rest = total - names.length
  return rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ')
}

export function AgentAvatarStack({
  agents,
  cap = AGENT_AVATAR_STACK_CAP,
  className = '',
}: {
  agents: StackedAgent[]
  /** How many marks to show before the `+N` overflow mark. */
  cap?: number
  className?: string
}) {
  if (agents.length === 0) return null
  const shown = agents.slice(0, cap)
  const overflow = agents.length - shown.length
  const label = rosterLine(
    shown.map((agent) => agent.name),
    agents.length,
  )
  return (
    <Tooltip label={label}>
      <span
        data-testid="agent-avatar-stack"
        role="img"
        aria-label={label}
        className={`inline-flex items-center ${className}`}
      >
        {shown.map((agent, i) => (
          // The ring lives on the wrapper, not on `Monogram`: the primitive
          // stays untouched, and the wrapper's box is exactly the mark's, so
          // the ring is a circle around the circle.
          <span
            key={agent.id}
            data-testid="agent-avatar-stack-mark"
            className={`inline-flex rounded-full ring-2 ring-[var(--v2-bg)] ${i > 0 ? '-ml-2' : ''}`}
          >
            <Monogram name={agent.name} tint={agent.avatarTint} size="xxs" decorative />
          </span>
        ))}
        {overflow > 0 && (
          <span
            data-testid="agent-avatar-stack-overflow"
            className={`inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface-2)] text-xs font-semibold text-[var(--v2-ink-2)] ring-2 ring-[var(--v2-bg)] ${
              shown.length > 0 ? '-ml-2' : ''
            }`}
          >
            +{overflow}
          </span>
        )}
      </span>
    </Tooltip>
  )
}
