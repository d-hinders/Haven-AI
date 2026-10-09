'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import ConfirmDialog from '@/components/ConfirmDialog'
import WalletConnectAction from '@/components/WalletConnectAction'
import { RemoveAgentDialog } from '@/components/agent-panel/RemoveAgentDialog'
import { useAgents, type Agent } from '@/hooks/useAgents'
import { useDelegationBudget, type BudgetResult } from '@/hooks/useDelegationBudget'
import { FINISH_REVOKING_LABEL } from '@/lib/half-revoked'

/**
 * What is left after the credential was revoked but the budget was not ended
 * (#3542). The row stays on screen, saying which half happened.
 */
type Unfinished = 'signature' | 'too_many' | 'unlinked'

/** What the confirm dialog hands the card so the card owns every state change. */
interface BudgetSigner {
  revokeAll: () => Promise<BudgetResult>
  ready: boolean
}

/**
 * The surface this offer sits on (#3690). A neutral callout, not a `Card`: it
 * renders inside the connect modal, where a filled card is the nested tier
 * `CLAUDE.md` § UI Surface Hierarchy rules out — and `Card.Section` assumes a
 * padded parent this modal does not give it, which put the text on the border.
 * Neutral rather than warning-soft because the per-row `Unfinished` alerts are
 * warning-toned text and would lose contrast on an amber fill; neutral rather
 * than brand-soft because the restart `ActionCallout` above it is the screen's
 * to-do, and this is a decision the owner may decline.
 */
function OfferCallout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
      {children}
    </div>
  )
}

function RevokeConfirmBody({ linked }: { linked: boolean }) {
  return (
    <>
      <p>
        Its key stops working immediately.{' '}
        {linked
          ? 'You then sign once to end its budget — until you do, the budget stays active.'
          : 'Its budget may still be active on the account it was removed from, and Haven cannot end it from here.'}{' '}
        This cannot be undone — a replacement agent gets a new key and a new budget you approve.
      </p>
      <p className="mt-2">
        Anything still running as this agent will start failing rather than stopping quietly. That
        is expected, not a fault to chase.
      </p>
    </>
  )
}

/**
 * The confirm for an agent with a linked account. Mounts `useDelegationBudget`
 * for THIS agent only — never one hook per row — on the agent's own chain, so
 * the budget signature is prepared against the network the agent lives on.
 */
function RevokeAndEndBudgetDialog({
  agent,
  chainId,
  loading,
  onConfirm,
  onCancel,
}: {
  agent: Agent
  chainId: number
  loading: boolean
  onConfirm: (signer: BudgetSigner) => void
  onCancel: () => void
}) {
  const { revokeAll, ready, busy, signersLoading, signersError } = useDelegationBudget(agent.id, chainId)
  return (
    <ConfirmDialog
      open
      tone="danger"
      title={`Revoke ${agent.name}?`}
      body={
        <>
          <RevokeConfirmBody linked />
          {!ready && !signersLoading && (
            <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
              This device cannot sign for the account. Its key will still be revoked, but the
              budget stays active until you finish on a device that can.
            </p>
          )}
          {/* #3812: the budget half needs the owner's signature — connect or
              switch in place so the revoke can finish here. */}
          {!ready && !signersLoading && !signersError ? (
            <WalletConnectAction className="mt-2" />
          ) : null}
        </>
      }
      confirmLabel="Revoke agent"
      cancelLabel="Keep it"
      loading={loading || busy}
      // While the signer set loads, `ready` is not yet an answer: a click now
      // would revoke the credential and skip the signature for no reason. Only
      // the confirm waits — cancel stays usable, so a hung read never traps
      // the owner in the dialog.
      confirmDisabled={signersLoading}
      onConfirm={() => onConfirm({ revokeAll, ready })}
      onCancel={onCancel}
    />
  )
}

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
  const { agents, error, refetch, revokeAgent, markBudgetEnded } = useAgents()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [failed, setFailed] = useState<Record<string, string>>({})
  // Agents whose credential is revoked but whose budget is not yet ended. They
  // stay listed (#3542) — the row must not vanish on the credential half.
  const [unfinished, setUnfinished] = useState<Record<string, Unfinished>>({})
  const [finishId, setFinishId] = useState<string | null>(null)
  // Set only by THIS card's own Try again. `useAgents`' `loading` cannot stand
  // in for it: it is `true` on first mount too, before anything has failed, so
  // branching on it made a fresh completed setup announce that the agent list
  // could not be read — a false claim on the one screen this flow exists to
  // make trustworthy, and one an earlier test of mine asserted as correct.
  const [retrying, setRetrying] = useState(false)

  // The intersection, not the report. An agent already revoked is dropped too
  // — offering to revoke it again is an action with no effect.
  const offered = useMemo(() => {
    // The `?? []` is the whole null handling. There is deliberately no early
    // return dressed up as a guard: the intersection already yields nothing
    // for null, for `[]`, and for a report naming agents this owner does not
    // have — three different facts with the same correct rendering.
    const reported = new Set(supersededAgentIds ?? [])
    return agents.filter(
      (agent) =>
        reported.has(agent.id) &&
        // Revoked agents are dropped — except the ones this card is mid-revoke
        // on or has left half-revoked, which still need the owner's attention.
        (agent.status !== 'revoked' || busyId === agent.id || agent.id in unfinished),
    )
  }, [supersededAgentIds, agents, busyId, unfinished])

  // The same discipline this component applies to the REPORT, applied to the
  // other half of the intersection (#2561 review). The card reads the owner's
  // agents itself, and that read can fail — after which `agents` stays empty
  // for good. Rendering nothing then is a false silence: it looks exactly like
  // "this setup replaced nothing", about a list we know is non-empty.
  //
  // Only reached when the connector actually named agents. A failed read with
  // nothing reported has nothing to be silent about.
  const reportedAny = (supersededAgentIds?.length ?? 0) > 0
  // `error || retrying`, and the second half is deliberately NOT `loading`.
  // `refetch` clears `error` synchronously before the request settles, so
  // branching on the error alone made the card — including the button just
  // clicked — vanish for the length of the retry. Branching on `loading`
  // instead fixed that and broke something worse: `loading` starts `true`, so
  // the card claimed a failed read on every first mount. Only a retry this
  // card started keeps it on screen.
  if (offered.length === 0 && reportedAny && (error || retrying)) {
    return (
      <OfferCallout>
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
          This setup may have replaced an earlier agent
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
          Your agent list could not be loaded, so Haven cannot show which — or offer to revoke
          them here. Nothing has changed either way.
        </p>
        <div className="mt-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={retrying}
            onClick={() => {
              setRetrying(true)
              // `Promise.resolve(...)` because `refetch()`'s return is not
              // this component's to assume. Calling `.finally` on it threw a
              // TypeError for any caller whose refetch returns nothing —
              // and the local suite still reported 1472 passing while doing
              // it, because an unhandled rejection inside an onClick is not
              // a failed assertion. CI was stricter and right.
              void Promise.resolve(refetch()).finally(() => setRetrying(false))
            }}
          >
            {retrying ? 'Checking…' : 'Try again'}
          </Button>
        </div>
      </OfferCallout>
    )
  }

  // A first load in flight renders nothing — no skeleton, and above all no
  // claim about a read that has not finished. It resolves on its own, on a
  // screen that has just finished celebrating a completed setup. The branch
  // above speaks only for a read that actually failed, or a retry of one.
  if (offered.length === 0) return null

  const pending = offered.find((agent) => agent.id === pendingId) ?? null

  const finishAgent = agents.find((agent) => agent.id === finishId) ?? null

  async function confirmRevoke(agent: Agent, signer: BudgetSigner | null) {
    const id = agent.id
    setBusyId(id)
    setFailed((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      // Credential first: it needs no signature, so it works even when this
      // device cannot sign. A failure here changed nothing.
      await revokeAgent(id)
    } catch (err) {
      // Named per agent rather than as one banner: a partial failure across
      // several agents has to say WHICH one is still live.
      setFailed((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : 'Could not revoke this agent.',
      }))
      setBusyId(null)
      return
    }

    // Then the budget (#3542): revoking the credential does not end the budget
    // delegation — it stays redeemable on-chain until the owner signs revoke-all.
    let leftover: Unfinished | null = null
    if (!signer) {
      leftover = 'unlinked'
    } else if (!signer.ready) {
      leftover = 'signature'
    } else {
      const result = await signer.revokeAll()
      if (result.ok) markBudgetEnded(id)
      else leftover = result.reason === 'too_many' ? 'too_many' : 'signature'
    }
    if (leftover) {
      const reason = leftover
      setUnfinished((prev) => ({ ...prev, [id]: reason }))
    }
    setPendingId(null)
    setBusyId(null)
  }

  return (
    <>
      <OfferCallout>
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
          {offered.length === 1
            ? 'This setup replaced an earlier agent'
            : `This setup replaced ${offered.length} earlier agents`}
        </h3>
        {/* #3690: two sentences, and the agents are named only in the rows.
            Both halves of the revoke stay (#3542) — the key, and the budget
            only the owner's signature ends. What breaks when they go is the
            confirm dialog's to say, at the moment it applies. */}
        <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
          {offered.length === 1
            ? 'It still has its own key and budget. Revoking ends its key, and one signature from you ends its budget.'
            : 'They still have their own keys and budgets. Revoking each one ends its key, and one signature from you ends its budget.'}
        </p>
        {/* `divide-y` draws between siblings, so it sits on the list whose
            children are the rows — on a wrapper around the list it drew none. */}
        <ul className="mt-3 divide-y divide-[var(--v2-border)] border-t border-[var(--v2-border)]">
          {offered.map((agent) => (
            <li key={agent.id} className="flex items-center justify-between gap-3 py-2.5 last:pb-0">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{agent.name}</p>
                {failed[agent.id] && (
                  <p role="alert" className="text-xs text-[var(--v2-danger)]">
                    {failed[agent.id]}
                  </p>
                )}
                {unfinished[agent.id] && (
                  <p role="alert" className="text-xs text-[var(--v2-warning)]">
                    {unfinished[agent.id] === 'unlinked'
                      ? 'Its key is revoked. Its budget may still be active on the account it was removed from, and Haven cannot end it from here.'
                      : unfinished[agent.id] === 'too_many'
                        ? 'Its key is revoked, but its budget is still active — it holds too many budgets to end in one signature. Stop them one by one on the agent’s budget card.'
                        : 'Its key is revoked, but its budget is still active. Finish revoking to end it.'}
                  </p>
                )}
              </div>
              {unfinished[agent.id] === 'signature' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  aria-label={`${FINISH_REVOKING_LABEL} ${agent.name}`}
                  disabled={busyId !== null}
                  onClick={() => setFinishId(agent.id)}
                >
                  {FINISH_REVOKING_LABEL}
                </Button>
              ) : unfinished[agent.id] === 'too_many' ? (
                <Link
                  href={`/agents/${agent.id}`}
                  className="text-xs text-[var(--v2-brand)] underline-offset-2 hover:underline"
                >
                  Open budget card
                </Link>
              ) : unfinished[agent.id] === 'unlinked' ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  // Named per agent: a list of buttons all reading "Revoke" is
                  // ambiguous in a screen reader's forms list, and the sibling
                  // `AgentCard` already carries this exact fix.
                  aria-label={`Revoke ${agent.name}`}
                  disabled={busyId !== null}
                  onClick={() => setPendingId(agent.id)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      </OfferCallout>

      {pending &&
        (pending.account_id && pending.account_chain_id != null ? (
          <RevokeAndEndBudgetDialog
            agent={pending}
            // The agent's own chain, never the default: the budget signature is
            // prepared against the network the agent actually lives on.
            chainId={pending.account_chain_id}
            loading={busyId === pending.id}
            onConfirm={(signer) => void confirmRevoke(pending, signer)}
            onCancel={() => setPendingId(null)}
          />
        ) : (
          <ConfirmDialog
            open
            tone="danger"
            title={`Revoke ${pending.name}?`}
            body={<RevokeConfirmBody linked={false} />}
            confirmLabel="Revoke agent"
            cancelLabel="Keep it"
            loading={busyId === pending.id}
            onConfirm={() => void confirmRevoke(pending, null)}
            onCancel={() => setPendingId(null)}
          />
        ))}

      {finishAgent && (
        // Retry for the budget half: the credential is already revoked, so this
        // is the Remove dialog's finish mode — it ends the budget and nothing else.
        <RemoveAgentDialog
          agent={finishAgent}
          chainId={finishAgent.account_chain_id ?? undefined}
          mode="finish"
          onRevokeCredential={() => revokeAgent(finishAgent.id)}
          onArchive={async () => {}}
          onBudgetEnded={() => {
            markBudgetEnded(finishAgent.id)
            setUnfinished((prev) => {
              const next = { ...prev }
              delete next[finishAgent.id]
              return next
            })
          }}
          onClose={() => setFinishId(null)}
        />
      )}
    </>
  )
}
