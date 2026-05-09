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
}: {
  title?: string
  description?: string
  items: AgentRuleSummaryItem[]
}) {
  return (
    <Card hover={false} className="p-5">
      <div>
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">{description}</p>
      </div>

      <dl className="mt-5 divide-y divide-[var(--v2-border)]">
        {items.map((item) => (
          <div key={item.label} className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[160px_1fr] sm:gap-4">
            <dt className="text-xs font-medium text-[var(--v2-ink-3)]">{item.label}</dt>
            <dd>
              <div className="text-sm font-medium text-[var(--v2-ink)]">{item.value}</div>
              {item.helper && <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">{item.helper}</p>}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
