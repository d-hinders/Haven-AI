import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'

export type AgentRuleSummaryItem = {
  label: string
  value: ReactNode
  helper?: string
}

export function AgentRulesSummary({
  title = 'Agent rules',
  description = 'These rules define what the agent can do automatically.',
  items,
  density = 'normal',
  footer,
}: {
  /**
   * Card heading. Pass `null` to omit it — #1684: on the connect flow's
   * approve step the modal subtitle already says "Approve the agent budget"
   * about 40px above, and a card heading repeating it was the same sentence
   * twice in one viewport. A blank string would still reserve the heading's
   * line box, so the omission has to be explicit.
   */
  title?: string | null
  description?: string
  items: AgentRuleSummaryItem[]
  density?: 'normal' | 'compact'
  /**
   * Optional footer rendered below a divider inside the same card. Used by
   * the agent detail page to attach Pause / Revoke actions to the bottom of
   * the budget card without spinning up a separate "Agent access" card.
   */
  footer?: ReactNode
}) {
  const compact = density === 'compact'

  return (
    <Card hover={false} className={compact ? 'p-4' : 'p-5'}>
      <div>
        {title !== null && (
          <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
        )}
        <p
          className={`${compact ? 'text-xs' : 'text-sm'} ${title !== null ? 'mt-1' : ''} leading-relaxed text-[var(--v2-ink-2)]`}
        >
          {description}
        </p>
      </div>

      <dl className={`${compact ? 'mt-3' : 'mt-5'} divide-y divide-[var(--v2-border)]`}>
        {items.map((item) => (
          <div
            key={item.label}
            className={`${compact ? 'py-2 sm:grid-cols-[120px_1fr]' : 'py-3 sm:grid-cols-[160px_1fr]'} grid gap-1 first:pt-0 last:pb-0 sm:gap-4`}
          >
            <dt className="text-xs font-medium text-[var(--v2-ink-3)]">{item.label}</dt>
            <dd>
              <div className="text-sm font-medium text-[var(--v2-ink)]">{item.value}</div>
              {/* Row helpers are ink-3, matching the form steps' field-helper
                  tier (#1431) — the connect Review screen renders both one
                  screen apart. The top DESCRIPTION paragraph stays ink-2:
                  that is body copy, not a helper. */}
              {item.helper && (
                <p className={`${compact ? 'mt-0.5' : 'mt-1'} text-xs leading-relaxed text-[var(--v2-ink-3)]`}>
                  {item.helper}
                </p>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {footer ? (
        <div className={`${compact ? 'mt-3 pt-3' : 'mt-5 pt-4'} border-t border-[var(--v2-border)]`}>
          {footer}
        </div>
      ) : null}
    </Card>
  )
}
