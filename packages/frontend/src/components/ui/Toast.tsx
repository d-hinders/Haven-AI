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
  info: {
    container: 'bg-[var(--v2-ink)] text-white',
    close: 'text-white/50 hover:text-white',
    icon: <Icon icon={Info} className="h-4 w-4 flex-shrink-0" />,
  },
  success: {
    container:
      'bg-[var(--v2-success-soft)] border border-[var(--v2-success)]/20 text-[var(--v2-success)]',
    close: 'text-[var(--v2-success)]/50 hover:text-[var(--v2-success)]',
    icon: <Icon icon={Check} className="h-4 w-4 flex-shrink-0" />,
  },
  error: {
    container:
      'bg-[var(--v2-danger-soft)] border border-[var(--v2-danger)]/20 text-[var(--v2-danger)]',
    close: 'text-[var(--v2-danger)]/50 hover:text-[var(--v2-danger)]',
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
        'flex items-start gap-3 rounded-md px-4 py-3 shadow-[var(--v2-shadow-popover)] min-w-[240px] max-w-sm',
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
          'flex-shrink-0 rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/30',
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
      {/* Polite region — info + success */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 inset-x-4 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:left-auto z-[var(--v2-z-toast)] flex flex-col items-end gap-2"
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
        className="pointer-events-none fixed bottom-4 inset-x-4 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:left-auto z-[var(--v2-z-toast)] flex flex-col items-end gap-2"
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
