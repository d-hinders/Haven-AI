'use client'

import { useEffect, useState, type RefObject } from 'react'

/**
 * Sub-pixel slack for the "is there more below" test.
 *
 * `scrollHeight` and `clientHeight` are integers while `scrollTop` is
 * fractional under a non-integer device pixel ratio, so a box scrolled fully
 * to the end can report a remainder just under 1. Anything at or below this is
 * the end of the scroll, not content hiding under the fold.
 */
const SCROLL_END_EPSILON_PX = 1

/**
 * Is there content below the fold of `ref`'s scroll box?
 *
 * Extracted from `ui/Modal` on its SECOND occurrence (#2067, per the #901
 * pattern-absorption preflight): the wallet menu gained a bounded scroll region
 * and needs the same edge cue Modal has carried since #1893. Modal's markup is
 * unchanged by the extraction — only the measurement moved here — so nothing
 * about its committed pixel baselines depends on this.
 *
 * ## Why the observers are pointed where they are
 *
 * Content can grow WITHOUT the scroll box resizing: it is a flex child with a
 * fixed height, so its own border box never changes when its children do. A
 * `ResizeObserver` on the box alone would therefore never fire. It is pointed
 * at the CHILDREN too, and a `MutationObserver` re-points it whenever the child
 * list changes.
 *
 * `enabled` is the caller's open/mounted flag: false tears the listeners down
 * and reports `false`, so a closed surface holds no observers.
 */
export function useScrollEdgeCue(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [hasContentBelow, setHasContentBelow] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const box = ref.current
    if (!box) return

    const measure = () => {
      setHasContentBelow(
        box.scrollHeight - box.clientHeight - box.scrollTop > SCROLL_END_EPSILON_PX,
      )
    }

    const resizeObserver = new ResizeObserver(measure)
    const observeChildren = () => {
      resizeObserver.disconnect()
      resizeObserver.observe(box)
      for (const child of Array.from(box.children)) resizeObserver.observe(child)
    }

    const mutationObserver = new MutationObserver(() => {
      observeChildren()
      measure()
    })

    observeChildren()
    measure()
    box.addEventListener('scroll', measure, { passive: true })
    mutationObserver.observe(box, { childList: true, subtree: true, characterData: true })

    return () => {
      box.removeEventListener('scroll', measure)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [ref, enabled])

  return hasContentBelow
}
