'use client'

/**
 * The dashboard's server-saved "Needs attention" dismissals (#3813) and
 * acknowledgements (#4324).
 *
 * Reads `GET /user/attention-dismissals` once per mount and writes through
 * `POST /user/attention-dismissals`, so a dismissal made on one device hides
 * the item on every device of the same user. Two families: PERMANENT
 * dismissals (the backup item per account, "Needs setup" per agent) and
 * ACKNOWLEDGEMENTS of the event-driven items, which come back when
 * something newer happens. `lib/dashboard-attention.ts` stays the pure one
 * definition and consumes the resulting map (rule-item id → when it was
 * acknowledged); this hook is its I/O.
 *
 * A row of a kind this build does not know is IGNORED (#4324 S1): before,
 * every non-backup row mapped to `needs-setup:<agent_id>`, so a dashboard
 * tab open across a deploy would have hidden an agent's "Needs setup" item
 * and badge on reading a newer kind.
 *
 * ── The legacy key migration (#3813, owner decision 4) ────────────────────
 *
 * `RecoveryNudge`'s browser-storage key (`haven.recovery-nudge.dismissed`)
 * was ONE global flag hiding every backup item. On the first load that finds
 * it, this hook writes a server dismissal for each account that is raising
 * the backup item AT THAT MOMENT (`funded: true` — the accounts the old key
 * was actually hiding; a funded account without the server's recommendation
 * never fired the item, and writing a dismissal for it could wrongly hide a
 * future one), then clears the key. An account funded LATER still raises
 * its own item: the migration only covers the accounts funded at migration
 * time. The key is cleared only after every write SUCCEEDS — a failed write
 * (or a failed overview load, which this never runs before) leaves the key
 * in place and the next load retries; the in-session hiding still holds,
 * exactly as the old key behaved.
 *
 * A failed READ hides nothing (`acknowledgements` stays empty): the nag is the
 * safe direction, silence is the destructive one — the same unknown-value
 * rule the attention rules follow (#3295).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'
import {
  DISMISSIBLE_ATTENTION_KINDS,
  type AttentionAcknowledgement,
  type AttentionRuleItem,
} from '@/lib/dashboard-attention'

export type AttentionDismissalsResponse = ApiSchema<'AttentionDismissalsResponse'>

/** The RecoveryNudge browser-storage key this hook migrates once (#3813). */
export const LEGACY_DISMISS_KEY = 'haven.recovery-nudge.dismissed'

/**
 * A dismissal row as this build reads it: the spec's row, with `item_kind`
 * widened to a string so a kind a NEWER backend writes is representable —
 * and then ignored (S1) instead of being mistyped as a known one.
 */
type DismissalRow = Pick<AttentionDismissalsResponse['dismissals'][number], 'account_id' | 'agent_id'> &
  Record<'item_kind', string>

/**
 * The rule-item id a dismissal row hides (`lib/dashboard-attention.ts` ids),
 * or null for a kind — or a kind/id pairing — this build does not know.
 * Mapped PER KIND (#4324 S1).
 */
export function ruleItemIdForDismissal(row: DismissalRow): string | null {
  switch (row.item_kind) {
    case 'no-backup':
      return row.account_id ? `no-backup:${row.account_id}` : null
    case 'needs-setup':
    case 'budget-reached':
    case 'budget-usage':
    case 'budget-scope':
      return row.agent_id ? `${row.item_kind}:${row.agent_id}` : null
    case 'payments-failed':
      return row.agent_id ? `payments-failed:${row.agent_id}` : 'payments-failed:unattributed'
    case 'haven-paused':
      return 'haven-paused'
    default:
      return null
  }
}

type DismissBody =
  | { item_kind: 'no-backup'; account_id: string }
  | { item_kind: 'needs-setup' | 'budget-reached' | 'budget-scope' | 'payments-failed'; agent_id: string }
  | { item_kind: 'budget-usage'; agent_id: string; period_end: string }
  | { item_kind: 'haven-paused' | 'payments-failed' }

/** The POST body that dismisses or acknowledges a rule item, or null when the item lacks the id its kind needs. */
export function dismissalBodyFor(
  item: Pick<AttentionRuleItem, 'id' | 'kind' | 'accountId' | 'agentId' | 'periodEnd'>,
): DismissBody | null {
  switch (item.kind) {
    case 'no-backup':
      return item.accountId !== undefined ? { item_kind: 'no-backup', account_id: item.accountId } : null
    case 'needs-setup':
    case 'budget-reached':
    case 'budget-scope':
      return item.agentId !== undefined ? { item_kind: item.kind, agent_id: item.agentId } : null
    case 'budget-ended':
      // #4353: shares the budget item's slot (`dashboard-attention.ts`
      // `budgetItemId`) — stored as `budget-reached`, re-armed by the end date.
      return item.agentId !== undefined ? { item_kind: 'budget-reached', agent_id: item.agentId } : null
    case 'budget-usage':
      return item.agentId !== undefined && item.periodEnd !== undefined
        ? { item_kind: 'budget-usage', agent_id: item.agentId, period_end: item.periodEnd }
        : null
    case 'payments-failed':
      return item.agentId !== undefined
        ? { item_kind: 'payments-failed', agent_id: item.agentId }
        : item.id === 'payments-failed:unattributed'
          ? { item_kind: 'payments-failed' }
          : null
    case 'haven-paused':
      return { item_kind: 'haven-paused' }
    default:
      return null
  }
}

// ui-local: a structural slice of the overview's account block the legacy-key migration reads — a props input, not a wire response shape.
export interface UseAttentionDismissalsOptions {
  /**
   * The overview's accounts, ONCE LOADED — the migration's "funded at that
   * moment" input. Pass nothing (or an unloaded overview's `undefined`)
   * until a successful overview read: a failed load must never decide what
   * was funded.
   */
  accounts?: Array<{
    accountId: string
    isTestnet?: boolean
    needs_backup_recommendation?: boolean | null
    funded?: boolean | null
  }>
}

type AcknowledgementMap = ReadonlyMap<string, AttentionAcknowledgement>

function withEntries(previous: AcknowledgementMap, entries: Array<[string, AttentionAcknowledgement]>): AcknowledgementMap {
  const next = new Map(previous)
  for (const [id, acknowledgement] of entries) next.set(id, acknowledgement)
  return next
}

export function useAttentionDismissals({ accounts }: UseAttentionDismissalsOptions = {}) {
  const [acknowledgements, setAcknowledgements] = useState<AcknowledgementMap>(() => new Map())
  const migratedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<AttentionDismissalsResponse>('/user/attention-dismissals')
      .then((response) => {
        if (cancelled) return
        // #4288: a malformed body hides nothing — same as a failed read.
        // The read ran inside a state updater once, and React
        // re-runs updaters while rendering, so a throw there never reached
        // the `.catch` below: it took the whole page down (the empty
        // account capture crashed on `FIXTURE_EMPTY_FALLBACK`, which has
        // no `dismissals` key). Guard the ITERATION, not the fixture.
        if (!Array.isArray(response?.dismissals)) return
        // MERGE, never replace: the legacy-key migration (or a dismiss) may
        // have optimistically added ids this session before the read landed;
        // replacing the map would un-hide them. The server row wins for the
        // ids it carries — it holds the stored acknowledgement time.
        const entries: Array<[string, AttentionAcknowledgement]> = []
        for (const row of response.dismissals) {
          const id = ruleItemIdForDismissal(row)
          if (id === null) continue
          entries.push([
            id,
            {
              acknowledgedAt: row.acknowledged_at ?? row.created_at,
              acknowledgedPeriodEnd: row.acknowledged_period_end ?? null,
            },
          ])
        }
        setAcknowledgements((previous) => withEntries(previous, entries))
      })
      .catch(() => {
        // A failed read hides nothing — see the header. The next mount
        // retries; nothing is written to storage.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ── Legacy key migration — runs at most once, and only on a loaded
  // overview. The key state decides, not the effect order: a mount without
  // the key never re-runs anything, and an overview that arrives late still
  // migrates on that arrival.
  useEffect(() => {
    if (migratedRef.current) return
    if (accounts === undefined) return
    if (typeof window === 'undefined') return
    if (window.localStorage.getItem(LEGACY_DISMISS_KEY) !== '1') return

    migratedRef.current = true

    const toMigrate = (accounts ?? []).filter(
      (account) =>
        account.isTestnet !== true &&
        account.needs_backup_recommendation === true &&
        account.funded === true,
    )
    const ids = toMigrate.map((account) => `no-backup:${account.accountId}`)

    // Hide this session immediately — the old key hid these items, and a
    // slow POST must not make them flash back.
    const now = new Date().toISOString()
    setAcknowledgements((previous) =>
      withEntries(previous, ids.map((id) => [id, { acknowledgedAt: now, acknowledgedPeriodEnd: null }])),
    )

    void Promise.all(
      toMigrate.map((account) =>
        api.post('/user/attention-dismissals', {
          item_kind: 'no-backup',
          account_id: account.accountId,
        }),
      ),
    )
      .then(() => {
        // Only a fully successful migration clears the key — a partial
        // failure retries whole on the next load.
        window.localStorage.removeItem(LEGACY_DISMISS_KEY)
      })
      .catch(() => {
        /* The key stays; the next load retries. In-session hiding holds. */
      })
  }, [accounts])

  /**
   * Persist a dismissal or acknowledgement for a dismissible rule item.
   * Optimistic: the id is hidden before the POST (acknowledged "now", by
   * this device's clock), replaced by the server's stored row when the
   * write succeeds, and REMOVED again if it fails — an item the server did
   * not store comes back on the next poll rather than silently staying
   * hidden for the session.
   */
  const dismiss = useCallback(
    (item: Pick<AttentionRuleItem, 'id' | 'kind' | 'accountId' | 'agentId' | 'periodEnd'>) => {
      if (!DISMISSIBLE_ATTENTION_KINDS.has(item.kind)) return
      const body = dismissalBodyFor(item)
      // A dismissible-kind item without its id is malformed — ignore rather
      // than POST a body the spec would refuse.
      if (body === null) return
      const id = item.id
      const previousEntry = { current: undefined as AttentionAcknowledgement | undefined }

      setAcknowledgements((previous) => {
        previousEntry.current = previous.get(id)
        return withEntries(previous, [
          [
            id,
            {
              acknowledgedAt: new Date().toISOString(),
              acknowledgedPeriodEnd: 'period_end' in body ? body.period_end : null,
            },
          ],
        ])
      })

      void api
        .post<AttentionDismissalsResponse['dismissals'][number]>('/user/attention-dismissals', body)
        .then((row) => {
          if (!row || typeof row.acknowledged_at !== 'string') return
          setAcknowledgements((previous) =>
            withEntries(previous, [
              [id, { acknowledgedAt: row.acknowledged_at, acknowledgedPeriodEnd: row.acknowledged_period_end ?? null }],
            ]),
          )
        })
        .catch(() => {
          setAcknowledgements((previous) => {
            const next = new Map(previous)
            // Restore what was there before (an older acknowledgement), or nothing.
            if (previousEntry.current) next.set(id, previousEntry.current)
            else next.delete(id)
            return next
          })
        })
    },
    [],
  )

  return { acknowledgements, dismiss }
}
