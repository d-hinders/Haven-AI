'use client'

/**
 * The dashboard's server-saved "Needs you" dismissals (#3813).
 *
 * Reads `GET /user/attention-dismissals` once per mount and writes through
 * `POST /user/attention-dismissals` — permanent, stored per account (the
 * backup item) and per agent ("Needs setup" for an agent kept without a
 * budget on purpose), so a dismissal made on one device hides the item on
 * every device of the same user. `lib/dashboard-attention.ts` stays the pure
 * one definition and consumes the resulting id set; this hook is its I/O.
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
 * A failed READ hides nothing (`dismissedIds` stays empty): the nag is the
 * safe direction, silence is the destructive one — the same unknown-value
 * rule the attention rules follow (#3295).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'
import { DISMISSIBLE_ATTENTION_KINDS, type AttentionRuleItem } from '@/lib/dashboard-attention'

export type AttentionDismissalsResponse = ApiSchema<'AttentionDismissalsResponse'>

/** The RecoveryNudge browser-storage key this hook migrates once (#3813). */
export const LEGACY_DISMISS_KEY = 'haven.recovery-nudge.dismissed'

/** The rule-item id a dismissal row hides (`lib/dashboard-attention.ts` ids). */
export function ruleItemIdForDismissal(row: {
  item_kind: string
  account_id: string | null
  agent_id: string | null
}): string {
  return row.item_kind === 'no-backup'
    ? `no-backup:${row.account_id}`
    : `needs-setup:${row.agent_id}`
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

export function useAttentionDismissals({ accounts }: UseAttentionDismissalsOptions = {}) {
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set())
  const migratedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<AttentionDismissalsResponse>('/user/attention-dismissals')
      .then((response) => {
        if (cancelled) return
        // MERGE, never replace: the legacy-key migration may have optimistically
        // added ids this session before the read landed; replacing the set
        // would un-hide them.
        setDismissedIds((previous) => {
          const merged = new Set(previous)
          for (const row of response.dismissals) merged.add(ruleItemIdForDismissal(row))
          return merged
        })
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
    setDismissedIds((previous) => new Set([...previous, ...ids]))

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
   * Persist a dismissal for a dismissible rule item. Optimistic: the id is
   * added before the POST, and REMOVED again if the write fails — an item
   * the server did not store comes back on the next poll rather than
   * silently staying hidden for the session.
   */
  const dismiss = useCallback((item: Pick<AttentionRuleItem, 'kind' | 'accountId' | 'agentId'>) => {
    if (!DISMISSIBLE_ATTENTION_KINDS.has(item.kind)) return

    const body =
      item.kind === 'no-backup' && item.accountId !== undefined
        ? { item_kind: 'no-backup' as const, account_id: item.accountId }
        : item.kind === 'needs-setup' && item.agentId !== undefined
          ? { item_kind: 'needs-setup' as const, agent_id: item.agentId }
          : null
    // A dismissible-kind item without its id is malformed — ignore rather
    // than POST a body the spec would refuse.
    if (body === null) return

    const id =
      body.item_kind === 'no-backup'
        ? `no-backup:${body.account_id}`
        : `needs-setup:${body.agent_id}`

    setDismissedIds((previous) => new Set([...previous, id]))

    void api.post('/user/attention-dismissals', body).catch(() => {
      setDismissedIds((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    })
  }, [])

  return { dismissedIds, dismiss }
}
