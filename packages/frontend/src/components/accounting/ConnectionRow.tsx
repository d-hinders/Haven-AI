'use client'

/**
 * One provider on the Settings → Accounting card (#2868, epic #2858).
 *
 * A row per provider from `GET /accounting/providers`, joined with the
 * caller's connection for it (if any). The five connection states render
 * distinctly and each carries the ONE action that resolves it:
 *
 *   status                 chip                 primary action   secondary
 *   ──────────────────────────────────────────────────────────────────────
 *   (no row)               Not connected      Connect          —
 *   disconnected           Not connected      Connect          —
 *   connected                Connected          Settings         Disconnect
 *   needs_reauthorisation    Sign-in expired    Reconnect        Disconnect
 *   scope_missing            Needs more access  Reconnect        Disconnect
 *   revoked_at_provider      Access revoked     Reconnect        Disconnect
 *
 * Reconnect IS Connect on the wire (#2865: the same connect-url + callback
 * on an existing row restores `connected` and keeps settings, `feedFrom`
 * and the sync history) — the label differs because the user's situation
 * does. `scope_missing` names `missingScopes` when the backend has them;
 * the array may be empty (a scope refusal the provider did not name), and
 * that case gets the unnamed sentence rather than "()". The identifiers are
 * shown as human labels (`companyinformation` → "company information") where
 * the catalog has one, raw otherwise.
 *
 * No row and `disconnected` share a chip and an action but not a sentence:
 * a first visit gets the one that guides the action ("Connect to feed…"),
 * a disconnected row the one that says what happened to its history.
 *
 * A `coming_soon` provider is listed with a one-line description and a
 * disabled Connect — listing is a product decision, not an endorsement. The
 * chip and the disabled button already say it cannot be connected, so the
 * description does not repeat it.
 *
 * ── Why `SettingsRow`, not `ui/Row` ──────────────────────────────────────
 * `ui/Row` truncates its title and subtitle to one line and never wraps its
 * trailing slot, so at 390px two action buttons squeeze the title to
 * "Fortn…" and hide the state sentence — the one line that says what is
 * wrong and which scopes are missing. `SettingsRow` is the Settings page's
 * own row (label + detail, action on the right, stacking under `sm` the way
 * Preferences and Access already do), so the card reads like its
 * neighbours at every width. No mobile-specific layout is added; the row
 * behaves as the rest of the page does.
 */
import { useLocale, useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge'
import { SettingsRow } from '@/app/(authenticated)/settings/SettingsSection'
import type { AccountingConnection, AccountingConnectionStatus, AccountingProvider } from '@/hooks/useAccounting'
import { INTL_LOCALE, type Locale } from '@/lib/i18n'
import { connectionSettingsRegionId } from './ConnectionSettings'

export type ConnectionAction = 'connect' | 'reconnect' | 'settings'

/**
 * The state → primary-action table, as a function so a test can pin every
 * row of it. `null` is "no connection row yet", which the card treats as
 * disconnected.
 */
export function primaryActionFor(status: AccountingConnectionStatus | null): ConnectionAction {
  switch (status) {
    case 'connected':
      return 'settings'
    case 'needs_reauthorisation':
    case 'scope_missing':
    case 'revoked_at_provider':
      return 'reconnect'
    case 'disconnected':
    case null:
      return 'connect'
  }
}

const CHIP_TONE: Record<AccountingConnectionStatus, StatusTone> = {
  connected: 'success',
  needs_reauthorisation: 'warning',
  scope_missing: 'warning',
  revoked_at_provider: 'danger',
  disconnected: 'neutral',
}

/** Absolute, locale-formatted day — never relative, so a capture is stable. */
export function formatConnectionDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleDateString(INTL_LOCALE[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export interface ConnectionRowProps {
  provider: AccountingProvider
  connection: AccountingConnection | null
  /** An action on THIS provider is in flight — its buttons are disabled. */
  busy: boolean
  /** The inline feed settings are open under this row. */
  settingsOpen: boolean
  onConnect: () => void
  onDisconnect: () => void
  onToggleSettings: () => void
}

export function ConnectionRow({
  provider,
  connection,
  busy,
  settingsOpen,
  onConnect,
  onDisconnect,
  onToggleSettings,
}: ConnectionRowProps) {
  const t = useT()
  const { locale } = useLocale()
  const copy = t.settings.accounting
  const name = provider.displayName

  if (provider.availability !== 'live') {
    return (
      <SettingsRow
        data-testid={`connection-row-${provider.id}`}
        label={
          <span className="inline-flex items-center gap-2">
            {name}
            <StatusBadge tone="neutral">{t.common.comingSoon}</StatusBadge>
          </span>
        }
        detail={copy.comingSoonDescription[provider.id]}
        action={
          <span className="flex items-center gap-2" data-testid={`connection-actions-${provider.id}`}>
            <Button size="sm" variant="ghost" disabled>
              {copy.actions.connect}
            </Button>
          </span>
        }
      />
    )
  }

  const status: AccountingConnectionStatus = connection?.status ?? 'disconnected'
  const action = primaryActionFor(connection?.status ?? null)
  const chipTone: StatusTone = CHIP_TONE[status]

  // The detail line is the one sentence that tells the user where they stand
  // and what resolves it.
  let detail: string
  switch (status) {
    case 'connected': {
      const company = connection?.externalCompanyName
      const where = company ? copy.detail.connectedTo(company) : copy.detail.connectedNoCompany
      const when = connection?.lastPushAt
        ? copy.detail.lastPush(formatConnectionDate(connection.lastPushAt, locale))
        : copy.detail.nothingFedYet
      detail = `${where} · ${when}`
      break
    }
    case 'needs_reauthorisation':
      detail = copy.detail.needsReauthorisation(name)
      break
    case 'scope_missing': {
      const scopes = (connection?.missingScopes ?? []).map((scope) => copy.scopeLabels[scope] ?? scope)
      detail = scopes.length > 0 ? copy.detail.scopeMissing(name, scopes.join(', ')) : copy.detail.scopeMissingUnnamed(name)
      break
    }
    case 'revoked_at_provider':
      detail = copy.detail.revoked(name)
      break
    case 'disconnected':
      if (!provider.configured) detail = copy.notConfigured
      else detail = connection ? copy.detail.disconnected(name) : copy.detail.notConnected(name)
      break
  }

  const canConnect = provider.configured
  const primary =
    action === 'settings' ? (
      <Button
        size="sm"
        variant="ghost"
        onClick={onToggleSettings}
        disabled={busy}
        aria-expanded={settingsOpen}
        aria-controls={connectionSettingsRegionId(provider.id)}
      >
        {settingsOpen ? copy.actions.hideSettings : copy.actions.settings}
      </Button>
    ) : (
      <Button size="sm" onClick={onConnect} disabled={busy || !canConnect}>
        {action === 'reconnect' ? copy.actions.reconnect : copy.actions.connect}
      </Button>
    )

  return (
    <SettingsRow
      data-testid={`connection-row-${provider.id}`}
      data-status={status}
      label={
        <span className="inline-flex items-center gap-2">
          {name}
          <StatusBadge tone={chipTone}>{copy.status[status]}</StatusBadge>
        </span>
      }
      detail={detail}
      action={
        <span
          className="flex items-center gap-2"
          data-testid={`connection-actions-${provider.id}`}
          data-status={status}
          data-action={action}
        >
          {primary}
          {connection && status !== 'disconnected' ? (
            <Button size="sm" variant="tertiary" onClick={onDisconnect} disabled={busy}>
              {copy.actions.disconnect}
            </Button>
          ) : null}
        </span>
      }
    />
  )
}

export default ConnectionRow
