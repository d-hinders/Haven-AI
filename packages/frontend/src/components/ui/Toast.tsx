'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Check, Info, TriangleAlert, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

// ── Types ──────────────────────────────────────────────────────────────────

type Tone = 'success' | 'error' | 'info'

interface ToastItem {
  id: string
  message: string
  tone: Tone
}

interface ToastFn {
  (opts: { message: string; tone?: Tone }): void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

interface ToastContextValue {
  toast: ToastFn
  dismiss: (id: string) => void
  toasts: ToastItem[]
}

// ── Context ────────────────────────────────────────────────────────────────

// Fallback no-op used when useToast() is called outside a provider (e.g. in
// unit tests that don't mount ToastProvider). In dev we also log a warning.
const noop = (() => {}) as unknown as ToastFn
noop.success = () => {}
noop.error = () => {}
noop.info = () => {}

const fallbackCtx: ToastContextValue = {
  toast: noop,
  dismiss: () => {},
  toasts: [],
}

const ToastContext = createContext<ToastContextValue>(fallbackCtx)

// ── Provider ───────────────────────────────────────────────────────────────

const MAX_TOASTS = 5
const AUTO_DISMISS_MS = 4000

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random()}`
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id)
    if (t !== undefined) {
      clearTimeout(t)
      timers.current.delete(id)
    }
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const push = useCallback(
    (message: string, tone: Tone) => {
      const id = genId()
      setToasts((prev) => {
        const next = [...prev, { id, message, tone }]
        // Drop oldest toasts beyond the cap
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next
      })
      const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
      timers.current.set(id, timer)
    },
    [dismiss],
  )

  // Clean up timers on unmount
  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach((t) => clearTimeout(t))
      map.clear()
    }
  }, [])

  const toast = useCallback(
    (opts: { message: string; tone?: Tone }) => push(opts.message, opts.tone ?? 'info'),
    [push],
  ) as ToastFn
  toast.success = useCallback((message: string) => push(message, 'success'), [push])
  toast.error = useCallback((message: string) => push(message, 'error'), [push])
  toast.info = useCallback((message: string) => push(message, 'info'), [push])

  return (
    <ToastMountedContext.Provider value={_sentinel}>
      <ToastContext.Provider value={{ toast, dismiss, toasts }}>
        {children}
      </ToastContext.Provider>
    </ToastMountedContext.Provider>
  )
}

// ── Hook ───────────────────────────────────────────────────────────────────

// Sentinel that lets us detect when no real provider has been mounted.
const _sentinel = Symbol('toast-provider-mounted')
const ToastMountedContext = createContext<typeof _sentinel | null>(null)

export function useToast(): Pick<ToastContextValue, 'toast'> {
  const mounted = useContext(ToastMountedContext)
  const ctx = useContext(ToastContext)
  if (mounted !== _sentinel && process.env.NODE_ENV !== 'production') {
    console.warn(
      '[Haven] useToast() was called outside of <ToastProvider>. ' +
        'Make sure <ToastProvider> wraps this component tree.',
    )
  }
  return { toast: ctx.toast }
}

// ── Toast item ─────────────────────────────────────────────────────────────

const TONE_STYLES: Record<Tone, { container: string; close: string; icon: React.ReactNode }> = {
  // The `close` ring colour is named per tone rather than inherited. It used to
  // be `ring-current/30`, which — exactly like the bare-`var()` shape #1708
  // removed — Tailwind drops from the compiled output entirely: an opacity
  // modifier has no channels to re-compose on `currentColor`, so no
  // `--tw-ring-color` was ever emitted and this ring rendered preflight's
  // blue-500/50 on all three tones. #1708's guard only matched
  // `ring-[var(--v2-*)]/N`, so it did not catch this second dead shape (#1741).
  info: {
    container: 'bg-[var(--v2-ink)] text-white',
    close: 'text-white/50 hover:text-white focus-visible:ring-white/80',
    icon: <Icon icon={Info} className="h-4 w-4 flex-shrink-0" />,
  },
  success: {
    container:
      'bg-[var(--v2-success-soft)] border border-success/20 text-[var(--v2-success)]',
    close: 'text-success/50 hover:text-[var(--v2-success)] focus-visible:ring-success/80',
    icon: <Icon icon={Check} className="h-4 w-4 flex-shrink-0" />,
  },
  error: {
    container:
      'bg-[var(--v2-danger-soft)] border border-danger/20 text-[var(--v2-danger)]',
    close: 'text-danger/50 hover:text-[var(--v2-danger)] focus-visible:ring-danger/80',
    icon: <Icon icon={TriangleAlert} className="h-4 w-4 flex-shrink-0" />,
  },
}

interface ToastItemProps {
  item: ToastItem
  onDismiss: (id: string) => void
}

function ToastItemView({ item, onDismiss }: ToastItemProps) {
  const [visible, setVisible] = useState(false)
  const styles = TONE_STYLES[item.tone]

  // Trigger enter transition on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      role="presentation"
      className={[
        'flex items-start gap-3 rounded-md px-4 py-3 shadow-popover min-w-[240px] max-w-sm',
        'transition-all duration-200',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
        styles.container,
      ].join(' ')}
    >
      {styles.icon}
      <span className="flex-1 text-sm font-medium leading-snug">{item.message}</span>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
        className={[
          'flex-shrink-0 rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2',
          styles.close,
        ].join(' ')}
      >
        <Icon icon={X} className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ── Toaster ────────────────────────────────────────────────────────────────

export function Toaster() {
  const ctx = useContext(ToastContext)
  if (!ctx) return null

  const { toasts, dismiss } = ctx

  const politeToasts = toasts.filter((t) => t.tone === 'info' || t.tone === 'success')
  const assertiveToasts = toasts.filter((t) => t.tone === 'error')

  return (
    <>
      {/*
        Safe-area insets (#2730). A toast is the one interactive surface pinned
        to the bottom edge, and `bottom-4` put the lower ~18px of every card —
        including its `Dismiss notification` button — inside the home
        indicator's band, where the OS reads a press as a swipe-up rather than a
        tap. Each side is `max(<the value it had>, <inset>)`, so nothing moves
        where the insets are 0. Both regions carry it: an assertive toast is no
        less pressable than a polite one.
      */}
      {/* Polite region — info + success */}
      {/*
        Lifted by the tab bar's height below `lg` (#2731). The bar is `fixed` at
        the bottom of the screen and toasts were `fixed bottom-4` in the same
        band, so the demo's payoff notification — "the purchase landed" — would
        have rendered behind the navigation everyone is looking at. `lg:` hands
        the original offset back, because there is no bar at that width.

        THREE variants, not two, and the middle one is the bug this nearly
        shipped with: `sm:bottom-…` already existed and overrides the base, so a
        bar offset applied only to the base is silently lost between 640px and
        1023px — the band where the bar is still rendered. The `sm` variant
        therefore carries the offset too, and `lg` is what drops it.
      
        All three terms ADD, and the `max()` that used to wrap the inset is
        gone. That form — `max(1rem, inset) + bar` — collapsed the gutter to
        ZERO on a notched device: the bar already pads itself with the inset, so
        the inset was doing double duty and at inset 34 the toast's bottom edge
        and the bar's top edge both landed on 90px. The three terms have three
        different owners — the toast's own gutter, the bar it must clear, and
        the device band the bar itself sits above — so none of them substitutes
        for another.
      */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-[calc(var(--v2-tab-bar-h)+var(--v2-safe-bottom)+1rem)] left-[max(1rem,var(--v2-safe-left))] right-[max(1rem,var(--v2-safe-right))] sm:bottom-[calc(var(--v2-tab-bar-h)+var(--v2-safe-bottom)+1.5rem)] lg:bottom-[max(1.5rem,var(--v2-safe-bottom))] sm:right-[max(1.5rem,var(--v2-safe-right))] sm:left-auto z-[var(--v2-z-toast)] flex flex-col items-end gap-2"
      >
        {politeToasts.map((item) => (
          <div key={item.id} className="pointer-events-auto w-full sm:w-auto">
            <ToastItemView item={item} onDismiss={dismiss} />
          </div>
        ))}
      </div>

      {/* Assertive region — errors */}
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="pointer-events-none fixed bottom-[calc(var(--v2-tab-bar-h)+var(--v2-safe-bottom)+1rem)] left-[max(1rem,var(--v2-safe-left))] right-[max(1rem,var(--v2-safe-right))] sm:bottom-[calc(var(--v2-tab-bar-h)+var(--v2-safe-bottom)+1.5rem)] lg:bottom-[max(1.5rem,var(--v2-safe-bottom))] sm:right-[max(1.5rem,var(--v2-safe-right))] sm:left-auto z-[var(--v2-z-toast)] flex flex-col items-end gap-2"
        style={{ marginBottom: politeToasts.length > 0 ? `${politeToasts.length * 60}px` : undefined }}
      >
        {assertiveToasts.map((item) => (
          <div key={item.id} className="pointer-events-auto w-full sm:w-auto">
            <ToastItemView item={item} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </>
  )
}

export default Toaster
