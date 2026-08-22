'use client'

import { Check, Clipboard } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
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
              <span className="uppercase tracking-wider text-xs text-white/40 font-mono">
                {language}
              </span>
            )}
            {onCopy && (
              <button
                type="button"
                onClick={() => void handleCopy()}
                aria-label={copied ? 'Copied' : 'Copy to clipboard'}
                className="inline-flex items-center justify-center h-6 w-6 rounded transition-colors text-white/50 hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
              >
                {copied ? (
                  <Icon icon={Check} className="h-3.5 w-3.5 text-[var(--v2-success)]" />
                ) : (
                  <Icon icon={Clipboard} className="h-3.5 w-3.5" />
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
