'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'

// ── Context ────────────────────────────────────────────────────────────────

interface DropdownMenuContextValue {
  open: boolean
  setOpen: (next: boolean) => void
  triggerId: string
  menuId: string
  triggerRef: React.RefObject<HTMLButtonElement | null>
}

const DropdownMenuContext = createContext<DropdownMenuContextValue | null>(null)

function useDropdownMenu() {
  const ctx = useContext(DropdownMenuContext)
  if (!ctx) {
    throw new Error('DropdownMenu subcomponents must be used inside <DropdownMenu>.')
  }
  return ctx
}

// ── Root ───────────────────────────────────────────────────────────────────

/**
 * Lightweight overflow / kebab menu. One trigger, one panel, click-outside
 * + Escape to dismiss. Keep it minimal — anything richer (submenus, search,
 * portals) belongs in a dedicated component.
 *
 * Usage:
 *   <DropdownMenu>
 *     <DropdownMenuTrigger aria-label="Account options">
 *       <KebabIcon />
 *     </DropdownMenuTrigger>
 *     <DropdownMenuContent>
 *       <DropdownMenuItem onSelect={openRename}>Rename</DropdownMenuItem>
 *       <DropdownMenuItem onSelect={remove} tone="danger">Remove</DropdownMenuItem>
 *     </DropdownMenuContent>
 *   </DropdownMenu>
 */
export function DropdownMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const baseId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  return (
    <DropdownMenuContext.Provider
      value={{
        open,
        setOpen,
        triggerId: `${baseId}-trigger`,
        menuId: `${baseId}-menu`,
        triggerRef,
      }}
    >
      <div className="relative inline-flex">{children}</div>
    </DropdownMenuContext.Provider>
  )
}

// ── Trigger ────────────────────────────────────────────────────────────────

type TriggerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-haspopup' | 'aria-expanded'>

export function DropdownMenuTrigger({ children, onClick, className = '', ...rest }: TriggerProps) {
  const { open, setOpen, triggerId, menuId, triggerRef } = useDropdownMenu()

  return (
    <button
      ref={triggerRef}
      type="button"
      id={triggerId}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={(event) => {
        setOpen(!open)
        onClick?.(event)
      }}
      className={className}
      {...rest}
    >
      {children}
    </button>
  )
}

// ── Content ────────────────────────────────────────────────────────────────

/**
 * The floating panel. Anchored under and to the right of the trigger by
 * default; pass `align="left"` to switch sides.
 */
export function DropdownMenuContent({
  children,
  align = 'right',
}: {
  children: ReactNode
  align?: 'left' | 'right'
}) {
  const { open, setOpen, menuId, triggerId, triggerRef } = useDropdownMenu()
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Close on click outside.
  useEffect(() => {
    if (!open) return
    function handler(event: MouseEvent) {
      const target = event.target as Node
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, setOpen, triggerRef])

  // Close on Escape; restore focus to the trigger.
  useEscapeToClose(
    open,
    useCallback(() => {
      setOpen(false)
      triggerRef.current?.focus()
    }, [setOpen, triggerRef]),
  )

  // Roving focus across menu items via arrow keys.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const items = Array.from(
        panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
      ).filter((el) => !el.disabled)
      if (items.length === 0) return
      const currentIndex = items.findIndex((el) => el === document.activeElement)

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const next = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length
        items[next]?.focus()
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        const next = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length
        items[next]?.focus()
      } else if (event.key === 'Home') {
        event.preventDefault()
        items[0]?.focus()
      } else if (event.key === 'End') {
        event.preventDefault()
        items[items.length - 1]?.focus()
      }
    },
    [],
  )

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (!open) return
    const first = panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
    first?.focus()
  }, [open])

  if (!open) return null

  return (
    <div
      ref={panelRef}
      id={menuId}
      role="menu"
      aria-labelledby={triggerId}
      onKeyDown={handleKeyDown}
      className={`absolute top-full z-50 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-[var(--v2-border)] bg-white py-1 shadow-[var(--v2-shadow-modal)] ${
        align === 'right' ? 'right-0' : 'left-0'
      }`}
    >
      {children}
    </div>
  )
}

// ── Item ───────────────────────────────────────────────────────────────────

export function DropdownMenuItem({
  children,
  onSelect,
  disabled = false,
  tone = 'default',
}: {
  children: ReactNode
  onSelect: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}) {
  const { setOpen, triggerRef } = useDropdownMenu()

  const toneClasses =
    tone === 'danger'
      ? 'text-[var(--v2-danger)] hover:bg-[var(--v2-danger-soft)] focus-visible:bg-[var(--v2-danger-soft)]'
      : 'text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] focus-visible:bg-[var(--v2-surface)]'

  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        // Close first so any modal the handler opens can take focus.
        setOpen(false)
        onSelect()
        // Restore focus to the trigger if the action didn't move it.
        setTimeout(() => triggerRef.current?.focus(), 0)
      }}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${toneClasses}`}
    >
      {children}
    </button>
  )
}

// ── Separator ──────────────────────────────────────────────────────────────

export function DropdownMenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-[var(--v2-border)]" />
}
