import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'

/**
 * One titled section on the Settings page — a `v2-text-h3` heading sits ABOVE
 * the card, and the card holds the hairline-divided row list (settings pages
 * follow the detail-page section rule, owner decision 2026-10-23 on #4357).
 * The description is optional (#4476): it appears only when it tells the
 * reader something the heading and the card don't. The card can load, swap or
 * be replaced without moving its heading, and a skimming reader gets every
 * section name from the heading scan alone.
 *
 * The heading block itself is `components/ui/SectionHeading.tsx` (#4475), so
 * the same shape — including the optional trailing link — serves detail pages
 * that do not use `SettingsSection`. This component adds the `<section>` root
 * and the card; every existing caller's props and layout are unchanged.
 *
 * Moved here from `app/(authenticated)/settings/SettingsSection.tsx` (#4357)
 * so the design-system coupling gate watches it; screen recipe:
 * `docs/product/screen-recipes.md` § Settings.
 *
 * Note: unlike the Manage pattern on detail pages (#3695), settings rows keep
 * their visible actions — a settings section is not required to move row
 * actions into a ⋯ menu (`ConnectionRow`'s Connect / Reconnect / Disconnect /
 * Settings buttons stay compliant).
 */
export function SettingsSection({
  title,
  description,
  note,
  action,
  children,
  className = '',
  ...rest
}: {
  title: string
  description?: string
  /** A quieter second paragraph under the description — a responsibility line, not a second description. */
  note?: string
  /**
   * An optional trailing link on the heading's line (#4475) — navigation to
   * the fuller surface ("View all"), never a button. Omitted by every settings
   * caller today; the account Security tab (#4474) is the first consumer.
   */
  action?: ReactNode
  children: ReactNode
  className?: string
  /**
   * Passthrough for the section root (#4477). The agent Settings tab's two
   * sections are layout contracts its page tests select on
   * (`agent-settings-card-section`, `agent-account-section`), and the testid
   * has to sit on the `<section>` itself — a wrapper div would move it off
   * the element the rule is about. Nothing else about the shape changes.
   */
  'data-testid'?: string
}) {
  return (
    <section className={className} {...rest}>
      <SectionHeading title={title} description={description} note={note} action={action} />
      <Card hover={false}>
        <div className="divide-y divide-[var(--v2-border)]">{children}</div>
      </Card>
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
 *
 * `below` (#4478, owner decision 2026-10-27) is the optional full-width slot
 * under the label/action line: a disclosure, an inline alert, or a state note
 * that belongs to the whole row. `detail` cannot carry those — it lives in the
 * left text column, so below `sm` the action stacks after it and a disclosure
 * there pushes the control under the opened explanation; on desktop
 * `sm:items-center` re-centres the control as the column grows. The slot is
 * full-bleed (no horizontal padding) so a divided section can meet the card
 * edge; content that should align with the row's text wraps itself in `px-6`.
 * With the slot absent the row renders exactly as it did before — the root IS
 * the label/action line, pinned by an `outerHTML` snapshot in the test.
 */
export function SettingsRow({
  label,
  value,
  detail,
  action,
  below,
  className = '',
  ...rest
}: {
  label: ReactNode
  value?: ReactNode
  detail?: ReactNode
  action?: ReactNode
  /** Full-width content under the label/action line (#4478). */
  below?: ReactNode
  className?: string
  'data-testid'?: string
  'data-status'?: string
  /**
   * Passthroughs for the row root (#4477). `AgentPassportCard`'s loading state
   * is a `role="status"` row with an `aria-label`, and the row root is the
   * element that has to carry them — a wrapper would put the live region
   * around the row instead of on it.
   */
  role?: string
  'aria-label'?: string
}) {
  const line = (
    <>
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
    </>
  )

  // No slot: the row root IS the label/action line — byte-identical to the
  // pre-#4478 markup.
  if (below === undefined || below === null) {
    return (
      <div
        className={`flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between ${className}`}
        {...rest}
      >
        {line}
      </div>
    )
  }

  // With the slot the root becomes a block: the line keeps its own padding and
  // the slot spans the row's full width beneath it. The slot is after the line
  // in DOM order at every breakpoint — no `order-*` anywhere.
  return (
    <div className={className} {...rest}>
      <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        {line}
      </div>
      <div>{below}</div>
    </div>
  )
}

export default SettingsSection
