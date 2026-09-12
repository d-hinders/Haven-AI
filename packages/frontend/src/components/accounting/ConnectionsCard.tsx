'use client'

/**
 * Settings → Accounting: the connections card (#2868, epic #2858).
 *
 * Owner decision 2026-09-11: connections live in Settings. This card lists
 * every provider from `GET /accounting/providers` as a `SettingsRow` — Fortnox live,
 * the rest Coming soon — joined with the caller's connections, and owns
 * Connect / Reconnect / Disconnect / Settings. The feed page (`/accounting`)
 * keeps the sync rows and points here.
 *
 * ── The OAuth return, and why the dialog is mounted HERE ────────────────
 * The backend callback redirects to
 * `/accounting?provider=<id>&connect=connected|denied|error[&reason=…]`
 * (`routes/accounting-connections.ts`, `accountingUrl`). The feed page
 * forwards that query to `/settings` untouched, so this card is the one
 * place that reads it: `connected` opens the backfill choice, `denied` and
 * `error` become a sentence beside the card, and `reason=unsupported_currency`
 * gets its own ("Haven currently feeds SEK ledgers only"). The query is then
 * stripped with `router.replace` so a reload does not replay the outcome.
 *
 * "First successful connect" is inferred, not signalled: the callback does
 * not say whether the row existed. The dialog opens when the returned
 * connection is `connected`, is the destination, and has never pushed
 * (`lastPushAt === null`) — a re-consent on a connection with history keeps
 * its floor and gets no dialog, while a reconnect that never fed is asked
 * again, which is harmless (the default is a no-op).
 *
 * The outcome is CONSUMED ONCE. `byProvider` changes on every later refetch
 * or in-place row swap (Save on the inline settings replaces the row; the
 * backfill call re-lists), and a first-connect row keeps `lastPushAt === null`
 * until something is fed — so an effect that only looked at the row would
 * re-open the dialog after "Feed from now" the moment Settings was saved.
 * `askedRef` remembers which outcome the dialog was opened for.
 *
 * Surface hierarchy: the card is a `SettingsSection` (white, grey header
 * band) whose body is a hairline-divided row list; the inline settings are
 * a padded block under their row, never a nested filled card.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Modal } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { SettingsSection } from '@/app/(authenticated)/settings/SettingsSection'
import {
  accountingRefusal,
  useAccountingConnections,
  useAccountingProviders,
  type AccountingConnection,
  type AccountingProvider,
} from '@/hooks/useAccounting'
import { BackfillDialog } from './BackfillDialog'
import { ConnectionRow } from './ConnectionRow'
import { ConnectionSettings } from './ConnectionSettings'

/** The callback's query, as this card reads it. Exported so the feed page forwards the same keys. */
export const CONNECT_OUTCOME_PARAMS = ['provider', 'connect', 'reason'] as const

export interface ConnectOutcome {
  provider: string
  connect: 'connected' | 'denied' | 'error'
  reason: string | null
}

export function readConnectOutcome(params: URLSearchParams | null): ConnectOutcome | null {
  const provider = params?.get('provider')
  const connect = params?.get('connect')
  if (!provider || (connect !== 'connected' && connect !== 'denied' && connect !== 'error')) return null
  return { provider, connect, reason: params?.get('reason') ?? null }
}

function isFirstSuccessfulConnect(connection: AccountingConnection | undefined): boolean {
  return Boolean(
    connection && connection.status === 'connected' && connection.isActiveDestination && connection.lastPushAt === null,
  )
}

export function ConnectionsCard() {
  const t = useT()
  const copy = t.settings.accounting
  const router = useRouter()
  const searchParams = useSearchParams()
  const { providers, loading: providersLoading, error: providersError } = useAccountingProviders()
  const {
    connections,
    loading: connectionsLoading,
    refreshing: connectionsRefreshing,
    error: connectionsError,
    connect,
    disconnect,
    updateSettings,
    backfill,
  } = useAccountingConnections()

  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [openSettings, setOpenSettings] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingDisconnect, setPendingDisconnect] = useState<AccountingProvider | null>(null)
  const [backfillFor, setBackfillFor] = useState<AccountingProvider | null>(null)
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null)
  /** The outcome the backfill dialog has already been opened for — asked once, never re-asked. */
  const askedRef = useRef<ConnectOutcome | null>(null)

  // First load only: a refetch (after Disconnect, a backfill) keeps the rows
  // rendered — `refreshing` marks the region busy instead of collapsing it
  // to a skeleton.
  const loading = providersLoading || connectionsLoading
  const byProvider = useMemo(() => new Map(connections.map((c) => [c.provider, c])), [connections])

  // Read the callback's outcome ONCE per query string, then strip it from the
  // URL. Keyed on the string, not the `URLSearchParams` object or the router
  // (neither is guaranteed stable across renders), so this cannot re-run
  // itself into a loop.
  const query = searchParams?.toString() ?? ''
  const routerRef = useRef(router)
  routerRef.current = router
  useEffect(() => {
    const params = new URLSearchParams(query)
    const read = readConnectOutcome(params)
    if (!read) return
    setOutcome(read)
    for (const key of CONNECT_OUTCOME_PARAMS) params.delete(key)
    const qs = params.toString()
    routerRef.current.replace(`/settings${qs ? `?${qs}` : ''}`)
  }, [query])

  // The backfill dialog waits for the listings: it needs the returned row to
  // decide whether this was a first connect, and the provider's display name.
  useEffect(() => {
    if (loading || !outcome || outcome.connect !== 'connected') return
    if (askedRef.current === outcome) return
    const provider = providers.find((p) => p.id === outcome.provider)
    if (provider && isFirstSuccessfulConnect(byProvider.get(outcome.provider))) {
      askedRef.current = outcome
      setBackfillFor(provider)
    }
  }, [loading, outcome, providers, byProvider])

  const run = useCallback(async (providerId: string, fn: () => Promise<unknown>, failure: string) => {
    setBusyProvider(providerId)
    setActionError(null)
    try {
      await fn()
    } catch (err) {
      const refusal = accountingRefusal(err)
      setActionError(refusal.message || failure)
    } finally {
      setBusyProvider(null)
    }
  }, [])

  const outcomeLine = (() => {
    if (!outcome) return null
    const name = providers.find((p) => p.id === outcome.provider)?.displayName ?? outcome.provider
    if (outcome.connect === 'connected') return { tone: 'ok' as const, text: copy.outcome.connected(name) }
    if (outcome.connect === 'denied') return { tone: 'error' as const, text: copy.outcome.denied(name) }
    if (outcome.reason === 'unsupported_currency') return { tone: 'error' as const, text: copy.outcome.unsupportedCurrency }
    return { tone: 'error' as const, text: copy.outcome.error(name) }
  })()

  const listError = providersError || connectionsError ? copy.loadError : null

  return (
    <SettingsSection title={copy.title} description={copy.description} note={copy.disclaimer}>
      {outcomeLine || actionError ? (
        <div className="space-y-2 px-6 py-3" data-testid="accounting-outcome">
          {outcomeLine ? (
            outcomeLine.tone === 'ok' ? (
              <p role="status" className="text-sm text-[var(--v2-success)]">
                {outcomeLine.text}
              </p>
            ) : (
              <InlineAlert>{outcomeLine.text}</InlineAlert>
            )
          ) : null}
          {actionError ? <InlineAlert>{actionError}</InlineAlert> : null}
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-3 px-6 py-4" role="status" aria-busy="true" aria-label={copy.title}>
          <Skeleton variant="text" className="h-5 w-48" />
          <Skeleton variant="text" className="h-4 w-full max-w-md" />
        </div>
      ) : listError ? (
        <div className="px-6 py-4">
          <InlineAlert>{listError}</InlineAlert>
        </div>
      ) : (
        <div
          className="divide-y divide-[var(--v2-border)]"
          data-testid="connection-list"
          aria-busy={connectionsRefreshing || undefined}
        >
          {providers.map((provider) => {
            const connection = byProvider.get(provider.id) ?? null
            const settingsOpen = openSettings === provider.id && connection?.status === 'connected'
            return (
              <div key={provider.id}>
                <ConnectionRow
                  provider={provider}
                  connection={connection}
                  busy={busyProvider === provider.id}
                  settingsOpen={settingsOpen}
                  onConnect={() => void run(provider.id, () => connect(provider.id), copy.connectError(provider.displayName))}
                  onDisconnect={() => setPendingDisconnect(provider)}
                  onToggleSettings={() => setOpenSettings((open) => (open === provider.id ? null : provider.id))}
                />
                {settingsOpen && connection ? (
                  // `Card.Section divided`: a hairline above the inline form so
                  // it reads as the row's own subsection — white on white, never
                  // a nested filled card.
                  <Card.Section divided>
                    <ConnectionSettings
                      connection={connection}
                      onSave={(patch) => updateSettings(provider.id, patch)}
                    />
                  </Card.Section>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {pendingDisconnect ? (
        <Modal
          open
          onClose={() => setPendingDisconnect(null)}
          title={copy.disconnect.title(pendingDisconnect.displayName)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPendingDisconnect(null)} disabled={busyProvider !== null}>
                {copy.disconnect.cancel}
              </Button>
              <Button
                variant="danger"
                disabled={busyProvider !== null}
                onClick={() => {
                  const provider = pendingDisconnect
                  void run(provider.id, () => disconnect(provider.id), copy.disconnect.error).then(() =>
                    setPendingDisconnect(null),
                  )
                }}
              >
                {copy.disconnect.confirm}
              </Button>
            </>
          }
        >
          <p>{copy.disconnect.body(pendingDisconnect.displayName)}</p>
        </Modal>
      ) : null}

      {backfillFor ? (
        <BackfillDialog
          open
          providerName={backfillFor.displayName}
          onClose={() => setBackfillFor(null)}
          onBackfill={(since) => backfill(backfillFor.id, since)}
        />
      ) : null}
    </SettingsSection>
  )
}

export default ConnectionsCard
