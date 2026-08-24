import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Check, FileText } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

export function CredentialHandoffCard({
  title = 'Credential file',
  description,
  primaryAction,
  secondaryAction,
  note,
  saved = false,
}: {
  title?: string
  description: ReactNode
  primaryAction: ReactNode
  secondaryAction?: ReactNode
  note?: ReactNode
  saved?: boolean
}) {
  return (
    <Card
      hover={false}
      className={`p-4 ${
        saved
          ? 'border-success/30 bg-[var(--v2-success-soft)]'
          : 'border-brand/30 bg-[var(--v2-brand-soft)]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={saved ? 'success' : 'brand'}>
              {saved ? 'Saved' : 'Action required'}
            </StatusBadge>
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
          </div>
          <div className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">{description}</div>
        </div>
        <div
          className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-white ${
            saved ? 'text-[var(--v2-success)]' : 'text-[var(--v2-brand)]'
          }`}
        >
          <Icon icon={saved ? Check : FileText} className="h-4 w-4" />
        </div>
      </div>

      {/* When the card has both primary + secondary actions we render them
       *  in a bordered subgrid (two buttons side by side reads as a chooser).
       *  When only the primary is present the wrapper would just be a frame
       *  around a single button — drop it and centre the button at its
       *  natural width. */}
      {secondaryAction ? (
        <div className="mt-4 grid gap-2 rounded-[10px] border border-[var(--v2-border)] bg-white p-2 sm:grid-cols-2">
          {primaryAction}
          {secondaryAction}
        </div>
      ) : (
        <div className="mt-4 flex justify-center">{primaryAction}</div>
      )}

      {note && <div className="mt-3 text-xs leading-relaxed text-[var(--v2-ink-3)]">{note}</div>}
    </Card>
  )
}
