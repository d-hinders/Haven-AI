import type { ReactNode } from 'react'

/**
 * A short, field- or dialog-level failure message. Keep larger failed-state
 * panels and toasts in their dedicated components.
 */
export function InlineAlert({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} role="alert" className="text-xs text-[var(--v2-danger)]">
      {children}
    </p>
  )
}
