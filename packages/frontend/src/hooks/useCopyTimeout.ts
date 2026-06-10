'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Manages a boolean "copied" state that automatically resets after a timeout.
 *
 * The timer is tracked in a ref and cleared on unmount, so this hook is safe
 * to use in components that may unmount before the timeout fires — avoiding
 * stale-closure setState calls and premature fiber retention.
 *
 * @param delay - How long (ms) the "copied" state stays true. Default: 2000.
 */
export function useCopyTimeout(delay = 2000): {
  copied: boolean
  markCopied: () => void
  reset: () => void
} {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Clean up on unmount so the timer never fires into a dead component.
  useEffect(() => clear, [clear])

  const markCopied = useCallback(() => {
    clear()
    setCopied(true)
    timerRef.current = setTimeout(() => {
      setCopied(false)
      timerRef.current = null
    }, delay)
  }, [clear, delay])

  const reset = useCallback(() => {
    clear()
    setCopied(false)
  }, [clear])

  return { copied, markCopied, reset }
}
