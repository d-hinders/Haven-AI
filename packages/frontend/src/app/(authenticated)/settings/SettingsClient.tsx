'use client'

import { type ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useLocale, useT } from '@/context/LocaleContext'
import type { Locale } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { PageHeader } from '@/components/ui/PageHeader'
import ManageApprovers from '@/components/settings/ManageApprovers'


function Section({
  title,
  description,
  children,
  className = '',
}: {
  title: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)] ${className}`}>
      <div className="rounded-t-[10px] border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-6 py-5">
        <h2 className="text-[13px] font-semibold uppercase tracking-widest text-[var(--v2-ink)]">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-[var(--v2-ink-3)]">{description}</p>
        ) : null}
      </div>
      <div className="divide-y divide-[var(--v2-border)]">{children}</div>
    </section>
  )
}

function SettingRow({
  label,
  value,
  detail,
  action,
}: {
  label: string
  value?: ReactNode
  detail?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--v2-ink)]">{label}</p>
        {detail ? (
          <div className="mt-1 text-sm text-[var(--v2-ink-3)]">{detail}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {value ? <div className="text-sm text-[var(--v2-ink-2)]">{value}</div> : null}
        {action}
      </div>
    </div>
  )
}

/**
 * Inline segmented control — the canonical Settings toggle (used for currency
 * and language). One tinted track (`--v2-surface`) with a white, shadowed
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
    success: 'bg-[var(--v2-success-soft)] text-[var(--v2-success)] border-[var(--v2-success)]/20',
    brand: 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)] border-[var(--v2-brand)]/20',
    warning: 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)] border-[var(--v2-warning)]/20',
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
  const { locale, setLocale } = useLocale()
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
          <SettingRow
            label={t.settings.language.label}
            detail={t.settings.language.detail}
            action={(
              <SegmentedControl
                ariaLabel={t.settings.language.label}
                value={locale}
                onChange={(next: Locale) => setLocale(next)}
                options={[
                  { value: 'en', label: t.settings.language.english },
                  { value: 'sv', label: t.settings.language.swedish },
                ]}
              />
            )}
          />
          <SettingRow
            label={t.settings.approvalAlerts.label}
            detail={t.settings.approvalAlerts.detail}
            action={<ComingSoonToggle label={t.settings.approvalAlerts.label} comingSoonText={t.common.comingSoon} />}
          />
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

        <Section
          title={t.settings.approvers.title}
          description={t.settings.approvers.description}
        >
          <ManageApprovers />
        </Section>

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
