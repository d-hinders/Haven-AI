'use client'

import { ArrowRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { type ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { PageHeader } from '@/components/ui/PageHeader'
import { SettingsSection as Section, SettingsRow as SettingRow } from './SettingsSection'
import { ConnectionsCard } from '@/components/accounting/ConnectionsCard'


/**
 * Inline segmented control — the canonical Settings toggle. Currency is its
 * only user since #2926 removed the language row; it is kept as the page's
 * toggle pattern (dark mode, #2927, is the next one). One tinted track
 * (`--v2-surface`) with a white, shadowed
 * thumb on the active option; matches the design-system surface rules (no
 * nested filled cards — the track is a control surface, not a grouping card).
 */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] p-1"
    >
      {options.map((option) => {
        const active = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            disabled={disabled}
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              active
                ? 'bg-white text-[var(--v2-ink)] shadow-sm'
                : 'text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]'
            } disabled:opacity-50`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function StatusPill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'success' | 'brand' | 'warning'
}) {
  const classes = {
    neutral: 'bg-[var(--v2-surface)] text-[var(--v2-ink-2)] border-[var(--v2-border)]',
    success: 'bg-[var(--v2-success-soft)] text-[var(--v2-success)] border-success/20',
    brand: 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)] border-brand/20',
    warning: 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)] border-warning/20',
  }

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${classes[tone]}`}>
      {children}
    </span>
  )
}

function ComingSoonToggle({ label, comingSoonText }: { label: string; comingSoonText: string }) {
  return (
    <div className="flex items-center gap-3">
      <StatusPill>{comingSoonText}</StatusPill>
      <button
        type="button"
        disabled
        aria-label={label}
        className="relative h-6 w-11 cursor-not-allowed rounded-full bg-[var(--v2-surface-2)] opacity-70"
      >
        <span className="absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm" />
      </button>
    </div>
  )
}

export default function SettingsClient() {
  const { passkeys = [] } = useAuth()
  const { currency, setCurrency, saving } = usePreferences()
  const t = useT()

  const hasPasskey = passkeys.length > 0

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={t.settings.title}
        subtitle={t.settings.subtitle}
        actions={
          <Button href="/profile" variant="ghost">
            {t.settings.viewProfile}
          </Button>
        }
      />

      <div className="space-y-6">
        <Section
          title={t.settings.preferences.title}
          description={t.settings.preferences.description}
        >
          <SettingRow
            label={t.settings.currency.label}
            detail={t.settings.currency.detail}
            action={(
              <SegmentedControl
                ariaLabel={t.settings.currency.label}
                value={currency}
                onChange={setCurrency}
                disabled={saving}
                options={[
                  { value: 'USD', label: '$ USD' },
                  { value: 'EUR', label: '€ EUR' },
                ]}
              />
            )}
          />
          {/*
            "Approval alerts" (notify me when a transaction needs approval) is
            removed with the approval queue itself (#1989, epic #1440). It was a
            legacy Safe / AllowanceModule concept; the delegation rail enforces
            budgets on-chain and never queues a payment, so there is nothing
            left to be notified about. A "coming soon" toggle for a flow the
            product has just deleted promises the wrong future.
          */}
          <SettingRow
            label={t.settings.agentSpendAlerts.label}
            detail={t.settings.agentSpendAlerts.detail}
            action={<ComingSoonToggle label={t.settings.agentSpendAlerts.label} comingSoonText={t.common.comingSoon} />}
          />
        </Section>

        <Section
          title={t.settings.access.title}
          description={t.settings.access.description}
        >
          <SettingRow
            label={t.settings.passkey.label}
            value={hasPasskey ? <StatusPill tone="success">{t.settings.passkey.enrolled}</StatusPill> : <StatusPill>{t.settings.passkey.none}</StatusPill>}
            detail={hasPasskey ? t.settings.passkey.detailEnrolled(passkeys.length) : t.settings.passkey.detailNone}
          />
          <SettingRow
            label={t.settings.password.label}
            detail={t.settings.password.detail}
            action={<StatusPill>{t.common.comingSoon}</StatusPill>}
          />
        </Section>

        {/*
          Accounting connections live HERE (owner decision 2026-09-11, #2868):
          the feed page keeps the sync rows, Settings owns Connect / Reconnect /
          Disconnect, the feed settings and the backfill choice.
        */}
        <ConnectionsCard />

        {/*
          The Approvers section is DELETED (#1989, epic #1440). It hosted
          `ManageApprovers`, which built and relayed Safe owner-change
          transactions through `POST /user/safes/:safeId/approvers/tx` — one of
          five approver routes #1988 removed with the Safe rail. Left in place
          it would render a section whose every action 404s.

          Its i18n keys (`t.settings.approvers.*`) went with it in #1993's
          residue sweep — an orphaned locale key is invisible to every gate
          (no import, no type, no route), so only a sweep finds one.
        */}

        <Section
          title={t.settings.recovery.title}
          description={t.settings.recovery.description}
        >
          <SettingRow
            label={t.settings.recovery.limitationsLabel}
            detail={t.settings.recovery.limitationsDetail}
          />
          <SettingRow
            label={t.settings.recovery.backupLabel}
            detail={t.settings.recovery.backupDetail}
            action={<StatusPill>{t.common.comingSoon}</StatusPill>}
          />
          <SettingRow
            label={t.settings.recovery.sessionsLabel}
            detail={t.settings.recovery.sessionsDetail}
            action={<StatusPill>{t.common.comingSoon}</StatusPill>}
          />
          <SettingRow
            label={t.settings.recovery.exitPathLabel}
            detail={t.settings.recovery.exitPathDetail}
            action={
              <a
                href="/exit/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-[var(--v2-brand)] hover:underline"
              >
                {t.settings.recovery.exitPathLabel}
                <Icon icon={ArrowRight} className="h-3.5 w-3.5" />
              </a>
            }
          />
        </Section>

        <Section
          title={t.settings.data.title}
          description={t.settings.data.description}
        >
          <SettingRow
            label={t.settings.data.exportLabel}
            detail={t.settings.data.exportDetail}
            action={<StatusPill>{t.common.comingSoon}</StatusPill>}
          />
          <SettingRow
            label={t.settings.data.privacyLabel}
            detail={t.settings.data.privacyDetail}
            action={<StatusPill>{t.common.comingSoon}</StatusPill>}
          />
        </Section>
      </div>
    </div>
  )
}
