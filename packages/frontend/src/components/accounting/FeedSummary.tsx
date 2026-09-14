'use client'

/**
 * The connection summary line at the top of `/accounting` (#2869, epic #2858).
 *
 * One line that says where settled payments are going right now, read from
 * `GET /accounting/feed/status`'s `destination` (the row flagged as the feed
 * target, whatever its status):
 *
 *   destination.status         line                                           action
 *   ─────────────────────────────────────────────────────────────────────────────────
 *   connected                  Feeding Fortnox · Company AB · last push 2 min ago   Open Settings
 *   needs_reauthorisation      Sign-in expired · "Your Fortnox sign-in has expired…" Fix in Settings
 *   scope_missing              Needs more access · "…needs more access (scopes)…"    Fix in Settings
 *   revoked_at_provider        Access revoked · "Access was revoked in Fortnox…"     Fix in Settings
 *   disconnected / no row      Not connected · "Connect your accounting tool…"       Open Settings
 *
 * The three attention rows get the `primary` button — theirs is the one
 * action that resolves the state; the two steady rows only point (ghost).
 *
 * The attention sentences and chips are the Settings card's own
 * (`settings.accounting.status` / `.detail`), so the summary and the row the
 * user lands on say the same thing. The connection itself is managed in
 * Settings (#2868) — nothing here connects, reconnects or disconnects.
 *
 * Not `ui/Row`: it truncates title and subtitle to one line, and the
 * attention sentence is the one line that must not be cut (same reason
 * #2868 chose `SettingsRow`). A plain flex block that wraps below `sm`.
 */
import { useLocale, useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge'
import { ATTENTION_STATUSES, type AccountingFeedStatus } from '@/hooks/useAccountingFeed'
import { INTL_LOCALE, type Locale } from '@/lib/i18n'

/** Where the connection is managed (#2868): Settings owns Connect / Reconnect / Disconnect. */
export const ACCOUNTING_SETTINGS_HREF = '/settings'

const TONE: Record<NonNullable<AccountingFeedStatus['destination']>['status'], StatusTone> = {
  connected: 'success',
  needs_reauthorisation: 'warning',
  scope_missing: 'warning',
  revoked_at_provider: 'danger',
  disconnected: 'neutral',
}

/**
 * "2 minutes ago" in the active locale. Coarse units on purpose — the line
 * is a pulse, not a log; the absolute time sits in the element's `title`.
 */
export function relativeTime(iso: string, locale: Locale, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(INTL_LOCALE[locale], { numeric: 'auto' })
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000)
  const abs = Math.abs(diffSec)
  if (abs < 60) return rtf.format(0, 'second') // "now" under numeric: 'auto'
  if (abs < 3600) return rtf.format(Math.trunc(diffSec / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.trunc(diffSec / 3600), 'hour')
  if (abs < 86_400 * 30) return rtf.format(Math.trunc(diffSec / 86_400), 'day')
  if (abs < 86_400 * 365) return rtf.format(Math.trunc(diffSec / (86_400 * 30)), 'month')
  return rtf.format(Math.trunc(diffSec / (86_400 * 365)), 'year')
}

export function FeedSummary({ status }: { status: AccountingFeedStatus }) {
  const t = useT()
  const { locale } = useLocale()
  const copy = t.accountingPage.summary
  const settingsCopy = t.settings.accounting
  const destination = status.destination
  const provider = destination?.displayName ?? 'Fortnox'
  const state = destination?.status ?? 'disconnected'

  let chip: string
  let line: string
  let detail: string | null = null
  let action = copy.fixInSettings
  switch (state) {
    case 'connected': {
      const parts = [copy.feeding(provider)]
      if (destination?.companyName) parts.push(destination.companyName)
      parts.push(destination?.lastPushAt ? copy.lastPush(relativeTime(destination.lastPushAt, locale)) : copy.nothingPushedYet)
      chip = settingsCopy.status.connected
      line = parts.join(' · ')
      // The pointer #2868 put on this page: the connection is managed in
      // Settings, and the summary says so without offering the control.
      detail = t.accountingPage.manageInSettings
      action = t.accountingPage.openSettings
      break
    }
    case 'needs_reauthorisation':
      chip = settingsCopy.status.needs_reauthorisation
      line = settingsCopy.detail.needsReauthorisation(provider)
      break
    case 'scope_missing': {
      const scopes = status.missingScopes.map((s) => settingsCopy.scopeLabels[s] ?? s).join(', ')
      chip = settingsCopy.status.scope_missing
      line = scopes ? settingsCopy.detail.scopeMissing(provider, scopes) : settingsCopy.detail.scopeMissingUnnamed(provider)
      break
    }
    case 'revoked_at_provider':
      chip = settingsCopy.status.revoked_at_provider
      line = settingsCopy.detail.revoked(provider)
      break
    case 'disconnected':
    default:
      // No `detail` here: the line already says "in Settings" and the action
      // is "Open Settings" — a third mention was the #2869 design review's nit.
      chip = copy.notConnected
      line = copy.notConnectedDetail
      action = t.accountingPage.openSettings
      break
  }
  // The attention states carry the one action that resolves them; the
  // steady states only point (#2869 design review: primary, not ghost).
  const attention = ATTENTION_STATUSES.includes(state)

  return (
    <Card className="p-5" hover={false}>
      <div
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        data-testid="feed-summary"
        data-status={state}
      >
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={TONE[state]}>{chip}</StatusBadge>
            <p
              className="text-sm font-medium text-[var(--v2-ink)]"
              title={state === 'connected' && destination?.lastPushAt ? new Date(destination.lastPushAt).toLocaleString() : undefined}
            >
              {line}
            </p>
          </div>
          {detail ? <p className="text-xs text-[var(--v2-ink-3)]">{detail}</p> : null}
        </div>
        <div className="shrink-0">
          <Button variant={attention ? 'primary' : 'ghost'} href={ACCOUNTING_SETTINGS_HREF}>
            {action}
          </Button>
        </div>
      </div>
    </Card>
  )
}

export default FeedSummary
