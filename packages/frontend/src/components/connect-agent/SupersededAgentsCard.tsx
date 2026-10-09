'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { useAgents } from '@/hooks/useAgents'

/**
 * The surface this list sits on (#3690). A neutral callout, not a `Card`: it
 * renders inside the connect modal, where a filled card is the nested tier
 * `CLAUDE.md` § UI Surface Hierarchy rules out — and `Card.Section` assumes a
 * padded parent this modal does not give it, which put the text on the border.
 * Neutral because it is information, not a to-do: the restart `ActionCallout`
 * above it is the screen's to-do.
 */
function OfferCallout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
      {children}
    </div>
  )
}

/**
 * "Other agents set up on this machine" (#2561, reworded by #3830).
 *
 * ## What the report is, and why this card no longer says "replaced"
 *
 * `supersededAgentIds` is the connector's `superseded_agent_ids`: every OTHER
 * agent directory under the credential root (`listOtherAgentIds`), tombstoned
 * and key-less ones included, on any backend. It is not a replace set. Since
 * #3737 a run without `--name` wires a NEW named pair alongside the existing
 * ones, so for most runs these agents were never touched — and the card used
 * to title them "This setup replaced …" and offer Revoke on each, which invited
 * an owner to revoke working agents (#3830). The card cannot tell a `--replace`
 * run from a normal one (the retire signal, `retired_agent_ids`, is not on the
 * install report), so every sentence here has to be true for ANY reported id:
 * the connector found a folder for the agent on this machine, and Haven has
 * not revoked it. Not "active" — a listed agent can be paused or still
 * awaiting approval — and not "has a budget": one may have none, or one that
 * has expired, so the card says it MAY still hold a key and a budget. Owner
 * decision (2026-10-09): list them, offer no revoke — revoking stays on each
 * agent's own page, behind its own confirm.
 *
 * ## Two rules this component keeps
 *
 * **It never says "nothing here".** `supersededAgentIds` is a tri-state — a
 * list, `[]` (scanned, none), or `null`/undefined (the scan could not read the
 * credential root) — and this surface renders NOTHING for the last two.
 * Stated precisely: the silence comes from the INTERSECTION below being empty,
 * not from a null check, and this component does not itself distinguish `null`
 * from `[]`. The distinction is preserved on the wire and in the row for a
 * reader that needs it.
 *
 * **Only the owner's own, non-revoked agents are listed.** The connector falls
 * back to a DIRECTORY NAME when an `identity.json` will not parse, so the
 * report can hold strings that are not agent ids at all, or name somebody
 * else's agent. This intersects the report with the agents this session owns.
 */
export function SupersededAgentsCard({
  supersededAgentIds,
}: {
  /** Tri-state from `install_status`: list, `[]`, or `null`/absent. */
  supersededAgentIds?: readonly string[] | null
}) {
  const { agents, error, refetch } = useAgents()
  // Set only by THIS card's own Try again. `useAgents`' `loading` cannot stand
  // in for it: it is `true` on first mount too, before anything has failed, so
  // branching on it made a fresh completed setup announce that the agent list
  // could not be read.
  const [retrying, setRetrying] = useState(false)

  // The intersection, not the report. The `?? []` is the whole null handling:
  // the intersection already yields nothing for null, for `[]`, and for a
  // report naming agents this owner does not have.
  const listed = useMemo(() => {
    const reported = new Set(supersededAgentIds ?? [])
    return agents.filter((agent) => reported.has(agent.id) && agent.status !== 'revoked')
  }, [supersededAgentIds, agents])

  // The same discipline applied to the other half of the intersection: the
  // card reads the owner's agents itself, and that read can fail — after which
  // `agents` stays empty for good. Rendering nothing then is a false silence
  // about a list we know is non-empty. `error || retrying`, deliberately NOT
  // `loading` (see `retrying` above); `refetch` clears `error` synchronously,
  // so the retry flag keeps the card on screen while it runs.
  const reportedAny = (supersededAgentIds?.length ?? 0) > 0
  if (listed.length === 0 && reportedAny && (error || retrying)) {
    return (
      <OfferCallout>
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
          Other agents may be set up on this machine
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
          The connector found other agent folders here, but your agent list could not be loaded,
          so Haven cannot show which of them it has not revoked.
        </p>
        <div className="mt-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={retrying}
            onClick={() => {
              setRetrying(true)
              // `Promise.resolve(...)` because `refetch()`'s return is not
              // this component's to assume: `.finally` on `undefined` threw.
              void Promise.resolve(refetch()).finally(() => setRetrying(false))
            }}
          >
            {retrying ? 'Checking…' : 'Try again'}
          </Button>
        </div>
      </OfferCallout>
    )
  }

  // A first load in flight renders nothing — no claim about a read that has
  // not finished.
  if (listed.length === 0) return null

  const one = listed.length === 1
  return (
    <OfferCallout>
      <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
        {one ? 'Another agent is set up on this machine' : `${listed.length} other agents are set up on this machine`}
      </h3>
      {/* #3830: true for ANY reported id — a normal run, a `--replace` run,
          a key-less or tombstoned folder, a paused or not-yet-approved agent.
          No "replaced", no "unchanged", no "active", and no revoke offer
          (owner decision 2026-10-09). */}
      <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
        {one
          ? 'The connector found a folder for it here, and Haven has not revoked it, so it may still have a key and a budget. If you no longer use it, remove it from its agent page.'
          : 'The connector found folders for them here, and Haven has not revoked them, so each may still have a key and a budget. If you no longer use one, remove it from its agent page.'}
      </p>
      {/* `divide-y` draws between siblings, so it sits on the list whose
          children are the rows — on a wrapper around the list it drew none. */}
      <ul className="mt-3 divide-y divide-[var(--v2-border)] border-t border-[var(--v2-border)]">
        {listed.map((agent) => (
          <li key={agent.id} className="flex items-center justify-between gap-3 py-2.5 last:pb-0">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{agent.name}</p>
              {/* The status the title no longer claims, said per row. */}
              {agent.status === 'paused' ? (
                <p className="text-xs text-[var(--v2-ink-3)]">Paused</p>
              ) : agent.status === 'pending_approval' ? (
                <p className="text-xs text-[var(--v2-ink-3)]">Awaiting approval</p>
              ) : null}
            </div>
            <Link
              href={`/agents/${agent.id}`}
              // Named per agent: a list of links all reading "Open" is
              // ambiguous in a screen reader's links list.
              aria-label={`Open ${agent.name}`}
              className="shrink-0 text-xs text-[var(--v2-brand)] underline-offset-2 hover:underline"
            >
              Open
            </Link>
          </li>
        ))}
      </ul>
    </OfferCallout>
  )
}
