'use client'

/**
 * The agent detail page's Spending section (#833, epic #821; one budget
 * surface since #3695, epic #3691).
 *
 * Renders only for delegation-rail accounts. Grant a budget (one signature),
 * see active budgets with how much of the period is used, revoke (one
 * signature). Outcome language only — the words "delegation", "caveat",
 * "redemption", "UserOp" never appear in the UI (asserted in the tests); a
 * budget is "a budget that refills itself".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isAddress, parseUnits, formatUnits } from 'viem'
import type { Address } from 'viem'
import { useDelegationBudget, type DelegationBudget, type GrantInput } from '@/hooks/useDelegationBudget'
import { useTaskBudgets, type TaskBudget } from '@/hooks/useTaskBudgets'
import { useSubBudgetTrees, type SubBudgetTree } from '@/hooks/useSubBudgets'
import BudgetGrantAction from './BudgetGrantAction'
import EditBudgetModal from './EditBudgetModal'
import IssueSubBudgetModal from './IssueSubBudgetModal'
import ConfirmDialog from './ConfirmDialog'
import { eligibleSubBudgetParents } from '@/lib/sub-budget'
import { Card } from './ui/Card'
import { Skeleton } from './ui/Skeleton'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { Row } from './ui/Row'
import { useToast } from './ui/Toast'
import { BudgetMeter, truncateAddress } from '@/components/haven'
import { timeUntil } from '@/lib/format'

interface TokenOption {
  address: string
  symbol: string
  decimals: number
}

interface Props {
  agentId: string
  chainId: number
  tokens: TokenOption[]
  /**
   * #3717: the agent's display name, for the Stop confirm's body ("{agent}
   * can no longer spend from this 1 USDC/day budget…"). This card has one
   * mount site, so it is a plain prop rather than a name lookup.
   */
  agentName: string
  /**
   * Fires after a successful grant or revoke (#1090): the agent-page budget
   * SUMMARY reads a different source (useAgents) than this card's live
   * delegations, so the parent must refetch or the summary stays stale until
   * remount.
   */
  onBudgetChange?: () => void
  /**
   * #3549: the agent is revoked or archived. Its card stays read-only plus
   * Stop — nothing that GRANTS authority (set, edit, issue a sub-budget) is
   * offered to an agent being retired; ending what is left is all that remains.
   * The backend refuses build/activate for a revoked agent anyway.
   */
  retired?: 'revoked' | 'archived'
}

/**
 * Stable anchor for the card so budget affordances elsewhere on the agent
 * page can scroll to it instead of opening the legacy editor (#1079).
 */
export const DELEGATION_BUDGET_CARD_ID = 'delegation-budget-card'

const PERIODS: Array<{ label: string; seconds: number }> = [
  { label: 'per day', seconds: 86_400 },
  { label: 'per week', seconds: 604_800 },
  { label: 'per month', seconds: 2_592_000 },
]

/**
 * When a budget's next refill happens. `period_end` comes from the read
 * (#3693) and can be stale: the hook polls, so a response can land moments
 * before a boundary and be read after it. A past `period_end` is rolled
 * forward by whole periods — the same boundary arithmetic the server uses —
 * rather than rendering "refills expired".
 */
function nextRefillMs(periodEndIso: string, periodSeconds: number, nowMs: number): number | null {
  const end = Date.parse(periodEndIso)
  if (!Number.isFinite(end)) return null
  if (end > nowMs || periodSeconds <= 0) return end
  const periodMs = periodSeconds * 1000
  return end + Math.ceil((nowMs - end + 1) / periodMs) * periodMs
}

/** "in 45m", "in 14h", "in 3 days" — the coarse future the caption needs. */
function inDuration(targetMs: number, nowMs: number): string {
  const mins = Math.max(1, Math.round((targetMs - nowMs) / 60_000))
  if (mins < 60) return `in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `in ${hours}h`
  return `in ${Math.round(hours / 24)} days`
}

export default function DelegationBudgetCard({ agentId, chainId, tokens, agentName, onBudgetChange, retired }: Props) {
  // #3695: this card is the one caller that asks for remaining-this-period —
  // the meter on each row is drawn from it.
  const { budgets, grant, editBudget, revoke, busy, ready, budgetsError, reload, signersError, reloadSigners } =
    useDelegationBudget(agentId, chainId, { includeRemaining: true })
  // #3329: read separately from the period budgets above — a failed fetch
  // here must never take the budgets list down with it, so `taskBudgets`
  // stays `null` (nothing rendered) rather than surfacing its own error UI.
  const { taskBudgets } = useTaskBudgets(agentId)
  // #3330: the parent→child sub-budget trees this agent ISSUES, read the
  // same defensive way — `trees` stays `null` (nothing rendered) on failure.
  const { trees: subBudgetTrees, reload: reloadSubBudgets } = useSubBudgetTrees(agentId)
  // #3506: the issue-sub-budget modal's open flag.
  const [issuingSubBudget, setIssuingSubBudget] = useState(false)
  const openTaskBudgets = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000)
    return (taskBudgets ?? []).filter((t) => t.status === 'open' && !t.is_expired && t.expires_at > nowSec)
  }, [taskBudgets])
  const { toast } = useToast()
  // #3166: the ACTIVE budget whose limits are being edited in place, and the
  // modal's open flag — one state so closing the modal and clearing the
  // anchor cannot disagree.
  const [editing, setEditing] = useState<DelegationBudget | null>(null)

  const handleEditClosed = useCallback(() => {
    setEditing(null)
  }, [])

  const [token, setToken] = useState(tokens[0]?.address ?? '')
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState(86_400)
  const [recipient, setRecipient] = useState('')

  // ── ?grant=<delegation hash> prefill (#2539) ──
  // The #2539 CLI's signing link lands here: the backend built a pending
  // budget and printed a URL carrying its hash. The grant form opens with
  // that build's fields already filled, so what the human signs is exactly
  // what was constructed — not a re-typed approximation of it. The values
  // come from the pending row this card already fetches; there is no second
  // read and no new backend route.
  //
  // Same stance as `?setup=` on the agents list (B2): a foreign or unknown
  // hash is not an error state — the lookup finds nothing and the form stays
  // blank. The URL is tidied once applied; a stale link after that simply
  // opens the normal form.
  const grantHash = useMemo(() => {
    if (typeof window === 'undefined') return null
    const g = new URLSearchParams(window.location.search).get('grant')
    return g && /^0x[0-9a-fA-F]{64}$/.test(g) ? g : null
  }, [])
  const [prefill, setPrefill] = useState<{ hash: string; periodSeconds: number } | null>(null)
  // #3695: once a budget exists, the grant form is collapsed behind "Add
  // budget" — a permanent second form made "Set budget" the strongest element
  // on the page. With no active budget the form is the section's content and
  // this flag is not consulted. A `?grant=` prefill opens it (#2539): the
  // human must see the build they are about to sign.
  const [formOpen, setFormOpen] = useState(false)
  // Opening and collapsing swap the pressed control for another, so focus
  // would fall to <body> (#3695 review). An owner-initiated toggle says where
  // focus goes next — the amount field on open, Add budget on collapse; the
  // `?grant=` prefill opens without one, so a page load never steals focus.
  const addBudgetRef = useRef<HTMLButtonElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const pendingFocus = useRef<'amount' | 'add' | null>(null)
  const openForm = useCallback(() => {
    pendingFocus.current = 'amount'
    setFormOpen(true)
  }, [])
  const collapseForm = useCallback(() => {
    pendingFocus.current = 'add'
    setFormOpen(false)
  }, [])
  // #3716: the sub-budget entry lives in the Add budget panel, below the
  // grant form. Clicking it collapses the form and opens the modal. It
  // deliberately does NOT route through `collapseForm`/`pendingFocus`: the
  // card's focus effect below fires on the `formOpen` change — after
  // `Modal`'s own child effect (ui/Modal.tsx) — so a pending focus would pull
  // focus back out of the dialog that just opened. The typed amount and
  // recipient survive, exactly as Cancel leaves them.
  const openSubBudget = useCallback(() => {
    setFormOpen(false)
    setIssuingSubBudget(true)
  }, [])
  useEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    pendingFocus.current = null
    ;(target === 'amount' ? amountRef.current : addBudgetRef.current)?.focus()
  }, [formOpen])

  // #3716: when the modal closes, `formOpen` does not change, so the effect
  // above does not run — and `Modal` restores focus to the clicked entry
  // (ui/Modal.tsx), which the collapsed form has unmounted. Focus Add budget
  // explicitly, once per open→close cycle; the guard keeps the initial
  // render (and a close without a modal) from stealing focus.
  const wasIssuingSubBudget = useRef(false)
  useEffect(() => {
    if (issuingSubBudget) {
      wasIssuingSubBudget.current = true
    } else if (wasIssuingSubBudget.current) {
      wasIssuingSubBudget.current = false
      addBudgetRef.current?.focus()
    }
  }, [issuingSubBudget])

  useEffect(() => {
    // #3549: a retired agent's card has no grant form to fill — leave the
    // URL as it is rather than tidying away a link nothing consumed.
    if (retired || !grantHash || budgets === null || prefill) return
    const row = budgets.find((b) => b.delegation_hash === grantHash && b.status === 'pending')
    if (!row) return
    const t = tokens.find((x) => x.address.toLowerCase() === row.token_address.toLowerCase())
    if (t) setToken(t.address)
    try {
      setAmount(formatUnits(BigInt(row.budget_atomic), t?.decimals ?? 18))
    } catch {
      // A malformed stored amount leaves the field empty rather than
      // prefilling something the form would refuse — the human types it.
    }
    setPeriod(row.period_seconds)
    setRecipient(row.recipient_address ?? '')
    setPrefill({ hash: grantHash, periodSeconds: row.period_seconds })
    setFormOpen(true)
    try {
      window.history.replaceState(null, '', `/agents/${agentId}`)
    } catch {
      // A URL that stays untidy is not worth a thrown render.
    }
  }, [retired, grantHash, budgets, tokens, agentId, prefill])

  // The period picker offers the day/week/month rhythm; a prefilled build may
  // carry any period the CLI chose (an hour, a minute-floor of 60s), so the
  // prefilled value gets its own option instead of silently desyncing the
  // Select from the state it shows.
  const periodOptions = useMemo(() => {
    const list = [...PERIODS]
    const prefilled = prefill?.periodSeconds
    if (prefilled !== undefined && !list.some((p) => p.seconds === prefilled)) {
      list.push({ label: `every ${prefilled}s`, seconds: prefilled })
    }
    return list
  }, [prefill])

  const tokenCfg = useMemo(
    () => tokens.find((t) => t.address.toLowerCase() === token.toLowerCase()) ?? tokens[0],
    [token, tokens],
  )
  const recipientValid = recipient.trim() === '' || isAddress(recipient.trim())
  const amountValid = amount.trim() !== '' && Number(amount) > 0

  // The grant INPUT is this card's business; performing the grant — and
  // telling a cancelled signature apart from a failed one — belongs to the
  // shared BudgetGrantAction, so the modal and this card behave identically
  // (#1073). Null while the form is incomplete, which disables the control.
  const grantInput = useMemo<GrantInput | null>(() => {
    if (!tokenCfg || !amountValid || !recipientValid) return null
    let budgetAtomic: string
    try {
      budgetAtomic = parseUnits(amount, tokenCfg.decimals).toString()
    } catch {
      return null
    }
    return {
      tokenAddress: tokenCfg.address as Address,
      recipientAddress: recipient.trim() ? (recipient.trim() as Address) : null,
      budgetAtomic,
      periodSeconds: period,
    }
  }, [amount, amountValid, period, recipient, recipientValid, tokenCfg])

  const handleGranted = useCallback(() => {
    setAmount('')
    setRecipient('')
    pendingFocus.current = 'add'
    setFormOpen(false)
    toast.success('Budget set — it refills itself every period.')
    onBudgetChange?.()
  }, [onBudgetChange, toast])

  const handleRevoke = useCallback(
    async (hash: string) => {
      const result = await revoke(hash)
      if (result.ok) {
        toast.success('Budget stopped.')
        onBudgetChange?.()
      } else if (result.reason === 'cancelled') {
        // #1085: a dismissed sheet is a decision, not a failure — neutral
        // tone, matching BudgetGrantAction's inline treatment.
        toast.info('Signature was cancelled.')
      }
      else toast.error('Could not stop the budget. Try again.')
    },
    [onBudgetChange, revoke, toast],
  )

  // #2473: never render NOTHING while loading — an empty section reads as a
  // page that failed. The skeleton also reserves roughly the shape the loaded
  // card takes, so arrival is not a layout jump.
  if (budgets === null && !budgetsError) {
    return (
      <section className="mt-6">
        <SpendingHeading retired={retired} />
        <Card hover={false} className="p-5 md:p-6">
          <div className="py-3"><Skeleton className="h-5 w-48" /></div>
          {/* #3549: no form-shaped placeholder for a card that will have no form. */}
          {retired ? null : (
            <div className="mt-4 space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
        </Card>
      </section>
    )
  }

  // A failed fetch keeps the card and its form (#2473 design review): the same
  // shape `signersError` already uses below, rather than collapsing the whole
  // card and taking the grant form with it.
  // #3802: the row list keeps every bookkeeping-`active` row (an expired one
  // renders its own "expired" line — #3695), but `hasActive` — the grant-form
  // gate — is the owner predicate: active AND unexpired. Nothing flips the
  // row's status when `expires_at` passes, so gating on status alone would
  // keep the form hidden behind "Add budget" forever for an agent whose only
  // budget expired.
  const active = (budgets ?? []).filter((b) => b.status === 'active')
  const nowSec = Math.floor(Date.now() / 1000)
  const hasActive = active.some((b) => b.expires_at > nowSec)
  // #3506: a sub-budget is carved from a LIVE budget — the entry point, now
  // inside the Add budget panel below (#3716), exists only when this agent
  // has an active, unexpired one (the card itself renders only on the
  // delegation rail). The modal offers a picker when several qualify.
  const subBudgetParents = retired ? [] : eligibleSubBudgetParents(budgets, Math.floor(Date.now() / 1000))

  // #3695: with no active budget the grant form IS the section's content;
  // with one, it waits behind "Add budget" unless opened (or `?grant=` opened
  // it). A failed list read counts as "no active budget" here, so the form —
  // gated below on knowing the current budgets — stays reachable. #3802:
  // "active" here is the owner predicate (see above) — an expired-only row
  // counts as no active budget, so the form shows.
  const showForm = !hasActive || formOpen

  return (
    <section className="mt-6">
      <SpendingHeading retired={retired} />
      <Card hover={false} className="p-5 md:p-6">

      {/* A failed signer-set fetch must be retryable (#1079) — without it the
          card is stranded at ready=false with no way out. */}
      {signersError ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3">
          <p className="text-sm text-[var(--v2-ink-2)]">
            Haven could not load how this account is approved.
          </p>
          <Button size="sm" variant="ghost" onClick={() => void reloadSigners()}>
            Try again
          </Button>
        </div>
      ) : null}

      <div className="divide-y divide-[var(--v2-border)]">
        {budgetsError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <p className="text-sm text-[var(--v2-ink-2)]">
              Haven could not load this agent&rsquo;s current budgets.
            </p>
            <Button size="sm" variant="ghost" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        ) : active.length === 0 ? (
          retired ? (
            <p className="py-3 text-sm text-[var(--v2-ink-muted)]">No active budget.</p>
          ) : null
        ) : (
          active.map((b) => (
            <BudgetRow
              key={b.delegation_hash}
              budget={b}
              tokens={tokens}
              agentName={agentName}
              openTaskBudgets={openTaskBudgets}
              onRevoke={handleRevoke}
              onEdit={retired ? undefined : setEditing}
              busy={busy}
              ready={ready}
            />
          ))
        )}
      </div>

      {/* #3549: the reason is shown only beside something to stop — with no
          active budget, "No active budget." above already says it all and
          the page's own empty state explains the retired agent. */}
      {retired ? (
        active.length > 0 && !budgetsError ? (
          <p className="mt-4 text-sm text-[var(--v2-ink-muted)]">
            {retired === 'revoked'
              ? 'This agent has been revoked, so its budgets can only be stopped.'
              : 'This agent has been removed, so its budgets can only be stopped.'}
          </p>
        ) : null
      ) : tokens.length > 0 && !showForm ? (
        <div className="mt-3">
          <Button ref={addBudgetRef} size="sm" variant="ghost" onClick={openForm}>
            Add budget
          </Button>
        </div>
      ) : tokens.length > 0 ? (
        <div className={hasActive ? 'mt-4 space-y-2' : 'space-y-2'}>
          {hasActive ? (
            <p className="text-sm font-medium text-[var(--v2-ink)]">Add a budget</p>
          ) : (
            <div className="pb-1">
              <p className="text-sm font-medium text-[var(--v2-ink)]">
                {budgetsError ? 'Set a budget' : 'Set its first budget'}
              </p>
              <p className="mt-0.5 text-sm text-[var(--v2-ink-muted)]">
                The agent can start paying within it.
              </p>
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              ref={amountRef}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount"
              className="sm:w-32"
              aria-label="Budget amount"
            />
            {tokens.length > 1 ? (
              <Select value={token} onChange={(e) => setToken(e.target.value)} aria-label="Token" className="sm:w-28">
                {tokens.map((t) => (
                  <option key={t.address} value={t.address}>{t.symbol}</option>
                ))}
              </Select>
            ) : (
              <span className="self-center text-sm text-[var(--v2-ink-muted)]">{tokenCfg?.symbol}</span>
            )}
            <Select value={String(period)} onChange={(e) => setPeriod(Number(e.target.value))} aria-label="Period" className="sm:w-36">
              {periodOptions.map((p) => (
                <option key={p.seconds} value={p.seconds}>{p.label}</option>
              ))}
            </Select>
          </div>
          <Input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Recipient address"
            helperText="Optional — leave blank for any recipient."
            className="font-mono"
            aria-label="Recipient"
          />
          {/* #2473 (money-path review): a grant REPLACES the active budget in
              the same (token, recipient) slot, server-side and silently. In
              the normal state the rows above the form are what let an owner
              see that coming; when the list failed to load they cannot, so
              the action is gated on knowing the current budgets rather than
              on the owner reading a warning. `Try again` is the way out. */}
          <BudgetGrantAction
            grant={grant}
            busy={busy}
            ready={ready}
            input={budgetsError ? null : grantInput}
            label="Set budget"
            busyLabel="Setting…"
            helper={
              budgetsError
                ? 'Reload the current budgets before setting one — a new budget replaces the one it matches.'
                : 'One signature. Refills every period automatically.'
            }
            onGranted={handleGranted}
            // With a budget already listed, the opened form is a disclosure:
            // Cancel sits in the submit row, beside the action it cancels
            // (#3695 design review).
            trailingAction={
              hasActive ? (
                <Button variant="ghost" onClick={collapseForm}>
                  Cancel
                </Button>
              ) : undefined
            }
          />
          {/* #3716: sharing a slice of an EXISTING budget with another agent
              is a different thing from giving this agent more spending
              power, so it sits below the form — under Set budget and Cancel
              — and reads as another action, never an option of the form. It
              shows only while the panel is open (this block), keeping the
              #3506 gate: eligible parents (active, unexpired,
              not merchant-pinned) and no failed budgets read (the real hook
              nulls `budgets` on error, so `subBudgetParents` is empty
              there). */}
          {subBudgetParents.length > 0 && !budgetsError ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[var(--v2-ink-muted)]">
                Or share part of an existing budget with another agent
              </p>
              <Button variant="tertiary" onClick={openSubBudget}>
                Issue sub-budget
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-sm text-[var(--v2-ink-muted)]">
          Budgets aren&rsquo;t available for this network yet.
        </p>
      )}

      {/* #3329: task budgets are a separate, self-closing authority carved
          from a budget above — listed here only when at least one is open,
          never as an empty section, and AFTER the grant form so "Set budget"
          never reads as part of this section (design review). */}
      {openTaskBudgets.length > 0 ? (
        <Card.Section divided className="mt-4">
          <div className="py-2">
            <p className="text-sm font-medium text-[var(--v2-ink)]">Task budgets</p>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-muted)]">
              Short spending limits your agent opened for a single task, taken from the budget above. Each ends by
              itself; stopping the budget above stops them too.
            </p>
          </div>
          {openTaskBudgets.map((t) => (
            <TaskBudgetRow key={t.id} taskBudget={t} tokens={tokens} />
          ))}
        </Card.Section>
      ) : null}

      {/* #3330: sub-budget trees — slices of a budget above re-delegated to
          ANOTHER agent in this account. Listed here only when at least one
          tree exists, never as an empty section, AFTER the task-budget
          section so the two carve-outs read narrowest-first. The chain is
          the enforcement: stopping the budget above strands every row here
          (stated in the copy, not implied). */}
      {subBudgetTrees && subBudgetTrees.length > 0 ? (
        <Card.Section divided className="mt-4">
          <div className="py-2">
            <p className="text-sm font-medium text-[var(--v2-ink)]">Sub-agent budgets</p>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-muted)]">
              Slices of the budget above that another of your agents spends through. Each stays inside the slice and
              inside the budget above it; stopping the budget above stops them too.
            </p>
          </div>
          {subBudgetTrees.map((tree) => (
            <SubBudgetTreeRow key={tree.parent_child_sub_budget.id} tree={tree} tokens={tokens} />
          ))}
        </Card.Section>
      ) : null}

      {subBudgetParents.length > 0 && issuingSubBudget ? (
        <IssueSubBudgetModal
          open
          onClose={() => setIssuingSubBudget(false)}
          agentId={agentId}
          budgets={subBudgetParents}
          tokens={tokens}
          onIssued={() => void reloadSubBudgets()}
        />
      ) : null}

      {/* #3166: edit-in-place for one active budget. Kept mounted here — the
          modal owns its own `enabled: open` hook instance, so idle cost is one
          closed portal. */}
      {editing && !retired ? (
        <EditBudgetModal
          open={editing !== null}
          onClose={handleEditClosed}
          agentId={agentId}
          chainId={chainId}
          tokens={tokens}
          budget={editing}
          onBudgetChange={onBudgetChange}
        />
      ) : null}
      </Card>
    </section>
  )
}

/**
 * The section's heading and one-line description, ABOVE its card — the
 * detail-page section rule (design-system.md, #3692).
 */
function SpendingHeading({ retired }: { retired?: 'revoked' | 'archived' }) {
  return (
    <div className="mb-3">
      <h2 className="v2-text-h3 text-[var(--v2-ink)]">Spending</h2>
      <p className="mt-0.5 text-sm text-[var(--v2-ink-muted)]">
        {retired
          ? 'What this agent can still spend each period.'
          : 'What this agent can spend each period. Budgets are enforced on-chain: a payment over budget is declined before any money moves.'}
      </p>
    </div>
  )
}

/**
 * The Stop confirm's spend phrase, from the row's own formatted values.
 * Known token, listed period: the owner's "1 USDC/day" slash form. Anything
 * else falls back to the row's own label without the slash — "1 USDC every
 * 3600s", or "5 per day" when the token is unknown.
 */
function spendPhrase(amount: string | bigint, t: TokenOption | undefined, periodLabel: string): string {
  const noun = t ? periodNounFromLabel(periodLabel) : null
  if (t && noun) return `${amount} ${t.symbol}/${noun}`
  if (t) return `${amount} ${t.symbol} ${periodLabel}`
  return `${amount} ${periodLabel}`.replace(/\s+/g, ' ')
}

function periodNounFromLabel(label: string): string | null {
  switch (label) {
    case 'per day':
      return 'day'
    case 'per week':
      return 'week'
    case 'per month':
      return 'month'
    default:
      return null
  }
}

function BudgetRow({
  budget,
  tokens,
  agentName,
  openTaskBudgets,
  onRevoke,
  onEdit,
  busy,
  ready,
}: {
  budget: DelegationBudget
  tokens: TokenOption[]
  /** #3717: the agent's display name, for the confirm's body. */
  agentName: string
  /** Open, unexpired task budgets across the agent (#3329) — filtered to this row's parent below. */
  openTaskBudgets: TaskBudget[]
  onRevoke: (hash: string) => void | Promise<void>
  /** Opens the edit-in-place flow (#3166) for THIS row; absent on a retired agent (#3549). */
  onEdit?: (budget: DelegationBudget) => void
  busy: boolean
  ready: boolean
}) {
  const t = tokens.find((x) => x.address.toLowerCase() === budget.token_address.toLowerCase())
  const amount = t ? formatUnits(BigInt(budget.budget_atomic), t.decimals) : budget.budget_atomic
  const periodLabel =
    PERIODS.find((p) => p.seconds === budget.period_seconds)?.label ?? `every ${budget.period_seconds}s`

  // #3717: Stop ends an irreversible on-chain budget, so it explains itself
  // at the moment of action rather than asking for a signature cold. The
  // dialog stays up with `loading` while the owner signs and closes when the
  // flow resolves — success or cancelled signature, whichever the toast
  // reports (handleRevoke never throws: the hook returns a result).
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [signing, setSigning] = useState(false)

  async function handleConfirmStop() {
    setSigning(true)
    try {
      await onRevoke(budget.delegation_hash)
      setConfirmOpen(false)
    } finally {
      setSigning(false)
    }
  }

  // #3329: the sum of open, unexpired task budgets carved from THIS budget —
  // matched by parent delegation hash, never rendered when the sum is zero.
  const reservedAtomic = openTaskBudgets
    .filter((tb) => tb.parent_delegation_hash === budget.delegation_hash)
    .reduce((sum, tb) => sum + BigInt(tb.max_atomic), 0n)
  const reservedDisplay = t ? formatUnits(reservedAtomic, t.decimals) : reservedAtomic.toString()

  const usage = budgetUsage(budget, t)

  return (
    <div className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--v2-ink)]">
          {amount} {t?.symbol ?? ''} {periodLabel}
        </p>
        <p className="truncate text-xs text-[var(--v2-ink-muted)]">
          {/* #3331: a merchant-locked budget names the merchant it pays,
              rather than only the address it happens to be pinned to. */}
          {budget.merchant_name
            ? `pays ${budget.merchant_name} only`
            : budget.recipient_address
              ? `to ${truncateAddress(budget.recipient_address)}`
              : 'to any recipient'}
        </p>
        {reservedAtomic > 0n ? (
          <p className="text-xs text-[var(--v2-ink-3)]">
            {reservedDisplay} {t?.symbol ?? ''} reserved for task budgets
          </p>
        ) : null}
        {usage.kind === 'meter' ? (
          <div className="mt-2 max-w-sm">
            <BudgetMeter usedPercent={usage.usedPercent} label={usage.label} caption={usage.caption} />
          </div>
        ) : usage.kind === 'expired' ? (
          <p className="mt-2 text-xs text-[var(--v2-ink-3)]">This budget has expired and can no longer be spent.</p>
        ) : usage.kind === 'unread' ? (
          <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
            Usage this period couldn&rsquo;t be read from the chain.
          </p>
        ) : null}
      </div>
      {/* #3166: Edit changes this budget's limits in place — same slot, same
          agent key, new owner-signed delegation. It is hidden while a
          lifecycle action is busy, exactly like Stop, and requires a
          reachable signer like every affordance that asks for one. */}
      <div className="flex shrink-0 items-center gap-1">
        {onEdit ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onEdit(budget)}
            disabled={busy || !ready}
            aria-label={`Edit budget ${amount} ${t?.symbol ?? ''} ${periodLabel}`.replace(/\s+/g, ' ')}
          >
            Edit
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirmOpen(true)}
          disabled={busy || !ready}
          aria-label={`Stop budget ${amount} ${t?.symbol ?? ''} ${periodLabel}`.replace(/\s+/g, ' ')}
        >
          Stop budget
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => handleConfirmStop()}
        title="Stop this budget?"
        confirmLabel="Stop budget"
        loading={signing}
        // Same gate as the row button: no confirm while a lifecycle action is
        // in flight or no reachable signer.
        confirmDisabled={busy || !ready}
        body={
          <p>
            {agentName} can no longer spend from this {spendPhrase(amount, t, periodLabel)} budget. This can&rsquo;t be
            undone, but you can set a new budget for the agent at any time.
          </p>
        }
      />
    </div>
  )
}

type BudgetUsage =
  | { kind: 'none' }
  | { kind: 'unread' }
  | { kind: 'expired' }
  | { kind: 'meter'; usedPercent: number; label: string; caption: string }

/**
 * How much of this period a budget has used (#3695), from the read's
 * remaining-this-period (#3693).
 *
 * - No figure on the row (not asked for, or not an active row): nothing.
 * - `remaining_from_chain: false`: the chain read failed and `remaining_atomic`
 *   is the full budget, NOT a measurement — so no meter (it would claim
 *   "0 used") and no "snapshot" wording (it is not one either).
 * - Otherwise: used = budget − remaining, with the next refill — or the
 *   expiry, when the budget ends before its period does.
 */
function budgetUsage(budget: DelegationBudget, t: TokenOption | undefined): BudgetUsage {
  // An `active` row can outlive its `expires_at` — nothing flips the status
  // (`eligibleSubBudgetParents` filters on expiry for the same reason). Such a
  // budget can no longer spend, so it gets no "used this period" meter and no
  // "expires in …" countdown (#3695 review).
  if (budget.expires_at * 1000 <= Date.now()) return { kind: 'expired' }
  if (budget.remaining_atomic == null || budget.remaining_from_chain == null) return { kind: 'none' }
  if (budget.remaining_from_chain === false) return { kind: 'unread' }
  let total: bigint
  let remaining: bigint
  try {
    total = BigInt(budget.budget_atomic)
    remaining = BigInt(budget.remaining_atomic)
  } catch {
    return { kind: 'none' }
  }
  const used = total > remaining ? total - remaining : 0n
  const usedPercent = total > 0n ? Number((used * 10_000n) / total) / 100 : 0
  const symbol = t?.symbol ?? ''
  const fmt = (v: bigint) => (t ? formatUnits(v, t.decimals) : v.toString())
  const nowMs = Date.now()
  const expiresMs = budget.expires_at * 1000
  const refillMs = budget.period_end ? nextRefillMs(budget.period_end, budget.period_seconds, nowMs) : null
  const when =
    refillMs === null
      ? null
      : expiresMs < refillMs
        ? `expires ${inDuration(expiresMs, nowMs)}`
        : `refills ${inDuration(refillMs, nowMs)}`
  const usedLine = `${fmt(used)} of ${fmt(total)} ${symbol} used this period`.replace(/\s+/g, ' ').trim()
  return {
    kind: 'meter',
    usedPercent,
    label: `${symbol} budget used`.trim(),
    caption: when ? `${usedLine} · ${when}` : usedLine,
  }
}

/**
 * One open, unexpired task budget (#3329) — the self-closing authority
 * carved from a period budget above. Reuses the `Row` primitive rather than
 * a bespoke layout, since this is now the second row-of-a-list shape in this
 * file (the period-budget rows predate `Row` and are left as-is — converting
 * them is out of scope here).
 */
function TaskBudgetRow({ taskBudget, tokens }: { taskBudget: TaskBudget; tokens: TokenOption[] }) {
  const t = tokens.find((x) => x.address.toLowerCase() === taskBudget.token_address.toLowerCase())
  const max = t ? formatUnits(BigInt(taskBudget.max_atomic), t.decimals) : taskBudget.max_atomic
  const parts = [`up to ${max} ${t?.symbol ?? ''}`.trim(), `ends ${timeUntil(taskBudget.expires_at * 1000)}`]
  if (taskBudget.recipient_address) parts.push(`to ${truncateAddress(taskBudget.recipient_address)}`)
  // `density="flush"` (Row.tsx's own #3204 note: an appended padding class
  // cannot beat the primitive's, so vertical rhythm is restored on this
  // wrapper instead) — aligns the row flush against the card edge, matching
  // the period-budget rows above it.
  return (
    <div className="py-3">
      <Row density="flush" title={taskBudget.label || 'Task budget'} subtitle={parts.join(' · ')} />
    </div>
  )
}

/**
 * One sub-budget tree (#3330): the parent agent's own narrowing row with the
 * grants to sub-agents nested under it. Reuses the `Row` primitive (the
 * third row-of-a-list shape in this file); the parent-child row and its
 * grants render as an indented pair so the tree reads without jargon.
 */
function SubBudgetTreeRow({ tree, tokens }: { tree: SubBudgetTree; tokens: TokenOption[] }) {
  const parent = tree.parent_child_sub_budget
  const t = tokens.find((x) => x.address.toLowerCase() === parent.token_address.toLowerCase())
  const amount = t ? formatUnits(BigInt(parent.period_amount_atomic), t.decimals) : parent.period_amount_atomic
  const nowSec = Math.floor(Date.now() / 1000)
  const parentParts = [
    `${amount} ${t?.symbol ?? ''}`.trim(),
    parent.expires_at > nowSec ? `ends ${timeUntil(parent.expires_at * 1000)}` : 'ended',
  ]
  if (parent.recipient_address) parentParts.push(`to ${truncateAddress(parent.recipient_address)}`)
  if (parent.status === 'pending') parentParts.push('waiting for signature')
  return (
    <div className="py-3">
      <Row density="flush" title={parent.label || 'Sub-agent budget'} subtitle={parentParts.join(' · ')} />
      {tree.grants.length > 0 ? (
        <div className="ml-4 border-l border-[var(--v2-border)] pl-3">
          {tree.grants.map((g) => (
            <SubBudgetGrantRow key={g.id} grant={g} tokens={tokens} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** One grant to a sub-agent (#3330) — the leaf of a sub-budget tree. */
function SubBudgetGrantRow({ grant, tokens }: { grant: SubBudgetTree['grants'][number]; tokens: TokenOption[] }) {
  const t = tokens.find((x) => x.address.toLowerCase() === grant.token_address.toLowerCase())
  const amount = t ? formatUnits(BigInt(grant.period_amount_atomic), t.decimals) : grant.period_amount_atomic
  const nowSec = Math.floor(Date.now() / 1000)
  const parts = [
    `up to ${amount} ${t?.symbol ?? ''}`.trim(),
    grant.expires_at > nowSec ? `ends ${timeUntil(grant.expires_at * 1000)}` : 'ended',
  ]
  // #3506: a freshly issued slice is pending until the sharing agent signs.
  if (grant.status === 'pending') parts.push('waiting for signature')
  if (grant.recipient_address) parts.push(`to ${truncateAddress(grant.recipient_address)}`)
  return (
    <div className="py-2">
      <Row density="flush" title={grant.label || 'Sub-agent slice'} subtitle={parts.join(' · ')} />
    </div>
  )
}
