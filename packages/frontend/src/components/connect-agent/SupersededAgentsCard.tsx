'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import ConfirmDialog from '@/components/ConfirmDialog'
import { useAgents } from '@/hooks/useAgents'

/**
 * "This setup replaced agent(s) X — revoke them?" (#2561).
 *
 * A connector run on a machine that already held agents leaves those agents
 * alive with their own keys, and any host that started before the run keeps
 * spending as them. The connector says so in its terminal output and cannot do
 * anything about it: `POST /agents/:id/revoke` is owner-authenticated, and an
 * agent credential retiring a sibling agent is the "agent editing its own
 * authority" the re-key routes refuse. The dashboard has the owner's session,
 * so the offer belongs here.
 *
 * ## Three rules this component exists to keep
 *
 * **Nothing is revoked without a click.** Not on mount, not in a batch, not
 * "for convenience". Revoking is a spend-authority action and the owner takes
 * it one agent at a time, through the same danger-toned confirm the agent page
 * uses for removal.
 *
 * **It never says "nothing to revoke".** `supersededAgentIds` is a tri-state —
 * a list, `[]` (scanned, none), or `null`/undefined (the scan could not read
 * the credential root) — and this surface renders NOTHING for the last two.
 * That is the requirement: a dashboard that reported a clean machine on an
 * unscanned one would be asserting something Haven does not know.
 *
 * Stated precisely, because a mutation caught the comment overclaiming: the
 * silence comes from the INTERSECTION below being empty, not from a null
 * check. Deleting the early return changes no behaviour, so it is a
 * short-circuit rather than a guard, and this component does not itself
 * distinguish `null` from `[]`. The distinction is preserved on the wire and
 * in the row for a reader that needs it — the connector, the report and the
 * spec all keep the three states apart — and a later surface that wants to say
 * "we could not check this machine" has the fact available. Nothing here
 * invents it.
 *
 * **Only the owner's own agents are offered.** The connector falls back to a
 * DIRECTORY NAME when an `identity.json` exists but will not parse, so the
 * reported list can hold strings that are not agent ids at all — and could
 * name an agent belonging to someone else entirely. This intersects the report
 * with the agents this session actually owns, which is data the dashboard
 * already has. The revoke route's 404 on a foreign id is the backstop, not the
 * plan: an offer the user cannot act on is still a claim about their machine.
 */
export function SupersededAgentsCard({
  supersededAgentIds,
}: {
  /** Tri-state from `install_status`: list, `[]`, or `null`/absent. */
  supersededAgentIds?: readonly string[] | null
}) {
  const { agents, revokeAgent } = useAgents()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [failed, setFailed] = useState<Record<string, string>>({})

  // The intersection, not the report. An agent already revoked is dropped too
  // — offering to revoke it again is an action with no effect.
  const offered = useMemo(() => {
    // The `?? []` is the whole null handling. There is deliberately no early
    // return dressed up as a guard: the intersection already yields nothing
    // for null, for `[]`, and for a report naming agents this owner does not
    // have — three different facts with the same correct rendering.
    const reported = new Set(supersededAgentIds ?? [])
    return agents.filter((agent) => reported.has(agent.id) && agent.status !== 'revoked')
  }, [supersededAgentIds, agents])

  if (offered.length === 0) return null

  const pending = offered.find((agent) => agent.id === pendingId) ?? null

  async function confirmRevoke(id: string) {
    setBusyId(id)
    setFailed((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      await revokeAgent(id)
      setPendingId(null)
    } catch (err) {
      // Named per agent rather than as one banner: a partial failure across
      // several agents has to say WHICH one is still live.
      setFailed((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : 'Could not revoke this agent.',
      }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <Card>
        <Card.Section>
          <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
            {offered.length === 1
              ? 'This setup replaced an earlier agent'
              : `This setup replaced ${offered.length} earlier agents`}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            {offered.length === 1 ? 'It is' : 'They are'} still active with{' '}
            {offered.length === 1 ? 'its' : 'their'} own key, and anything that was already
            running keeps spending as {offered.length === 1 ? 'it' : 'them'}. Revoking stops that.
            You can also leave {offered.length === 1 ? 'it' : 'them'} — nothing here happens on its
            own.
          </p>
        </Card.Section>
        <Card.Section divided>
          <ul className="flex flex-col gap-3">
            {offered.map((agent) => (
              <li key={agent.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{agent.name}</p>
                  {failed[agent.id] && (
                    <p role="alert" className="text-xs text-[var(--v2-danger)]">
                      {failed[agent.id]}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId !== null}
                  onClick={() => setPendingId(agent.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </Card.Section>
      </Card>

      {pending && (
        <ConfirmDialog
          open
          tone="danger"
          title={`Revoke ${pending.name}?`}
          body={
            <>
              <p>
                Its key stops working immediately and it cannot spend again. This cannot be undone
                — a replacement agent gets a new key and a new budget you approve.
              </p>
              <p className="mt-2">
                Anything still running as this agent will start failing rather than stopping
                quietly, which is the point.
              </p>
            </>
          }
          confirmLabel="Revoke agent"
          cancelLabel="Keep it"
          loading={busyId === pending.id}
          onConfirm={() => void confirmRevoke(pending.id)}
          onCancel={() => setPendingId(null)}
        />
      )}
    </>
  )
}
