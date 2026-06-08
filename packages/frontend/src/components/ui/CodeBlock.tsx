'use client'

import { useCopyTimeout } from '@/hooks/useCopyTimeout'

export function CodeBlock({
  language = 'bash',
  children,
  filename,
  onCopy,
  onCopyFailed,
}: {
  language?: string
  children: string
  filename?: string
  /** Called only when the clipboard write actually succeeded. */
  onCopy?: () => void
  /**
   * Called when `navigator.clipboard.writeText` rejects (insecure origin,
   * permission denied, headless context, etc.). Consumers that gate UI on a
   * successful copy must hook this to surface the failure — otherwise the
   * gate stays locked silently and the user has no idea why.
   */
  onCopyFailed?: () => void
}) {
  const { copied, markCopied } = useCopyTimeout(2000)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children)
    } catch {
      // Don't fire onCopy on failure — that previously let consumers (e.g.
      // the Create Agent handoff modal) advance through a "credential
      // saved" gate even though no secret reached the clipboard.
      onCopyFailed?.()
      return
    }
    markCopied()
    onCopy?.()
  }

  const showHeader = !!(filename || onCopy)

  return (
    <div className="rounded-[10px] overflow-hidden border border-[var(--v2-border)] shadow-[var(--v2-shadow-card)] bg-[var(--v2-surface-code)]">
      {showHeader && (
        <div className="flex items-center justify-between px-4 h-9 border-b border-white/10">
          <span className="text-[12px] text-white/50 font-mono">
            {filename ?? language.toUpperCase()}
          </span>
          <div className="flex items-center gap-3">
            {filename && (
              <span className="uppercase tracking-wider text-[10px] text-white/40 font-mono">
                {language}
              </span>
            )}
            {onCopy && (
              <button
                type="button"
                onClick={() => void handleCopy()}
                aria-label={copied ? 'Copied' : 'Copy to clipboard'}
                className="inline-flex items-center justify-center h-6 w-6 rounded transition-colors text-white/50 hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
              >
                {copied ? (
                  <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5 text-[var(--v2-success)]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : (
                  <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
                    />
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>
      )}
      <pre className="px-5 py-4 text-[13px] leading-[1.65] text-white/90 font-mono overflow-x-auto v2-tabular">
        <code>{children}</code>
      </pre>
    </div>
  )
}
