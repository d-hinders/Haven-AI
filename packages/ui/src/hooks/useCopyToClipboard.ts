'use client'

import { useCallback } from 'react'

/**
 * The ONE clipboard write (#4573).
 *
 * `navigator.clipboard.writeText` was hand-written in six places, each with
 * its own idea of what a failure means: some swallowed it, some toasted, one
 * latched a step forward on a write that never happened. The write itself is
 * the same everywhere, so it lives here once and reports the outcome as a
 * boolean instead of throwing.
 *
 * `false` covers every way the write can fail — a rejected promise (denied
 * permission, insecure origin, most headless captures) and a missing
 * `navigator.clipboard` (the property is absent on an insecure origin, so
 * `navigator.clipboard.writeText` throws synchronously). A caller that
 * advances a step or latches a one-time value must gate on the result: a
 * failed write copied nothing, and saying otherwise is the defect this hook
 * exists to prevent.
 *
 * `CopyButton` is the visual affordance and uses this hook; a caller that
 * needs its own button shape (the connect-agent setup prompt's primary,
 * full-width action, #3832) uses the hook directly rather than re-implementing
 * the write.
 */
export function useCopyToClipboard(): (value: string) => Promise<boolean> {
  return useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      return false
    }
  }, [])
}
