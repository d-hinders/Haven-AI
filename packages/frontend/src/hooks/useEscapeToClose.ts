import { useEffect } from 'react'

/**
 * Calls `onClose` when the user presses Escape while `open` is true.
 * Pass `enabled: false` to suppress (e.g. while a modal is mid-execution
 * and the user shouldn't be able to accidentally cancel).
 */
export function useEscapeToClose(
  open: boolean,
  onClose: () => void,
  { enabled = true }: { enabled?: boolean } = {},
) {
  useEffect(() => {
    if (!open || !enabled) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, enabled, onClose])
}
