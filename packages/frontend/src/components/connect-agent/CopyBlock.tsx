'use client'

import { Button } from '../ui/Button'

export function CopyBlock({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
        <Button variant="ghost" size="sm" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="max-h-48 overflow-auto rounded-md bg-[var(--v2-surface)] p-3 text-left text-xs leading-relaxed text-[var(--v2-ink)] whitespace-pre-wrap break-words">
        {value}
      </pre>
    </div>
  )
}
