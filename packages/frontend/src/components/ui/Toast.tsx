'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'

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
    icon: (
      <svg
        aria-hidden="true"
        className="h-4 w-4 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
      </svg>
    ),
  },
  success: {
    container:
      'bg-[var(--v2-success-soft)] border border-[var(--v2-success)]/20 text-[var(--v2-success)]',
    close: 'text-[var(--v2-success)]/50 hover:text-[var(--v2-success)]',
    icon: (
      <svg
        aria-hidden="true"
        className="h-4 w-4 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
      </svg>
    ),
  },
  error: {
    container:
      'bg-[var(--v2-danger-soft)] border border-[var(--v2-danger)]/20 text-[var(--v2-danger)]',
    close: 'text-[var(--v2-danger)]/50 hover:text-[var(--v2-danger)]',
    icon: (
      <svg
        aria-hidden="true"
        className="h-4 w-4 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
    ),
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
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
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
        className="pointer-events-none fixed bottom-4 inset-x-4 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:left-auto z-[9999] flex flex-col items-end gap-2"
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
        className="pointer-events-none fixed bottom-4 inset-x-4 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:left-auto z-[9999] flex flex-col items-end gap-2"
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
