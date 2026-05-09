import type { ReactNode } from 'react'

export function RiskExplainer({
  title = 'What the agent can do',
  items,
}: {
  title?: string
  items: ReactNode[]
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
      <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
      <ul className="mt-3 space-y-2">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--v2-brand)]" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
