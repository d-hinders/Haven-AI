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

import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { EllipsisVertical } from 'lucide-react'
import { Icon } from './ui/Icon'
import { isAddress, parseUnits, formatUnits } from 'viem'
import type { Address } from 'viem'
import { useDelegationBudget, type DelegationBudget, type GrantInput, type GrantResult } from '@/hooks/useDelegationBudget'
import { findOccupyingBudget, occupiesSlot, replacedButEnabledBudgets, slotOccupantHashesForEdit } from '@/lib/budget-slot'
import { useTaskBudgets, type TaskBudget } from '@/hooks/useTaskBudgets'
import { useReceivedSubBudgets, useSubBudgetTrees, type ReceivedSubBudgetGrant, type SubBudgetTree } from '@/hooks/useSubBudgets'
import BudgetGrantAction from './BudgetGrantAction'
import WalletConnectAction from './WalletConnectAction'
import PasskeyElsewhereHint from './PasskeyElsewhereHint'
import EditBudgetModal from './EditBudgetModal'
import IssueSubBudgetModal from './IssueSubBudgetModal'
import ConfirmDialog from './ConfirmDialog'
import { delegationIsLive, eligibleSubBudgetParents, subBudgetEndLabel } from '@/lib/sub-budget'
import { receivedGrantStatusNote } from '@/lib/agent-budget'
import { agentMerchantLabel } from '@/lib/agent-merchant-label'
import { AGENT_PAUSED_SHORT } from '@/lib/agent-pause-copy'
import { usePreferences } from '@/hooks/usePreferences'
import { Card } from './ui/Card'
import { Skeleton } from './ui/Skeleton'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { Row } from './ui/Row'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/DropdownMenu'
import { useToast } from './ui/Toast'
import { Amount, type AmountCurrency } from '@/components/haven/Amount'
import { BudgetEndDateSelect, BudgetMeter, NoticeRow, truncateAddress } from '@/components/haven'
import { timeAgo, timeUntil } from '@/lib/format'
import { budgetCaption, budgetPeriodWords, budgetReservedNote, type BudgetCaption } from '@/lib/budget-caption'
import { BUDGET_END_DEFAULT_DAYS, budgetEndsAt, formatBudgetEndDate } from '@/lib/budget-end'
import type { DashboardAgentStats } from '@/types/dashboard'

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
  /**
   * #4226: the agent's status as the page sees it. `paused` greys the meters
   * and adds the shared pause line under each caption (as the dashboard row
   * does) — the caption itself is unchanged.
   */
  agentStatus?: string
  /**
   * #4226: the dashboard overview's per-agent stats block — the Last 30 days
   * column's spent figure, payment count and last-paid line (the same source
   * #4209's card footer reads, read the way the account page reads the
   * overview). Absent/null — an agent the overview does not cover, a revoked
   * one among them — renders no column.
   */
  stats?: DashboardAgentStats | null
  /**
   * #4226: the overview read is still in flight. A skeleton column reserves
   * the shape so arrival is not a layout jump; with `stats` present this is
   * ignored.
   */
  statsLoading?: boolean
}

/**
 * Stable anchor for the card so budget affordances elsewhere on the agent
 * page can scroll to it instead of opening the legacy editor (#1079).
 */
export const DELEGATION_BUDGET_CARD_ID = 'delegation-budget-card'

// The period picker offers the day/week/month rhythm (#3806: the words are
// the caption helper's — a prefilled build may carry any period the CLI chose
// (an hour, a minute-floor of 60s), so the prefilled value gets its own
// option instead of silently desyncing the Select from the state it shows).
const PERIODS = [86_400, 604_800, 2_592_000] as const

export default function DelegationBudgetCard({
  agentId,
  chainId,
  tokens,
  agentName,
  onBudgetChange,
  retired,
  agentStatus,
  stats,
  statsLoading,
}: Props) {
  const { currency } = usePreferences()
  // #4226: `paused` greys the meters and adds the shared pause line under
  // each caption. Keyed on the status STRING, never on "not active" — a
  // pending_approval agent is not paused, and a retired agent comes through
  // `retired` with its own copy.
  const isPaused = agentStatus === 'paused'
  // #3695: this card is the one caller that asks for remaining-this-period —
  // the meter on each row is drawn from it.
  const { budgets, grant, editBudget, revoke, busy, ready, budgetsError, reload, signersError, reloadSigners, signersLoading, passkeyElsewhere } =
    useDelegationBudget(agentId, chainId, { includeRemaining: true })
  // #3812: `ready` is false for three different reasons. A failed signer-set
  // read has its own Try again below, and a pending read is not an answer yet;
  // only the remaining case — the set is known and nobody here can sign — is
  // fixed by connecting the owner wallet, so only it offers that way out.
  const needsOwnerWallet = !ready && !signersError && !signersLoading
  // #3329: read separately from the period budgets above — a failed fetch
  // here must never take the budgets list down with it, so `taskBudgets`
  // stays `null` (nothing rendered) rather than surfacing its own error UI.
  const { taskBudgets } = useTaskBudgets(agentId)
  // #3330: the parent→child sub-budget trees this agent ISSUES, read the
  // same defensive way — `trees` stays `null` (nothing rendered) on failure.
  const { trees: subBudgetTrees, reload: reloadSubBudgets } = useSubBudgetTrees(agentId)
  // #3988: the grants this agent RECEIVES — the holder's side of the same
  // table, the same defensive read. A holder with no budget of its own must
  // not read as if it cannot pay.
  const { grants: receivedGrants } = useReceivedSubBudgets(agentId)
  // #3506: the issue-sub-budget modal's open flag.
  const [issuingSubBudget, setIssuingSubBudget] = useState(false)
  // #3922: `is_live` is the server's answer (pending/open/closing and not
  // expired); an OPEN live row is the open, unexpired set this card lists.
  const openTaskBudgets = useMemo(
    () => (taskBudgets ?? []).filter((t) => t.status === 'open' && (t.is_live ?? !t.is_expired)),
    [taskBudgets],
  )
  const { toast } = useToast()
  // #3166: the ACTIVE budget whose limits are being edited in place, and the
  // modal's open flag — one state so closing the modal and clearing the
  // anchor cannot disagree.
  const [editing, setEditing] = useState<DelegationBudget | null>(null)
  // #3933: the limits typed into the Add budget form when its submit was
  // routed to the edit flow — the edit opens with them, not the current ones.
  const [editPrefill, setEditPrefill] = useState<{ budgetAtomic: string; periodSeconds: number } | null>(null)
  // #3933: a routed submit waiting for its budget to appear in the list (the
  // server's 409 names a hash the list may not have caught up with yet).
  const [pendingEdit, setPendingEdit] = useState<{
    hash: string | null
    slot: { tokenAddress: string; recipientAddress: string | null }
    prefill: { budgetAtomic: string; periodSeconds: number }
  } | null>(null)

  // #4154: the rows an edit flow owns while it settles. Between the edit's
  // two approvals the old row reads `replaced`, and a background poll can
  // show it here before the second approval has had its chance — so the
  // replaced-budget notice stands down for the rows that edit will Stop while
  // the modal is open (its own `revoke_unfinished` screen names them if the
  // Stop does not land). The set is the edit's Stop set SNAPSHOT when the
  // modal opens: those rows are still live then, and a `replaced` row already
  // in the slot (an earlier abandoned edit) is not in it and keeps its
  // notice. A FINISHED edit keeps the suppression only until a fresh reload
  // after close settles — the list held at close may predate the Stop. Any
  // other close shows the notice at once.
  const budgetsRef = useRef(budgets)
  budgetsRef.current = budgets
  const editingHashes = useMemo(
    () =>
      editing
        ? slotOccupantHashesForEdit(
            budgetsRef.current ?? [],
            editing.delegation_hash,
            { tokenAddress: editing.token_address, recipientAddress: editing.recipient_address },
            Math.floor(Date.now() / 1000),
          ).map((h) => h.toLowerCase())
        : null,
    [editing],
  )
  const editFinished = useRef(false)
  const [settlingHashes, setSettlingHashes] = useState<string[] | null>(null)

  const handleEditClosed = useCallback(() => {
    if (editFinished.current && editingHashes) {
      const hashes = editingHashes
      setSettlingHashes(hashes)
      void Promise.resolve(reload()).finally(() => setSettlingHashes((current) => (current === hashes ? null : current)))
    }
    editFinished.current = false
    setEditing(null)
    setEditPrefill(null)
  }, [editingHashes, reload])

  const [token, setToken] = useState(tokens[0]?.address ?? '')
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState(86_400)
  const [recipient, setRecipient] = useState('')
  // #4350: the end date the owner picks for a NEW budget — 30/90/180/365
  // days, 90 the default (owner decision 1 on #4349). Rides the build as
  // `expires_at`; the select renders the resulting date before anything is
  // signed.
  const [endDays, setEndDays] = useState(BUDGET_END_DEFAULT_DAYS)

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
  // #4353: "Budget ending"'s Renew links `?renew=<delegationHash>` — open
  // that live budget's Edit, prefilled with its own limits (the end date is
  // the field to change, #4350). Applied once, then the URL is tidied; an
  // unknown, foreign or no-longer-live hash opens nothing, like `?grant=`.
  const renewHash = useMemo(() => {
    if (typeof window === 'undefined') return null
    const r = new URLSearchParams(window.location.search).get('renew')
    return r && /^0x[0-9a-fA-F]{64}$/.test(r) ? r : null
  }, [])
  const renewApplied = useRef(false)
  // #3695: once a budget exists, the grant form is collapsed behind "Add
  // budget" — a permanent second form made "Set budget" the strongest element
  // on the page. With no active budget the form is the section's content and
  // this flag is not consulted. A `?grant=` prefill opens it (#2539): the
  // human must see the build they are about to sign.
  const [formOpen, setFormOpen] = useState(false)
  // #4261: the form's opener is a row's ⋯ menu item, so the collapse has to
  // know WHICH trigger to hand focus back to. The menu item records its row's
  // delegation hash here; a `?grant=` prefill (no menu) leaves it null.
  const formOriginRef = useRef<string | null>(null)
  const budgetCardRef = useRef<HTMLElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  // Opening and collapsing swap the pressed control for another, so focus
  // would fall to <body> (#3695 review). An owner-initiated toggle says where
  // focus goes next — the amount field on open, the originating ⋯ trigger on
  // collapse; the `?grant=` prefill opens without one, so a page load never
  // steals focus.
  const addBudgetRef = useRef<HTMLButtonElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const pendingFocus = useRef<'amount' | 'add' | null>(null)
  const openForm = useCallback(() => {
    pendingFocus.current = 'amount'
    setFormOpen(true)
  }, [])
  // #4261: the row menu's Add budget item — remembers which row opened the
  // form so the collapse can return to that row's trigger.
  const openFormFromRow = useCallback(
    (hash: string) => {
      formOriginRef.current = hash
      openForm()
    },
    [openForm],
  )
  const collapseForm = useCallback(() => {
    pendingFocus.current = 'add'
    setFormOpen(false)
  }, [])
  // Where collapse focus lands (#4261): the ⋯ trigger that opened the form —
  // resolved fresh, the list may have reloaded while it was up — else the
  // first row's trigger, else Set budget, else the section heading. A trigger
  // that is disabled (`busy`) cannot take focus, so the heading takes it
  // instead. It never lands on <body>.
  const focusAfterCollapse = useCallback(() => {
    const root = budgetCardRef.current
    const origin = formOriginRef.current
    const trigger =
      (origin
        ? root?.querySelector<HTMLButtonElement>(`[data-budget-trigger="${CSS.escape(origin)}"]`)
        : null) ??
      root?.querySelector<HTMLButtonElement>('[data-budget-trigger]') ??
      null
    if (trigger && !trigger.disabled) {
      trigger.focus()
      return
    }
    if (trigger && trigger.disabled) {
      headingRef.current?.focus()
      return
    }
    ;(addBudgetRef.current ?? headingRef.current)?.focus()
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
    if (target === 'amount') {
      amountRef.current?.focus()
      return
    }
    // #4261: collapse (Cancel or save) returns focus to the ⋯ trigger that
    // opened the form, via the chain in `focusAfterCollapse`.
    focusAfterCollapse()
  }, [formOpen, focusAfterCollapse])

  // #3716: when the modal closes, `formOpen` does not change, so the effect
  // above does not run — and `Modal` restores focus to the clicked entry
  // (ui/Modal.tsx), which the collapsed form has unmounted. Focus the form's
  // origin trigger explicitly, once per open→close cycle, through the same
  // chain a Cancel uses (#4261); the guard keeps the initial render (and a
  // close without a modal) from stealing focus.
  const wasIssuingSubBudget = useRef(false)
  useEffect(() => {
    if (issuingSubBudget) {
      wasIssuingSubBudget.current = true
    } else if (wasIssuingSubBudget.current) {
      wasIssuingSubBudget.current = false
      focusAfterCollapse()
    }
  }, [issuingSubBudget, focusAfterCollapse])

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
    // #4261: a prefill opens with no menu origin — the collapse falls back to
    // the first row's trigger (or Set budget) instead of a stale one.
    formOriginRef.current = null
    setFormOpen(true)
    try {
      window.history.replaceState(null, '', `/agents/${agentId}`)
    } catch {
      // A URL that stays untidy is not worth a thrown render.
    }
  }, [retired, grantHash, budgets, tokens, agentId, prefill])

  useEffect(() => {
    if (retired || !renewHash || budgets === null || renewApplied.current) return
    renewApplied.current = true
    const nowSec = Math.floor(Date.now() / 1000)
    const row = budgets.find(
      (b) => b.delegation_hash.toLowerCase() === renewHash.toLowerCase() && b.status === 'active' && occupiesSlot(b, nowSec),
    )
    if (row) setEditing(row)
    try {
      window.history.replaceState(null, '', `/agents/${agentId}`)
    } catch {
      // A URL that stays untidy is not worth a thrown render.
    }
  }, [retired, renewHash, budgets, agentId])

  // The period picker offers the day/week/month rhythm; a prefilled build may
  // carry any period the CLI chose (an hour, a minute-floor of 60s), so the
  // prefilled value gets its own option instead of silently desyncing the
  // Select from the state it shows.
  const periodOptions = useMemo(() => {
    const list: number[] = [...PERIODS]
    const prefilled = prefill?.periodSeconds
    if (prefilled !== undefined && !list.some((p) => p === prefilled)) {
      list.push(prefilled)
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
    // #4350: the chosen end date rides the build. The presets are always far
    // enough ahead that the conversion is never null on a sane clock.
    const expiresAt = budgetEndsAt(endDays, Math.floor(Date.now() / 1000))
    return {
      tokenAddress: tokenCfg.address as Address,
      recipientAddress: recipient.trim() ? (recipient.trim() as Address) : null,
      budgetAtomic,
      periodSeconds: period,
      ...(expiresAt !== null ? { expiresAt } : {}),
    }
  }, [amount, amountValid, endDays, period, recipient, recipientValid, tokenCfg])

  // #3933: a submit whose (token, recipient) slot already holds a live budget
  // is never signed as a plain grant — the backend refuses it, because the old
  // budget would stay enabled on-chain. It goes to the edit flow for that
  // budget instead, with the typed limits. The client-side check answers
  // before anything is built; when it misses (a stale list), the server's
  // `slot_occupied` takes the same route through `handleSlotOccupied`.
  const grantOrEdit = useCallback(
    async (input: GrantInput): Promise<GrantResult> => {
      const match = findOccupyingBudget(budgets, input, Math.floor(Date.now() / 1000))
      if (match) return { ok: false, reason: 'slot_occupied', existingDelegationHash: match.delegation_hash }
      return grant(input)
    },
    [budgets, grant],
  )

  const handleSlotOccupied = useCallback(
    (existingDelegationHash: string | null) => {
      if (!grantInput) return
      setPendingEdit({
        hash: existingDelegationHash,
        slot: { tokenAddress: grantInput.tokenAddress, recipientAddress: grantInput.recipientAddress ?? null },
        prefill: { budgetAtomic: grantInput.budgetAtomic, periodSeconds: grantInput.periodSeconds },
      })
    },
    [grantInput],
  )

  // Resolve a routed submit to its row once the list has it: by the hash the
  // check (or the server) named, else whatever live budget holds the slot.
  const pendingEditTarget = useMemo(() => {
    if (!pendingEdit || !budgets) return null
    const nowSec = Math.floor(Date.now() / 1000)
    const byHash = pendingEdit.hash
      ? budgets.find(
          (b) => b.delegation_hash.toLowerCase() === pendingEdit.hash!.toLowerCase() && occupiesSlot(b, nowSec),
        )
      : undefined
    return byHash ?? findOccupyingBudget(budgets, pendingEdit.slot, nowSec)
  }, [budgets, pendingEdit])

  useEffect(() => {
    if (!pendingEdit || !pendingEditTarget) return
    setEditPrefill(pendingEdit.prefill)
    setEditing(pendingEditTarget)
    setPendingEdit(null)
    // The edit carries the typed limits from here. Collapse the form like
    // Cancel does (typed values kept), and NOT through `pendingFocus`: the
    // modal that just opened owns focus (the #3716 note on `openSubBudget`).
    setFormOpen(false)
  }, [pendingEdit, pendingEditTarget])

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
        toast.info('Approval was cancelled.')
      }
      else toast.error('Could not stop the budget. Try again.')
    },
    [onBudgetChange, revoke, toast],
  )

  // #3933: the finish action for an old budget a replace left enabled — the
  // same per-hash revoke as Stop. "Already revoked" comes back as `ok` with
  // `alreadyStopped` (stopped out-of-band, or a revoke-all got there first):
  // finished, not an error.
  const handleFinishStop = useCallback(
    async (hash: string) => {
      const result = await revoke(hash)
      if (result.ok) {
        toast.success(result.alreadyStopped ? 'That old budget was already stopped.' : 'Old budget stopped.')
        onBudgetChange?.()
      } else if (result.reason === 'cancelled') {
        toast.info('Approval was cancelled.')
      } else {
        toast.error('Could not stop the old budget. Try again.')
      }
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
  const nowSec = Math.floor(Date.now() / 1000)
  const active = (budgets ?? []).filter((b) => b.status === 'active')
  // #3922: the owner predicate is the server's `is_live` (active AND unexpired).
  const hasActive = active.some((b) => delegationIsLive(b))
  // #3506: a sub-budget is carved from a LIVE budget — the entry point, now
  // inside the Add budget panel below (#3716), exists only when this agent
  // has an active, unexpired one (the card itself renders only on the
  // delegation rail). The modal offers a picker when several qualify.
  const subBudgetParents = retired ? [] : eligibleSubBudgetParents(budgets)
  // #3933: old budgets a replace retired in Haven but nobody stopped on-chain.
  // Row-level, from this list (every status) — never `live_delegation_count`.
  // A retired agent's "Finish revoking" (revoke-all) already covers them.
  // #4154: minus the rows an open edit flow owns, and those a just-finished
  // one owns until its reload settles — both, so reopening Edit inside that
  // window does not bring the flash back.
  const flowHashes = [...(editingHashes ?? []), ...(settlingHashes ?? [])]
  const stillEnabled = retired
    ? []
    : replacedButEnabledBudgets(budgets, nowSec).filter((b) => !flowHashes.includes(b.delegation_hash.toLowerCase()))
  // #3933: the live budget the form's current input would collide with — the
  // submit then opens the edit flow, and the hint says what that does.
  const formSlotMatch = grantInput && !budgetsError ? findOccupyingBudget(budgets, grantInput, nowSec) : null

  // #3695: with no active budget the grant form IS the section's content;
  // with one, it waits behind "Add budget" unless opened (or `?grant=` opened
  // it). A failed list read counts as "no active budget" here, so the form —
  // gated below on knowing the current budgets — stays reachable. #3802:
  // "active" here is the owner predicate (see above) — an expired-only row
  // counts as no active budget, so the form shows.
  // #4226: both entry states are now COLLAPSED — budgets listed show "Add
  // budget" at the foot; none shows "No budget yet." with Set budget — and
  // the form opens on either (or on a `?grant=` prefill), per mockup v2.
  // A FAILED read is the exception (#2473's contract): an unknown list must
  // never read as "you have no budget", so the form stays open exactly as it
  // did when it was the section's content.
  const showForm = formOpen || Boolean(budgetsError)

  return (
    <section ref={budgetCardRef} className="mt-6">
      <SpendingHeading retired={retired} headingRef={headingRef} />
      {/* #4226: the dashboard money-card pattern (design-system.md, #3897) —
          budgets on the left, Last 30 days on the right as a divided section,
          stacked below `lg`. The card itself carries no padding: the halves
          own it, so the right hairline runs edge-to-edge at `lg`. */}
      <Card hover={false} className="overflow-hidden">
        <div className="grid lg:grid-cols-2">
          <section aria-label="Budgets" className="min-w-0 p-5 sm:p-6">

      {/* A failed signer-set fetch must be retryable (#1079) — without it the
          card is stranded at ready=false with no way out. */}
      {signersError ? (
        <NoticeRow
          className="mb-4"
          action={
            <Button size="sm" variant="ghost" onClick={() => void reloadSigners()}>
              Try again
            </Button>
          }
        >
          Haven could not load how this account is approved.
        </NoticeRow>
      ) : null}

      {needsOwnerWallet && hasActive && !showForm && !retired ? (
        // #3812: Stop and Edit on the rows below are disabled while nobody on
        // this device can sign. Say why, and offer the way out here — the
        // header was the only place to connect a wallet before.
        <NoticeRow className="mb-4" action={<WalletConnectAction />}>
          Connect your account owner wallet to change or stop a budget.
        </NoticeRow>
      ) : null}

      {/* #3825: one heads-up for every signature this card asks for — Stop,
          Edit and the grant form below — now that the wallet menu that
          disclosed the fallback passkey has left the top bar. */}
      {ready && passkeyElsewhere && (!retired || (active.length > 0 && !budgetsError)) ? (
        // A retired card asks for a signature only to Stop a live budget.
        <PasskeyElsewhereHint className="mb-4" />
      ) : null}

      {stillEnabled.length > 0 && !budgetsError ? (
        <div className="mb-4 space-y-2">
          {stillEnabled.map((b) => (
            <ReplacedBudgetNotice
              key={b.delegation_hash}
              budget={b}
              tokens={tokens}
              onStop={handleFinishStop}
              busy={busy}
              ready={ready}
              needsOwnerWallet={needsOwnerWallet}
            />
          ))}
        </div>
      ) : null}

      {pendingEdit && !pendingEditTarget && budgets !== null ? (
        // #3933: the server refused the grant (the slot holds a live budget)
        // but the list does not show that budget yet. Never the generic
        // failure: say what happened and offer the refresh that finds it.
        <NoticeRow
          className="mb-4"
          action={
            <Button size="sm" variant="ghost" onClick={() => void reload()}>
              Reload budgets
            </Button>
          }
        >
          This agent already has a live budget for this token and recipient. Nothing was approved. Edit that
          budget to change its limits.
        </NoticeRow>
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
              chainId={chainId}
              openTaskBudgets={openTaskBudgets}
              paused={isPaused}
              onRevoke={handleRevoke}
              onEdit={retired ? undefined : setEditing}
              onAdd={!retired && hasActive && tokens.length > 0 && !showForm ? openFormFromRow : undefined}
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
        !hasActive ? (
          // #4226: needs setup — "No budget yet." with Set budget (mockup
          // v2). The form opens on the button, or expanded straight away on
          // a `?grant=` prefill; the received-grants nuance lives on the
          // form's own line when it opens. #4261: with an active budget
          // there is NO control here — Add budget is the rows' ⋯ menu item.
          <div className="mt-3">
            <p className="text-sm text-[var(--v2-ink-muted)]">No budget yet.</p>
            <Button
              ref={addBudgetRef}
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => {
                formOriginRef.current = null
                openForm()
              }}
            >
              Set budget
            </Button>
          </div>
        ) : null
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
                {/* #3988: a grant holder CAN pay — through the received
                    budgets listed below. The line must never imply it
                    cannot. */}
                {receivedGrants && receivedGrants.length > 0
                  ? 'It spends through the received budgets below; a budget of its own adds to that.'
                  : 'The agent can start paying within it.'}
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
                <option key={p} value={p}>{budgetPeriodWords(p)}</option>
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
          {/* #4350: the end date is a choice, shown with its resulting day —
              the same control the connect flow's approval step and the edit
              modal use, so all three surfaces cannot drift. */}
          <BudgetEndDateSelect
            id="grant-budget-end"
            days={endDays}
            onDaysChange={(d) => setEndDays(d ?? BUDGET_END_DEFAULT_DAYS)}
            nowSec={nowSec}
          />
          {/* #2473 (money-path review): a grant REPLACES the active budget in
              the same (token, recipient) slot, server-side and silently. In
              the normal state the rows above the form are what let an owner
              see that coming; when the list failed to load they cannot, so
              the action is gated on knowing the current budgets rather than
              on the owner reading a warning. `Try again` is the way out. */}
          <BudgetGrantAction
            grant={grantOrEdit}
            busy={busy}
            ready={ready}
            input={budgetsError ? null : grantInput}
            // #3933: a matching slot opens the edit flow, so the button says so.
            label={formSlotMatch ? 'Edit existing budget' : 'Set budget'}
            busyLabel="Setting…"
            // #3895: the agent page's verb is "set" — its failure sentence
            // keeps the exact wording the shared control used to hard-code.
            failureMessage="Haven could not set the budget. Nothing changed — try again."
            helper={
              budgetsError
                ? 'Reload the current budgets before setting one — a budget for a token and recipient that already has one is edited, not added.'
                : formSlotMatch
                  ? 'This agent already has a budget for this token and recipient, so you edit it: you approve the new budget, then approve once more to stop the old one. The review step shows how many approvals that takes. Stopping it ends any open task budget or sub-budget taken from it.'
                  : // #4350: the pre-sign copy names the chosen end date — the
                    // "One approval." line may never again hide when the
                    // budget ends (the issue's copy rule).
                    (() => {
                      const endsAt = budgetEndsAt(endDays, nowSec)
                      return endsAt != null
                        ? `One approval. Refills every period automatically until ${formatBudgetEndDate(endsAt)}.`
                        : 'One approval. Refills every period automatically.'
                    })()
            }
            onSlotOccupied={handleSlotOccupied}
            onGranted={handleGranted}
            notReadyHint={needsOwnerWallet ? 'Connect your account owner wallet to set a budget.' : undefined}
            notReadyAction={needsOwnerWallet ? <WalletConnectAction /> : undefined}
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
      {/* #3988: the grants this agent RECEIVES — the holder's side, read-only.
          Listed only when at least one exists, never as an empty section
          (the trees section's own rule). Closing a grant stays the
          delegator's action; nothing here mutates. */}
      {receivedGrants && receivedGrants.length > 0 ? (
        <Card.Section divided className="mt-4">
          <div className="py-2">
            <p className="text-sm font-medium text-[var(--v2-ink)]">Received budgets</p>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-muted)]">
              Slices of another agent&rsquo;s budget that this agent spends through. Each stays inside its
              slice and inside the budget it comes from; stopping the budget above stops them too.
            </p>
          </div>
          {receivedGrants.map((grant) => (
            <ReceivedBudgetGrantRow key={grant.id} grant={grant} tokens={tokens} />
          ))}
        </Card.Section>
      ) : null}

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

        </section>

        {/* #4226: the hero's right half — the Last 30 days from the
            dashboard overview's per-agent stats, the source #4209's card
            footer reads. Revoked and archived agents are not in the
            overview, so a retired card renders no column at all; their
            history is under Activity. */}
        {!retired && (stats || statsLoading) ? (
          <Card.Section divided className="min-w-0 lg:border-t-0 lg:border-l p-5 sm:p-6">
            {stats ? (
              <LastThirtyDays stats={stats} currency={currency} />
            ) : (
              <div role="status" aria-busy="true" aria-label="Loading the last 30 days">
                <Skeleton className="h-4 w-24" />
                {/* #4260: three label-and-value pairs, the shape of the figures —
                    #4400: in the loaded layout's two rows below `sm`. */}
                <div className="mt-2.5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className={`space-y-1.5${i === 0 ? ' col-span-2 sm:col-span-1' : ''}`}>
                      <Skeleton className="h-3 w-12" />
                      <Skeleton className="h-6 w-16" />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card.Section>
        ) : null}
      </div>

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
          prefill={editPrefill ?? undefined}
          // #3933: refresh this card's own list too — a partial edit leaves
          // the old budget `replaced`, and the notice above must show it.
          onBudgetChange={() => {
            void reload()
            onBudgetChange?.()
          }}
          onFinished={() => {
            editFinished.current = true
          }}
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
function SpendingHeading({
  retired,
  headingRef,
}: {
  retired?: 'revoked' | 'archived'
  /** #4261: the collapse-focus chain's last resort when every trigger is gone. */
  headingRef?: React.Ref<HTMLHeadingElement>
}) {
  return (
    <div className="mb-3">
      <h2 ref={headingRef} tabIndex={-1} className="v2-text-h3 text-[var(--v2-ink)] outline-none">
        Spending
      </h2>
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

/**
 * #3933: an old budget a replace retired in Haven (`replaced`, unexpired) that
 * has not been stopped on-chain — or not that Haven has seen: the status is
 * Haven's record, not a chain read, so the copy says what the record allows
 * ("can still be spent outside Haven until it is stopped") and nothing more.
 * The action is the card's per-hash Stop; a row already disabled on-chain
 * answers "Already revoked", which the hook reports as finished.
 */
function ReplacedBudgetNotice({
  budget,
  tokens,
  onStop,
  busy,
  ready,
  needsOwnerWallet,
}: {
  budget: DelegationBudget
  tokens: TokenOption[]
  onStop: (hash: string) => void | Promise<void>
  busy: boolean
  ready: boolean
  needsOwnerWallet: boolean
}) {
  const t = tokens.find((x) => x.address.toLowerCase() === budget.token_address.toLowerCase())
  let amount: string
  try {
    amount = t ? formatUnits(BigInt(budget.budget_atomic), t.decimals) : budget.budget_atomic
  } catch {
    amount = budget.budget_atomic
  }
  const phrase = `${amount} ${t?.symbol ?? ''} ${budgetPeriodWords(budget.period_seconds)}`.replace(/\s+/g, ' ')
  const scope = budget.merchant_name
    ? `that pays ${budget.merchant_name}`
    : budget.recipient_address
      ? `to ${truncateAddress(budget.recipient_address)}`
      : 'to any recipient'
  const [stopping, setStopping] = useState(false)

  async function handleStop() {
    setStopping(true)
    try {
      await onStop(budget.delegation_hash)
    } finally {
      setStopping(false)
    }
  }

  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-warning/30 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-ink)]"
    >
      <p className="font-medium">An old budget has not been stopped</p>
      <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
        The {phrase} budget {scope} was replaced, but it can still be spent outside Haven until it is stopped.
        Stopping it also ends any open task budget or sub-budget taken from it.
      </p>
      {needsOwnerWallet ? (
        <WalletConnectAction />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleStop()}
          disabled={busy || !ready || stopping}
          aria-label={`Stop old budget ${phrase}`}
        >
          {stopping ? 'Stopping…' : 'Stop old budget'}
        </Button>
      )}
    </div>
  )
}

// The ⋯ trigger class — the same quiet icon button the page header's menu
// uses, sized to the 44px tap-target overlay.
const MENU_TRIGGER_CLASS =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-hover)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:opacity-50'

function BudgetRow({
  budget,
  tokens,
  agentName,
  chainId,
  openTaskBudgets,
  paused,
  onRevoke,
  onEdit,
  onAdd,
  busy,
  ready,
}: {
  budget: DelegationBudget
  tokens: TokenOption[]
  /** #3717: the agent's display name, for the confirm's body. */
  agentName: string
  /** The agent's chain — resolves the token's decimals for the caption (#3806). */
  chainId: number
  /** Open, unexpired task budgets across the agent (#3329) — filtered to this row's parent below. */
  openTaskBudgets: TaskBudget[]
  /** #4226: the agent is paused — greyed meter and the shared pause line. */
  paused: boolean
  onRevoke: (hash: string) => void | Promise<void>
  /** Opens the edit-in-place flow (#3166) for THIS row; absent on a retired agent (#3549). */
  onEdit?: (budget: DelegationBudget) => void
  /**
   * #4261: opens the collapsed grant form, remembering this row as the form's
   * origin (its trigger takes the collapse focus). Present only when the old
   * Add budget button showed: an active budget, tokens on this network, the
   * form not already open, and not retired.
   */
  onAdd?: (hash: string) => void
  busy: boolean
  ready: boolean
}) {
  const t = tokens.find((x) => x.address.toLowerCase() === budget.token_address.toLowerCase())
  const amount = t ? formatUnits(BigInt(budget.budget_atomic), t.decimals) : budget.budget_atomic
  const periodLabel = budgetPeriodWords(budget.period_seconds)

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

  const usage = budgetCaptionFor(budget, chainId, t?.symbol ?? '', 'row')

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
            {budgetReservedNote(reservedAtomic.toString(), t?.symbol ?? '', { chainId })}
          </p>
        ) : null}
        {usage.kind === 'meter' ? (
          // #4226: the meter spans its column — the hero's money-card grid
          // already constrains the row, so the old `max-w-sm` is gone.
          <div className="mt-2">
            <BudgetMeter
              usedPercent={usage.usedPercent}
              label={usage.label}
              caption={usage.caption}
              tone={paused ? 'muted' : usage.usedPercent >= 90 ? 'warning' : 'brand'}
            />
          </div>
        ) : usage.kind === 'expired' || usage.kind === 'unknown' || usage.kind === 'refilled-updating' || usage.kind === 'not-started' ? (
          <p className="mt-2 text-xs text-[var(--v2-ink-3)]">{usage.caption}</p>
        ) : null}
        {/* #4226: paused — the shared short pause line UNDER the caption, the
            dashboard row's own placement (AgentRow); the caption text itself
            is unchanged. The line names the state the greyed meter implies. */}
        {paused ? <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{AGENT_PAUSED_SHORT}</p> : null}
      </div>
      {/* #4261: everything a row can do lives in its ⋯ menu — Edit budget,
          Add budget, then the irreversible Stop budget… behind its confirm.
          #3166: Edit changes this budget's limits in place — same slot, same
          agent key, new owner-signed delegation. The trigger is disabled only
          while a lifecycle action is busy; with no reachable signer the menu
          still opens — Stop is a disabled item there (it needs the signer),
          while Edit and Add open controls that explain how to connect. The
          data attribute is how the card finds a row's trigger for focus
          without a second ref on the React-19 trigger. */}
      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Budget options ${amount} ${t?.symbol ?? ''} ${periodLabel}`.replace(/\s+/g, ' ')}
            data-budget-trigger={budget.delegation_hash}
            disabled={busy}
            className={MENU_TRIGGER_CLASS}
          >
            <Icon icon={EllipsisVertical} className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="right">
            {onEdit ? (
              <DropdownMenuItem onSelect={() => onEdit(budget)}>Edit budget</DropdownMenuItem>
            ) : null}
            {onAdd ? (
              <DropdownMenuItem onSelect={() => onAdd(budget.delegation_hash)}>Add budget</DropdownMenuItem>
            ) : null}
            {onEdit || onAdd ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem tone="danger" disabled={!ready} onSelect={() => setConfirmOpen(true)}>
              Stop budget…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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

/**
 * The hero's right half (#4226): the agent's Last 30 days from the dashboard
 * overview's per-agent stats — #3803's NET figure in the user's display
 * currency (the same booked-or-repriced, sweep-netted number the dashboard's
 * money card and per-agent rows read, so the two surfaces cannot disagree —
 * #4274), the payment count, and the "Last paid …"
 * line with #4209's merchant label (name → x402 host → nothing, never an
 * address). All-time latest payment: `lastPaymentAt` is not windowed on the
 * wire, matching the card footer's read.
 *
 * Unpriced follows the dashboard's per-agent rows, not its headline: a
 * bucket the server could not price with net 0 renders "—" (`Amount
 * amount={null}`, #4274), but the hero carries no unpriced note — that note
 * is account-level, and the dashboard's per-agent rows have none either.
 *
 * #4260: three labelled figures across the column at the secondary-figure
 * size (20px, `Amount size="md"`), the dashboard money card's three-figure
 * row built by hand — `StatTile.value` is a `string` and cannot carry an
 * `Amount` (its "≈" and currency mode), and `StatTile` lives in
 * `packages/ui`, shared with ops. The merchant sits on its own line below,
 * with no divider. A money figure never wraps (#4400, `Amount` is
 * `whitespace-nowrap`); the layout gives it room: below `sm` Spent takes the
 * whole first row and Payments and Last paid share the second; from `sm` the
 * three sit across, Spent's track never narrower than its figure. Nothing
 * truncates.
 */
function LastThirtyDays({
  stats,
  currency,
}: {
  stats: DashboardAgentStats
  currency: AmountCurrency
}) {
  const d30 = stats.d30
  // #4274: the NET window, the same figure the dashboard's money card
  // (`MoneyPanel.tsx` per-agent rows) and agents section read — never the
  // gross window, which the two surfaces would then disagree on.
  const net = currency === 'EUR' ? d30.net.eur : currency === 'SEK' ? d30.net.sek : d30.net.usd
  // #4165: the per-currency "≈" DECISION, from the one rule — fall back to
  // the window's overall flag when an older backend omits the split.
  const approx = d30.approxByCurrency?.[currency.toLowerCase() as 'usd' | 'eur' | 'sek'] ?? d30.approx
  // #4274: a bucket the server could not price and nothing booked nets to —
  // the figure is unknown, "—" — never a fabricated $0.00. The unpriced NOTE
  // stays account-level (dashboard headline only); the per-agent rows carry
  // none, and neither does the hero.
  const unpriced = d30.unpricedByCurrency?.[currency.toLowerCase() as 'usd' | 'eur' | 'sek'] ?? false
  const merchant = agentMerchantLabel(stats.lastCounterparty)
  return (
    <div>
      <p className="text-sm font-medium text-[var(--v2-ink-2)]">Last 30 days</p>
      {d30.payments === 0 ? (
        <>
          <p className="mt-2 text-sm text-[var(--v2-ink-3)]">No payments in the last 30 days.</p>
          {/* An older payment still says when, and to whom. */}
          {stats.lastPaymentAt ? (
            <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
              Last paid {timeAgo(stats.lastPaymentAt)}
              {merchant ? ` to ${merchant}` : ''}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {/* #4400: from `sm`, three across — equal thirds while Spent fits
              its third, and Spent widens (the short Payments and Last paid
              give way) when a larger figure needs the room. */}
          <dl className="mt-2.5 grid grid-cols-2 gap-3 sm:grid-cols-[minmax(max-content,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <dt className="text-xs text-[var(--v2-ink-3)]">Spent</dt>
              <dd className="mt-0.5 text-[var(--v2-ink)]">
                <Amount amount={unpriced && net === 0 ? null : net} currency={currency} approx={approx} size="md" />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-[var(--v2-ink-3)]">Payments</dt>
              <dd className="mt-0.5 break-words text-xl font-semibold text-[var(--v2-ink)] v2-tabular">
                {d30.payments}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-[var(--v2-ink-3)]">Last paid</dt>
              <dd className="mt-0.5 break-words text-xl font-semibold text-[var(--v2-ink)]">
                {stats.lastPaymentAt ? timeAgo(stats.lastPaymentAt) : '—'}
              </dd>
            </div>
          </dl>
          {merchant ? (
            <p className="mt-2.5 break-words text-xs text-[var(--v2-ink-3)]">Last paid to {merchant}</p>
          ) : null}
        </>
      )}
    </div>
  )
}

type BudgetUsage = BudgetCaption

/**
 * The row's caption, from the shared helper (#3806). The state machine —
 * expired, dormant (not-started), failed read (unknown), stale read
 * (refilled-updating), meter — and the wording live in
 * `lib/budget-caption.ts`; this only projects the wire row onto it.
 *
 * `remaining_from_chain: false` means the chain read failed and
 * `remaining_atomic` is the full budget, NOT a measurement — so no meter (it
 * would claim "0 used") and no "snapshot" wording (it is not one either).
 * A null `remaining_from_chain` is "no figure on the row", which renders
 * nothing at all rather than a zero.
 */
function budgetCaptionFor(
  budget: DelegationBudget,
  chainId: number,
  symbol: string,
  style: 'full' | 'row' = 'full',
): BudgetUsage {
  let hasParseableAmounts = true
  try {
    BigInt(budget.budget_atomic)
    if (budget.remaining_atomic != null) BigInt(budget.remaining_atomic)
  } catch {
    hasParseableAmounts = false
  }
  const readOk = hasParseableAmounts && budget.remaining_atomic != null && budget.remaining_from_chain === true
  let usedAtomic: string | null = null
  if (readOk) {
    const total = BigInt(budget.budget_atomic)
    const remaining = BigInt(budget.remaining_atomic!)
    usedAtomic = (total > remaining ? total - remaining : 0n).toString()
  }
  return budgetCaption(
    {
      token: budget.token_address,
      recipient: budget.recipient_address,
      startSec: Number(budget.start_date),
      periodSeconds: budget.period_seconds,
      expiresSec: budget.expires_at,
      isLive: budget.is_live,
      budgetAtomic: budget.budget_atomic,
      usedAtomic,
      readFromChain: budget.remaining_from_chain !== false,
      periodEndMs: budget.period_end ? Date.parse(budget.period_end) : null,
      createdMs: Date.parse(budget.created_at),
      symbol,
      chainId,
    },
    // #1995: the clock enters as a value — the helper never reads it itself.
    // #4226: the hero asks for the dashboard row's compact wording — the
    // same `style: 'row'` caption, so the two surfaces cannot drift.
    { nowMs: Date.now(), style },
  )
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

/** "ends in 3d" / "ended" / "closed" for a sub-budget row (#3923: closed wins). */
function subBudgetEndText(b: { is_live?: boolean; status: string; expires_at: number }): string {
  const label = subBudgetEndLabel(b)
  return label === 'ends' ? `ends ${timeUntil(b.expires_at * 1000)}` : label
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
  const parentParts = [
    `${amount} ${t?.symbol ?? ''}`.trim(),
    subBudgetEndText(parent),
  ]
  if (parent.recipient_address) parentParts.push(`to ${truncateAddress(parent.recipient_address)}`)
  if (parent.status === 'pending') parentParts.push('waiting for the sharing agent to sign it')
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
  const parts = [
    `up to ${amount} ${t?.symbol ?? ''}`.trim(),
    subBudgetEndText(grant),
  ]
  // #3506: a freshly issued slice is pending until the sharing agent signs.
  if (grant.status === 'pending') parts.push('waiting for the sharing agent to sign it')
  if (grant.recipient_address) parts.push(`to ${truncateAddress(grant.recipient_address)}`)
  return (
    <div className="py-2">
      <Row density="flush" title={grant.label || 'Sub-agent slice'} subtitle={parts.join(' · ')} />
    </div>
  )
}

/**
 * One RECEIVED grant on the holder's page (#3988): the parent agent's name
 * as the title, the slice's amount per period and its end as the subtitle.
 * Pending and closing wording (#3988 builder copy, design-reviewed): a
 * pending grant pays nothing yet (the sharing agent has not signed it); a
 * closing one keeps working until its disable lands — both still listed,
 * because the owner can act on them, but they are not presented as live
 * authority. Closed grants never arrive (the read excludes them).
 */
function ReceivedBudgetGrantRow({ grant, tokens }: { grant: ReceivedSubBudgetGrant; tokens: TokenOption[] }) {
  const t = tokens.find((x) => x.address.toLowerCase() === grant.token_address.toLowerCase())
  const amount = t ? formatUnits(BigInt(grant.period_amount_atomic), t.decimals) : grant.period_amount_atomic
  const statusNote = receivedGrantStatusNote(grant)
  const parts = [`${amount} ${t?.symbol ?? ''}`.trim(), subBudgetEndText(grant)]
  if (statusNote) parts.push(statusNote)
  if (grant.recipient_address) parts.push(`to ${truncateAddress(grant.recipient_address)}`)
  return (
    <div className="py-2">
      <Row
        density="flush"
        title={`From ${grant.parent_agent_name}`}
        subtitle={parts.join(' · ')}
      />
    </div>
  )
}
