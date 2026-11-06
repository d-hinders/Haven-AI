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
import { EllipsisVertical } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
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
 * **Not portalled.** The panel is `absolute` inside the trigger's `relative`
 * wrapper, so it is clipped by any ancestor whose `overflow` is not `visible`
 * (`overflow-hidden`, `overflow-clip`, `overflow-auto`, `overflow-scroll`, and
 * the `truncate` / `line-clamp-*` utilities that imply one). A container that
 * hosts this menu must therefore not clip — round its children instead. See
 * `docs/product/design-system.md` § Cards. Portalling is the alternative and
 * was rejected for #4491: it would change positioning, focus return and
 * scroll behaviour for every host to fix one call site.
 *
 * Usage:
 *   <DropdownMenu>
 *     <DropdownMenuIconTrigger aria-label="Account options" />
 *     <DropdownMenuContent>
 *       <DropdownMenuItem onSelect={openRename}>Rename</DropdownMenuItem>
 *       <DropdownMenuItem onSelect={remove} tone="danger">Remove</DropdownMenuItem>
 *     </DropdownMenuContent>
 *   </DropdownMenu>
 */
export function DropdownMenu({
  children,
  className = '',
}: {
  children: ReactNode
  /**
   * Extra classes for the root wrapper (#1767). The wrapper — not the trigger —
   * is what a surrounding flex row sees, so a trigger that needs to compress in
   * a tight row (`min-w-0`) has to say so HERE: `min-w-0` on the trigger alone
   * is inert, because the wrapper's own `min-width: auto` is what refuses to
   * shrink. Found by measuring a chip that stayed 176.88px wide in a 141px
   * slot and painted over its neighbour.
   */
  className?: string
}) {
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
      <div className={`relative inline-flex ${className}`.trim()}>{children}</div>
    </DropdownMenuContext.Provider>
  )
}

// ── Trigger ────────────────────────────────────────────────────────────────

type TriggerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-haspopup' | 'aria-expanded'>

function DropdownMenuTrigger({ children, onClick, className = '', ...rest }: TriggerProps) {
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

const ICON_TRIGGER_CLASS =
  'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-hover)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The one ⋮ button (owner decision, 2026-11-04): the three dots with no frame,
 * tinted on hover. The 44px tap target stays but draws nothing, so the button
 * cannot sit beside a 36px or 40px `Button` and read as a different size, which
 * is what a framed copy did on the contacts row. Build every overflow menu's
 * trigger from this, never from a hand-written class. The name is required
 * because the glyph says nothing: say what the menu acts on.
 *
 * `edge="end"` is for the last control on a line, such as a page header or a
 * list row. With no frame, the empty part of the target would leave the dots
 * floating well inside the line's right edge, so it pulls the target over the
 * edge until the icon box sits on it. The dots end up about 7px in, which reads
 * as aligned and keeps the hover tint close to the content.
 */
export function DropdownMenuIconTrigger({
  'aria-label': ariaLabel,
  edge,
  ...rest
}: Omit<TriggerProps, 'children' | 'className' | 'aria-label'> & {
  'aria-label': string
  edge?: 'end'
}) {
  return (
    <DropdownMenuTrigger
      aria-label={ariaLabel}
      className={edge === 'end' ? `${ICON_TRIGGER_CLASS} -mr-3.5` : ICON_TRIGGER_CLASS}
      {...rest}
    >
      <Icon icon={EllipsisVertical} className="h-4 w-4" />
    </DropdownMenuTrigger>
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
      className={`absolute top-full z-50 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-[var(--v2-border)] bg-[var(--v2-bg)] py-1 shadow-modal ${
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
        // Focus returns to the trigger BEFORE the action runs (#4259), while the
        // trigger is still mounted, so an action that moves focus wins: a field
        // it focuses keeps it, and a Modal it opens takes focus on mount and
        // records the trigger as its opener — closing the Modal lands back on
        // the trigger, never on <body>. The old deferred, unconditional restore
        // pulled focus out of the Modal and the field.
        triggerRef.current?.focus()
        onSelect()
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
