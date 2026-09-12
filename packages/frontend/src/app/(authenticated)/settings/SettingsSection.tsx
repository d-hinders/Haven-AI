import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'

/**
 * One titled section on the Settings page — the white card with the grey
 * `Card.Header` band and a hairline-divided row list under it.
 *
 * Extracted from `SettingsClient` on its second consumer (#2868): the
 * Accounting connections card lives in `components/accounting/` and has to
 * sit in the same vertical list as Preferences and Access without re-writing
 * the shell. Screen recipe: `docs/product/screen-recipes.md` § Settings.
 */
export function SettingsSection({
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
    <section className={`rounded-[10px] border border-[var(--v2-border)] bg-white shadow-card ${className}`}>
      <Card.Header padding="spacious" className="rounded-t-[10px]">
        <h2 className="text-[13px] font-semibold uppercase tracking-widest text-[var(--v2-ink)]">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-[var(--v2-ink-3)]">{description}</p>
        ) : null}
      </Card.Header>
      <div className="divide-y divide-[var(--v2-border)]">{children}</div>
    </section>
  )
}

/**
 * One row in a `SettingsSection`: label + detail on the left, value and/or
 * action on the right; stacks the action under the text below `sm`, which
 * is how every row on the Settings page already behaves — so a row with two
 * buttons reads in full on a phone instead of squeezing its label.
 *
 * Extracted with `SettingsSection` (#2868) for the same second consumer —
 * the Accounting card's provider rows carry a name + status chip as the
 * label, the state sentence as the detail and Connect / Reconnect /
 * Disconnect / Settings as the action. `label` is a `ReactNode` for that
 * chip; every existing call site passes a string.
 */
export function SettingsRow({
  label,
  value,
  detail,
  action,
  className = '',
  ...rest
}: {
  label: ReactNode
  value?: ReactNode
  detail?: ReactNode
  action?: ReactNode
  className?: string
  'data-testid'?: string
  'data-status'?: string
}) {
  return (
    <div
      className={`flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between ${className}`}
      {...rest}
    >
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

export default SettingsSection
