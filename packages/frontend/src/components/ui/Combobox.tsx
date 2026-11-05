'use client'

/**
 * Editable combobox — the WAI-ARIA 1.2 `combobox` pattern (#4640).
 *
 * The design system had no searchable picker: `Select` wraps the native
 * `<select>` (no filtering, no rich options) and `DropdownMenu` is a
 * `role="menu"` of actions. This is the primitive a caller reaches for when the
 * list is searchable, has more than about seven options, or has rich options
 * (a Monogram, a name and an address). `docs/product/design-system.md`
 * § *Combobox* carries the same rule in prose.
 *
 * ── It owns no data ─────────────────────────────────────────────────────────
 *
 * `query` is a prop and `groups` are props: the caller filters, the caller
 * decides what an option means. The component owns exactly two pieces of
 * state — whether the list is open, and which option is active — because both
 * are presentation, not data.
 *
 * ── A click, typing or an arrow opens the list, focus does not ──────────────
 *
 * A dialog focuses its first field when it opens, and a window handing focus
 * back does the same, so focus says nothing about what the user wants. Opening
 * on it put the list over the rest of the form before anyone had touched it. A
 * click also works on a field that already has focus, which a focus handler
 * never sees, so the list comes back after Escape closed it.
 *
 * ── Escape is a three-stage state machine ───────────────────────────────────
 *
 * `ui/Modal.tsx` closes the dialog on ANY Escape that reaches its `document`
 * listener, so an input inside a dialog has to consume the key itself while it
 * still has something of its own to undo:
 *
 *   1. list open            → close the list, dialog stays;
 *   2. list closed, query   → clear the query, dialog stays;
 *   3. list closed, empty   → not handled, so it reaches the dialog.
 *
 * Consuming the key takes the NATIVE `stopImmediatePropagation`, not only
 * `stopPropagation`. Next's App Router makes `document` the React root, so
 * React's listener and `Modal`'s sit on the same node: by the time a React
 * handler runs, the event is already at `document`, and `stopPropagation` only
 * keeps it from `window`. React's listener is registered at hydration, before
 * any `Modal` effect, so stopping the rest of `document`'s listeners reaches
 * `Modal`'s. A test mounting React in a `div` passes without this, which is why
 * `Combobox.documentRoot.test.tsx` runs the stages on a `document` root.
 *
 * ── A lone match is the active option ───────────────────────────────────────
 *
 * Typing or pasting until one option is left makes that option active, so Enter
 * picks it. An option the user reached with the arrows keeps priority, and an
 * empty query activates nothing by itself: a click must not arm Enter. A
 * group showing a status (loading, failed) keeps a lone option from counting as
 * alone, because the group may hold another match the user is typing towards.
 *
 * ── Placement: a portal from `sm` up, inline below it ───────────────────────
 *
 * `Modal`'s body scrolls (`overflow-y-auto`), so a list rendered inside the
 * field would be clipped by the dialog's scroll box. From `sm` up the list is
 * therefore portaled to `document.body` and positioned against the input, the
 * way `packages/ui/src/Tooltip.tsx` portals its bubble. Below `sm` it renders
 * inline under the field instead, so the on-screen keyboard cannot cover it.
 *
 * The portaled list sits on `--v2-z-tooltip`: the scale has no popover tier
 * above `--v2-z-modal`, and a list anchored to a field inside a dialog must
 * outrank the dialog. `--v2-z-tooltip` is the next tier up and carries the same
 * role — a transient overlay above a dialog.
 *
 * ── Why the option markup is not `Row` ──────────────────────────────────────
 *
 * An interactive `Row` renders a `<button>` and passes no `role`, `id` or
 * `aria-selected` (`packages/ui/src/Row.tsx`), and an option cannot be a
 * button. Rather than widen a shared primitive's render contract for one
 * consumer, the option reproduces Row's anatomy — leading slot, title,
 * subtitle, trailing slot, the same rhythm and the same
 * `--v2-surface-hover` active fill — in the Combobox's own markup. The issue
 * sanctions either choice; this is the one that leaves `Row` alone.
 *
 * ── The input is not a search field ─────────────────────────────────────────
 *
 * `hand-built-list-control` (`scripts/design-lint.mjs`) fires on a
 * `type="search"` input or a placeholder containing "search". This is a
 * combobox, not a search box: the input is a plain text field and the
 * placeholder names what the caller filters on ("Name or address"). No lint
 * exemption is needed, and none was added.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Input } from '@haven_ai/ui/Input'

/** One row of the list. `id` must be unique across every group. */
export interface ComboboxOption {
  id: string
  title: string
  subtitle?: ReactNode
  /** Leading slot — a `Monogram`, or a 16px icon. */
  leading?: ReactNode
  /** Trailing slot — a kind label, a badge, a short address. */
  trailing?: ReactNode
}

/**
 * A named run of options. `status` replaces the options with one line — the
 * loading skeleton and the failure line a caller shows while its data is not
 * there yet.
 */
export interface ComboboxGroup {
  id: string
  /** The visible group label. It is also the group's accessible name. */
  label: string
  options: ComboboxOption[]
  status?: { kind: 'loading' | 'error'; text: ReactNode }
}

export interface ComboboxProps {
  /** Accessible name of the input. */
  label: string
  placeholder?: string
  /** The caller's filter text. Controlled — the component never edits it. */
  query: string
  onQueryChange: (query: string) => void
  groups: ComboboxGroup[]
  onPick: (option: ComboboxOption) => void
  /** A line under the list, e.g. "Or paste a wallet address". */
  footer?: ReactNode
  /** Shown when no group has an option and none is loading. */
  emptyMessage?: string
  /** Extra classes for the field wrapper. */
  className?: string
  inputId?: string
  /** Reaches the `<input>`, so a caller can return focus to it. */
  inputRef?: RefObject<HTMLInputElement | null>
  autoFocus?: boolean
  disabled?: boolean
}

/** Tailwind's `sm`. Below it the list is inline, above it a portaled popover. */
const DESKTOP_QUERY = '(min-width: 640px)'
const POPOVER_GAP = 4
const POPOVER_MAX_HEIGHT = 320
/** Below this much room, the list flips above the field when there is more room there. */
const POPOVER_MIN_BELOW = 160

interface PopoverRect {
  left: number
  width: number
  top: number
  maxHeight: number
  placement: 'above' | 'below'
}

function measurePopover(anchor: HTMLElement): PopoverRect {
  const box = anchor.getBoundingClientRect()
  const spaceBelow = window.innerHeight - box.bottom - POPOVER_GAP
  const spaceAbove = box.top - POPOVER_GAP
  const placement: 'above' | 'below' =
    spaceBelow < POPOVER_MIN_BELOW && spaceAbove > spaceBelow ? 'above' : 'below'
  const room = placement === 'below' ? spaceBelow : spaceAbove
  // Clamped to the viewport so a field near an edge does not push the list off
  // screen; the width follows the field, which is what makes it read as its
  // popover rather than a floating panel.
  const left = Math.max(8, Math.min(box.left, window.innerWidth - box.width - 8))
  return {
    left,
    width: box.width,
    top: placement === 'below' ? box.bottom + POPOVER_GAP : box.top - POPOVER_GAP,
    maxHeight: Math.max(120, Math.min(POPOVER_MAX_HEIGHT, room)),
    placement,
  }
}

/** `sm` and up. Initialised `false` and corrected in an effect: the list only
 * renders once the user has interacted, so the first paint never depends on it
 * and there is no hydration mismatch to reconcile. */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY)
    setIsDesktop(media.matches)
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])
  return isDesktop
}

export function Combobox({
  label,
  placeholder,
  query,
  onQueryChange,
  groups,
  onPick,
  footer,
  emptyMessage = 'No matches.',
  className = '',
  inputId,
  inputRef,
  autoFocus = false,
  disabled = false,
}: ComboboxProps) {
  const baseId = useId()
  const listboxId = `${baseId}-listbox`
  const anchorRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const ownInputRef = useRef<HTMLInputElement>(null)
  const resolvedInputRef = inputRef ?? ownInputRef

  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [rect, setRect] = useState<PopoverRect | null>(null)
  const isDesktop = useIsDesktop()

  const flatOptions = useMemo(() => groups.flatMap((group) => group.options), [groups])
  const hasOptions = flatOptions.length > 0
  const anyStatus = groups.some((group) => group.status)
  // The arrows' choice while it is still listed, else a lone match for a query.
  // A group showing a status may still hold matches, so nothing is alone yet.
  const effectiveActiveId = flatOptions.some((option) => option.id === activeId)
    ? activeId
    : query.trim() !== '' && flatOptions.length === 1 && !anyStatus
      ? flatOptions[0].id
      : null

  const optionDomId = useCallback((id: string) => `${baseId}-option-${id}`, [baseId])
  const groupLabelId = useCallback((id: string) => `${baseId}-group-${id}`, [baseId])

  const close = useCallback(() => {
    setOpen(false)
    setActiveId(null)
  }, [])

  const pick = useCallback(
    (option: ComboboxOption) => {
      onPick(option)
      close()
    },
    [close, onPick],
  )

  // Position the portaled list against the field, and keep it there while the
  // page scrolls or the window resizes. A scroll that starts INSIDE the list is
  // the list scrolling itself, not the page moving under it.
  useLayoutEffect(() => {
    if (!open || !isDesktop) {
      setRect(null)
      return
    }
    const anchor = anchorRef.current
    if (!anchor) return
    setRect(measurePopover(anchor))
  }, [open, isDesktop])

  useEffect(() => {
    if (!open || !isDesktop) return
    const anchor = anchorRef.current
    if (!anchor) return
    let frame = 0
    const reposition = () => {
      frame = 0
      const box = anchor.getBoundingClientRect()
      // "It closes on scroll or resize if it cannot follow": once the field
      // itself has left the viewport there is nothing honest to anchor to.
      if (box.bottom < 0 || box.top > window.innerHeight) {
        setOpen(false)
        setActiveId(null)
        return
      }
      setRect(measurePopover(anchor))
    }
    const schedule = (event?: Event) => {
      const target = event?.target
      if (target instanceof Node && popoverRef.current?.contains(target)) return
      if (frame) return
      frame = window.requestAnimationFrame(reposition)
    }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [open, isDesktop])

  // A click or tap outside the field and the list closes without picking.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (anchorRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [close, open])

  // Scroll the active option into view. `scrollIntoView` is absent in jsdom, so
  // the call is guarded rather than assumed.
  useEffect(() => {
    if (!open || !effectiveActiveId) return
    const node = document.getElementById(optionDomId(effectiveActiveId))
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [effectiveActiveId, open, optionDomId])

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (flatOptions.length === 0) return
      const index = flatOptions.findIndex((option) => option.id === effectiveActiveId)
      const next =
        index < 0
          ? direction === 1
            ? 0
            : flatOptions.length - 1
          : Math.min(Math.max(index + direction, 0), flatOptions.length - 1)
      setActiveId(flatOptions[next].id)
    },
    [effectiveActiveId, flatOptions],
  )

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (open) {
        // Stage 1 — the list closes, the dialog stays.
        event.preventDefault()
        event.stopPropagation()
        event.nativeEvent.stopImmediatePropagation()
        close()
        return
      }
      if (query !== '') {
        // Stage 2 — the query clears, the dialog stays.
        event.preventDefault()
        event.stopPropagation()
        event.nativeEvent.stopImmediatePropagation()
        onQueryChange('')
        return
      }
      // Stage 3 — nothing left to undo here, so the dialog gets the Escape.
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActiveId(
          event.key === 'ArrowDown'
            ? (flatOptions[0]?.id ?? null)
            : (flatOptions[flatOptions.length - 1]?.id ?? null),
        )
        return
      }
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }

    if (event.key === 'Enter') {
      if (!open || !effectiveActiveId) return
      const option = flatOptions.find((candidate) => candidate.id === effectiveActiveId)
      if (!option) return
      event.preventDefault()
      pick(option)
      return
    }

    if (event.key === 'Tab') {
      // Tab moves on without picking — the list closes and focus leaves.
      close()
    }
  }

  const list = (
    <div
      role="listbox"
      id={listboxId}
      aria-label={label}
      className="min-h-0 flex-1 overflow-y-auto py-1"
    >
      {groups.map((group) => (
        <div key={group.id} role="group" aria-labelledby={groupLabelId(group.id)}>
          <p
            id={groupLabelId(group.id)}
            className="px-4 pb-1 pt-2 text-xs font-medium text-[var(--v2-ink-3)]"
          >
            {group.label}
          </p>
          {group.status ? (
            <div
              className="px-4 py-2 text-xs text-[var(--v2-ink-3)]"
              data-combobox-status={group.status.kind}
            >
              {group.status.text}
            </div>
          ) : (
            group.options.map((option) => {
              const isActive = option.id === effectiveActiveId
              return (
                <div
                  key={option.id}
                  id={optionDomId(option.id)}
                  role="option"
                  aria-selected={isActive}
                  data-combobox-option={option.id}
                  onClick={() => pick(option)}
                  className={`relative flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-150 ${
                    isActive ? 'bg-[var(--v2-surface-hover)]' : ''
                  }`}
                >
                  {option.leading ? (
                    <span aria-hidden="true" className="flex flex-shrink-0 items-center justify-center">
                      {option.leading}
                    </span>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{option.title}</p>
                    {option.subtitle ? (
                      <p className="mt-0.5 truncate text-xs text-[var(--v2-ink-3)]">{option.subtitle}</p>
                    ) : null}
                  </div>
                  {option.trailing ? (
                    <div className="flex-shrink-0 text-xs text-[var(--v2-ink-3)]">{option.trailing}</div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      ))}
    </div>
  )

  const body = (
    <>
      {hasOptions || anyStatus ? null : (
        <p className="px-4 py-3 text-xs text-[var(--v2-ink-3)]" data-combobox-empty="">
          {emptyMessage}
        </p>
      )}
      {list}
      {footer ? (
        <p className="shrink-0 border-t border-[var(--v2-border)] px-4 py-2 text-xs text-[var(--v2-ink-3)]">
          {footer}
        </p>
      ) : null}
    </>
  )

  const popoverClass =
    'flex flex-col rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-popover text-sm'

  return (
    <div ref={anchorRef} className={`relative ${className}`}>
      <Input
        ref={resolvedInputRef}
        id={inputId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && effectiveActiveId ? optionDomId(effectiveActiveId) : undefined}
        aria-label={label}
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          onQueryChange(event.target.value)
          setOpen(true)
        }}
        onClick={() => setOpen(true)}
        onBlur={(event) => {
          // Focus moving INTO the list is not a dismissal. A mousedown on the
          // list is prevented, so this only fires for a real move away.
          if (event.relatedTarget instanceof Node && popoverRef.current?.contains(event.relatedTarget)) {
            return
          }
          close()
        }}
        onKeyDown={onKeyDown}
      />

      {open && isDesktop && rect
        ? createPortal(
            <div
              ref={popoverRef}
              data-combobox-popover=""
              // `mousedown` is prevented so the input keeps focus while the
              // pointer is on the list — otherwise the blur would close the
              // list before the click landed.
              onMouseDown={(event) => event.preventDefault()}
              style={{
                position: 'fixed',
                left: rect.left,
                width: rect.width,
                maxHeight: rect.maxHeight,
                top: rect.top,
                transform: rect.placement === 'above' ? 'translateY(-100%)' : undefined,
              }}
              className={`z-[var(--v2-z-tooltip)] overflow-hidden ${popoverClass}`}
            >
              {body}
            </div>,
            document.body,
          )
        : null}

      {open && !isDesktop ? (
        <div
          ref={popoverRef}
          data-combobox-popover=""
          data-combobox-inline=""
          onMouseDown={(event) => event.preventDefault()}
          className={`mt-1 ${popoverClass}`}
        >
          {body}
        </div>
      ) : null}
    </div>
  )
}

export default Combobox
