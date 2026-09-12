'use client'

/**
 * The two OFF states of the accounting feed (#2869, epic #2858).
 *
 * Owner decision 2026-09-11: the feed is VISIBLE in production while switched
 * off — the sidebar keeps its entry and this page explains what the feature
 * will do — but exposure (flipping `HAVEN_ACCOUNTING_ENABLED`) is a separate
 * manual decision. Two distinct off states, two copies, never confused:
 *
 *   - `<ComingSoon>` — `hosted && !enabled`. What the feed will do, and
 *     which platforms are listed (from `GET /accounting/providers` when it
 *     answers — that route is not behind the feed flag — else the static
 *     list below). **No connect and no sync control is reachable**: nothing
 *     exists to connect yet, and a disabled button would suggest otherwise.
 *   - `<SelfHostedUnavailable>` — `!hosted`. The feed is part of the hosted
 *     service; on a self-hosted box it is "not available", full stop. This
 *     copy must never read as coming soon — nothing is scheduled for a
 *     self-hosted deployment — and it lists no platforms for the same
 *     reason.
 *
 * Both replace the add-on upsell the page used to show for every
 * `!available`; that card now renders only for `enabled && !entitled`.
 */
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useT } from '@/context/LocaleContext'
import { useAccountingProviders } from '@/hooks/useAccounting'

/**
 * The registry's four entries as of #2862, for when `GET /accounting/providers`
 * does not answer (a deployment that gates it, or a transient failure). The
 * live list wins whenever it arrives.
 */
export const STATIC_PLATFORMS: ReadonlyArray<{ id: string; displayName: string }> = [
  { id: 'fortnox', displayName: 'Fortnox' },
  { id: 'accounted', displayName: 'Accounted' },
  { id: 'light', displayName: 'Light' },
  { id: 'igdrasil', displayName: 'Igdrasil' },
]

export function ComingSoon() {
  const t = useT()
  const copy = t.accountingPage.comingSoon
  const { providers, loading, error } = useAccountingProviders()
  const platforms = !loading && !error && providers.length > 0 ? providers : STATIC_PLATFORMS

  return (
    <div className="space-y-5" data-testid="accounting-coming-soon">
      <Card className="p-5" hover={false}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="v2-text-h3 text-[var(--v2-ink)]">{copy.title}</h2>
          <StatusBadge tone="brand">{t.common.comingSoon}</StatusBadge>
        </div>
        <p className="mt-2 text-sm text-[var(--v2-ink-2)]">{copy.body}</p>
        <p className="mt-2 text-sm text-[var(--v2-ink-3)]">{copy.notYet}</p>
      </Card>

      <Card className="p-5" hover={false}>
        <h3 className="text-sm font-medium text-[var(--v2-ink)]">{copy.platformsTitle}</h3>
        <p className="mt-1 text-sm text-[var(--v2-ink-3)]">{copy.platformsBody}</p>
        <ul className="mt-3 flex flex-wrap gap-2" aria-label={copy.platformsTitle}>
          {platforms.map((p) => (
            <li key={p.id}>
              <StatusBadge tone="neutral">{p.displayName}</StatusBadge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

export function SelfHostedUnavailable() {
  const t = useT()
  const copy = t.accountingPage.selfHosted
  return (
    // `EmptyState` on its own: nested in a `Card` it read as a box inside a
    // box (the #2869 mobile capture). The page-level empty state IS the surface.
    <div data-testid="accounting-self-hosted">
      <EmptyState tone="neutral" title={copy.title} body={copy.body} />
    </div>
  )
}

export default ComingSoon
