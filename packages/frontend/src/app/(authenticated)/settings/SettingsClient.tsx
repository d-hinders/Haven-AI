'use client'

import { type ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
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

function ComingSoonToggle({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <StatusPill>Coming soon</StatusPill>
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

  const hasPasskey = passkeys.length > 0

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Settings"
        subtitle="Manage preferences, account access, notifications, and data controls."
        actions={
          <Button href="/profile" variant="ghost">
            View profile
          </Button>
        }
      />

      <div className="space-y-6">
        <Section
          title="Preferences"
          description="Choose how Haven displays values and future alerts."
        >
          <SettingRow
            label="Preferred currency"
            detail="Used for balances, spending limits, and portfolio totals."
            action={(
              <div className="flex rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] p-1">
                {(['USD', 'EUR'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setCurrency(c)}
                    disabled={saving}
                    className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                      currency === c
                        ? 'bg-white text-[var(--v2-ink)] shadow-sm'
                        : 'text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]'
                    } disabled:opacity-50`}
                  >
                    {c === 'USD' ? '$ USD' : '€ EUR'}
                  </button>
                ))}
              </div>
            )}
          />
          <SettingRow
            label="Approval alerts"
            detail="Get notified when a transaction needs approval."
            action={<ComingSoonToggle label="Approval alerts coming soon" />}
          />
          <SettingRow
            label="Agent spend alerts"
            detail="Receive updates when agents use their budget."
            action={<ComingSoonToggle label="Agent spend alerts coming soon" />}
          />
        </Section>

        <Section
          title="Access"
          description="How you sign in to Haven and approve actions on your accounts."
        >
          <SettingRow
            label="Passkey status"
            value={hasPasskey ? <StatusPill tone="success">Enrolled</StatusPill> : <StatusPill>No passkey</StatusPill>}
            detail={hasPasskey ? `${passkeys.length} passkey${passkeys.length !== 1 ? 's' : ''} registered for approving actions in Haven.` : 'Set up a passkey during onboarding for faster approvals.'}
          />
          <SettingRow
            label="Password"
            detail="Password changes are not available yet."
            action={<StatusPill>Coming soon</StatusPill>}
          />
        </Section>

        <Section
          title="Approvers"
          description="Wallets and passkeys that can approve actions, managed per account. Threshold stays at 1."
        >
          <ManageApprovers />
        </Section>

        <Section
          title="Recovery and safety"
          description="Know what Haven can and cannot recover."
        >
          <SettingRow
            label="Recovery limitations"
            detail="Haven can help you find account details, but it cannot bypass your wallets or passkeys or recover funds sent on the wrong network."
          />
          <SettingRow
            label="Backup approver"
            detail="Adding backup approvers is not available yet."
            action={<StatusPill>Coming soon</StatusPill>}
          />
          <SettingRow
            label="Active sessions"
            detail="Review signed-in devices and revoke sessions."
            action={<StatusPill>Coming soon</StatusPill>}
          />
        </Section>

        <Section
          title="Data and privacy"
          description="Controls for activity history and product preferences."
        >
          <SettingRow
            label="Export transactions"
            detail="Download a CSV of account and agent activity."
            action={<StatusPill>Coming soon</StatusPill>}
          />
          <SettingRow
            label="Privacy controls"
            detail="Manage analytics and product improvement preferences."
            action={<StatusPill>Coming soon</StatusPill>}
          />
        </Section>
      </div>
    </div>
  )
}
