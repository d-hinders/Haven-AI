import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { DetailList } from '@/components/ui/DetailList'

export type AgentRuleSummaryItem = {
  label: string
  value: ReactNode
  helper?: string
}

/**
 * The agent-rules card: a title, one description line, and the policy rows.
 *
 * The rows are the shared `components/ui/DetailList` (#4475) — this component
 * used to hand-roll the same hairline-divided `dl`, and the account Security
 * tab (#4474) needs that list with a trailing-actions column. The extraction
 * is a move, not a redesign: the rendered output for every consumer
 * (`connect-agent/PolicyStep.tsx`, `connect-agent/DelegationApprovalStep.tsx`
 * and the `/design-system` specimen) is unchanged, including the compact
 * density's 120px label track and the ink-3 helper tier (#1431).
 *
 * The title and description stay INSIDE the card here: this card is a summary
 * block in a modal or a page section, not a detail-page section heading (that
 * shape is `SectionHeading` / `SettingsSection`).
 */
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

      <DetailList items={items} density={density} className={compact ? 'mt-3' : 'mt-5'} />

      {footer ? (
        <div className={`${compact ? 'mt-3 pt-3' : 'mt-5 pt-4'} border-t border-[var(--v2-border)]`}>
          {footer}
        </div>
      ) : null}
    </Card>
  )
}
