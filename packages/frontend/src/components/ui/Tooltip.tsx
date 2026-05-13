'use client'

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export type TooltipProps = {
  label: string
  side?: 'top' | 'bottom'
  mono?: boolean
  block?: boolean
  children: ReactNode
}

type Coords = { top: number; left: number } | null

export function Tooltip({
  label,
  side = 'top',
  mono = false,
  block = false,
  children,
}: TooltipProps) {
  const id = useId()
  const triggerRef = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<Coords>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const updatePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    if (side === 'bottom') {
      setCoords({ top: rect.bottom + 6, left: centerX })
    } else {
      setCoords({ top: rect.top - 6, left: centerX })
    }
  }, [side])

  useEffect(() => {
    if (!open) return
    updatePosition()
    const handler = () => updatePosition()
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('scroll', handler, true)
      window.removeEventListener('resize', handler)
    }
  }, [open, updatePosition])

  const show = () => setOpen(true)
  const hide = () => setOpen(false)

  const wrapperClass = block ? 'block' : 'inline-flex'
  const refCallback = (el: HTMLElement | null) => {
    triggerRef.current = el
  }

  const triggerProps = {
    className: wrapperClass,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    'aria-describedby': open ? id : undefined,
  }

  const bubble =
    mounted && open && coords
      ? createPortal(
          <span
            id={id}
            role="tooltip"
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              transform: `translate(-50%, ${side === 'top' ? '-100%' : '0'})`,
            }}
            className={[
              'pointer-events-none z-[210]',
              'bg-[var(--v2-ink)] text-white px-2.5 py-1.5 rounded-md',
              'text-[12px] leading-tight whitespace-nowrap',
              'shadow-[var(--v2-shadow-popover)]',
              mono ? 'font-mono' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {label}
          </span>,
          document.body,
        )
      : null

  return (
    <>
      {block ? (
        <div ref={refCallback as (el: HTMLDivElement | null) => void} {...triggerProps}>
          {children}
        </div>
      ) : (
        <span ref={refCallback as (el: HTMLSpanElement | null) => void} {...triggerProps}>
          {children}
        </span>
      )}
      {bubble}
    </>
  )
}

export default Tooltip
