'use client'

import { useEffect } from 'react'

// Reference count so nested/overlapping modals don't unlock the body
// prematurely — the lock only lifts once the last locker releases.
let lockCount = 0
let previousOverflow = ''
let previousPaddingRight = ''

/**
 * Lock `document.body` scroll while `active` is true.
 *
 * Beyond the usual "background shouldn't scroll behind a modal" UX win, this
 * also stops the browser from continuously laying out and compositing the
 * (often large) page behind a fixed-overlay modal — which is a real
 * performance cost on content-heavy pages.
 *
 * Compensates for the disappearing scrollbar by padding the body so the
 * layout doesn't shift when the lock engages.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return

    if (lockCount === 0) {
      const { body } = document
      previousOverflow = body.style.overflow
      previousPaddingRight = body.style.paddingRight

      // Width of the now-hidden scrollbar, so content doesn't jump.
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
      if (scrollbarWidth > 0) {
        const currentPadding = parseFloat(window.getComputedStyle(body).paddingRight) || 0
        body.style.paddingRight = `${currentPadding + scrollbarWidth}px`
      }
      body.style.overflow = 'hidden'
    }

    lockCount += 1

    return () => {
      lockCount -= 1
      if (lockCount === 0) {
        document.body.style.overflow = previousOverflow
        document.body.style.paddingRight = previousPaddingRight
      }
    }
  }, [active])
}

export default useBodyScrollLock
