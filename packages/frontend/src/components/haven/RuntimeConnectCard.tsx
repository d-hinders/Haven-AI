'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useToast } from '@/components/ui/Toast'
import type { AgentCredentialJson } from '@/lib/agent-credential'
import {
  buildRuntimeSnippets,
  type RuntimeSnippet,
  type RuntimeSnippetId,
  type RuntimeSnippetMode,
} from '@/lib/agent-runtime-snippets'

/**
 * Runtime connect card — primary post-creation surface on the Done step.
 *
 * Behaviour:
 *
 *   - The card lands with no tile selected. Tiles are visible and inviting;
 *     the code block stays out of sight until the user picks one. Reduces
 *     visual noise on first paint and lets the user focus on the question
 *     "which app is going to run this agent?" first.
 *   - Picking a tile reveals the code section with the wizard's standard
 *     `v2-animate-step-rise` entrance. Re-keying on `<tileId>:<mode>` means
 *     switching tiles or modes also replays the animation.
 *   - Inline mode embeds credentials directly in the snippet (one paste,
 *     no files). File mode references the downloaded credential file path
 *     so the snippet itself holds no secret.
 *
 * Non-custodial: the card never displays the secret outside the snippet body
 * — there is no standalone "your secret is X" line. Secrets only appear
 * where they are actionable (inside the code block), which keeps copy-to-
 * clipboard a deliberate action.
 *
 * Copy-failure handling: `CodeBlock` only fires `onCopy` when the clipboard
 * write actually resolved. If the browser rejects the write (insecure
 * origin, permissions, headless context), `onCopyFailed` fires instead. We
 * surface that as an inline error AND skip the toast/`onSnippetCopied`
 * call so the parent modal's "credentials saved" gate stays locked until
 * the user successfully copies the snippet (or copies it by hand and the
 * gate is satisfied another way).
 */

export interface RuntimeConnectCardProps {
  credential: AgentCredentialJson
  /**
   * Optional override for the credential file path used in "With credential
   * file" mode. Defaults to a generic placeholder. Today nothing in the
   * modal knows the user's actual save path, so a placeholder is the honest
   * representation.
   */
  credentialFilePath?: string
  /**
   * Called when the user copies any snippet. The modal listens to this to
   * flip its "credential saved" gate — copying a snippet means the user
   * has the credentials outside this once-only view.
   */
  onSnippetCopied?: (snippet: RuntimeSnippet) => void
  /** Suggested first-prompt copy shown beneath the snippet area. */
  tryItPrompt?: string
}

const DEFAULT_TRY_IT_PROMPT = `Ask your agent: "What's my Haven budget?"`

export function RuntimeConnectCard({
  credential,
  credentialFilePath,
  onSnippetCopied,
  tryItPrompt = DEFAULT_TRY_IT_PROMPT,
}: RuntimeConnectCardProps) {
  const { toast } = useToast()

  // Lands with nothing selected. The first click reveals the code block.
  const [activeId, setActiveId] = useState<RuntimeSnippetId | null>(null)
  const [mode, setMode] = useState<RuntimeSnippetMode>('inline')
  const [copyError, setCopyError] = useState<RuntimeSnippetId | null>(null)
  const copyErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear the auto-dismiss timer on unmount so it never fires into a dead component.
  useEffect(() => {
    return () => {
      if (copyErrorTimerRef.current !== null) clearTimeout(copyErrorTimerRef.current)
    }
  }, [])

  const snippets = useMemo(
    () => buildRuntimeSnippets({ credential, credentialFilePath }, mode),
    [credential, credentialFilePath, mode],
  )
  const active = activeId ? snippets.find((s) => s.id === activeId) ?? null : null

  const handleCopy = useCallback(
    (snippet: RuntimeSnippet) => {
      setCopyError((id) => (id === snippet.id ? null : id))
      toast.success('Configuration copied')
      onSnippetCopied?.(snippet)
    },
    [toast, onSnippetCopied],
  )

  const handleCopyFailed = useCallback(
    (snippet: RuntimeSnippet) => {
      // Clear any previous auto-dismiss timer before arming a new one.
      if (copyErrorTimerRef.current !== null) clearTimeout(copyErrorTimerRef.current)
      setCopyError(snippet.id)
      // Auto-clear after a few seconds so the inline error doesn't linger
      // forever if the user navigates away and back.
      copyErrorTimerRef.current = setTimeout(
        () => {
          setCopyError((id) => (id === snippet.id ? null : id))
          copyErrorTimerRef.current = null
        },
        4000,
      )
    },
    [],
  )

  return (
    <Card hover={false} className="p-4" elevation="anchor">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="brand">Connect</StatusBadge>
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
          Connect your agent
        </h3>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-[var(--v2-ink-2)]">
        Pick where your agent runs and copy the configuration. Once it has the
        credentials it can start making payments within the rules you just set.
      </p>

      {/* Runtime tiles */}
      <div
        className="mt-4 flex flex-wrap items-center gap-2"
        role="tablist"
        aria-label="Agent runtime"
      >
        {snippets.map((s) => {
          const isActive = s.id === activeId
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveId(s.id)}
              className={
                'rounded-[6px] border px-3 h-8 text-[13px] font-medium transition-colors ' +
                (isActive
                  ? 'border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] text-[var(--v2-brand-strong)]'
                  : 'border-[var(--v2-border)] bg-white text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface)]')
              }
            >
              {s.label}
            </button>
          )
        })}
      </div>

      {/* Empty prompt */}
      {!active && (
        <p
          className="mt-3 text-[12px] text-[var(--v2-ink-3)]"
          aria-live="polite"
        >
          Select a runtime above to see the setup instructions.
        </p>
      )}

      {/* Active snippet */}
      {active && (
        <div
          key={`${active.id}:${mode}`}
          className="v2-animate-step-rise mt-4 space-y-3"
        >
          {/* Guidance + mode toggle */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="text-[12px] leading-relaxed text-[var(--v2-ink-2)] max-w-prose">
              {active.guidance}
            </p>
            <div
              className="inline-flex shrink-0 items-center gap-0.5 rounded-[8px] border border-[var(--v2-border)] bg-white p-0.5 text-[12px]"
              role="group"
              aria-label="Credential format"
            >
              <ModeToggleButton
                label="Inline"
                isActive={mode === 'inline'}
                onClick={() => setMode('inline')}
              />
              <ModeToggleButton
                label="Use a file"
                isActive={mode === 'file'}
                onClick={() => setMode('file')}
              />
            </div>
          </div>

          {/* Code block — uses the design system CodeBlock (dark surface) */}
          <CodeBlock
            language={active.language}
            filename={active.destination}
            onCopy={() => handleCopy(active)}
            onCopyFailed={() => handleCopyFailed(active)}
          >
            {active.code}
          </CodeBlock>

          {copyError === active.id && (
            <p
              role="alert"
              className="text-xs leading-relaxed text-[var(--v2-danger)]"
            >
              Couldn’t copy automatically — select the snippet above and copy it
              by hand. The “credentials saved” step won’t unlock until the copy
              succeeds.
            </p>
          )}

          {/* Credential format note */}
          <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
            {mode === 'inline'
              ? 'Credentials are embedded in the snippet — paste once and you\'re done. Your agent budget still caps what it can spend.'
              : 'The snippet references your saved credential file by path. No secret is stored in the configuration.'}
          </p>

          {/* File-mode permission hint — the file holds a private key */}
          {mode === 'file' && (
            <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
              After saving, restrict the file to your user:
              {' '}
              <span className="font-mono text-[var(--v2-ink-2)]">chmod 600</span>
              {' '}
              on macOS/Linux, or <span className="font-mono text-[var(--v2-ink-2)]">icacls</span>
              {' '}
              with <span className="font-mono text-[var(--v2-ink-2)]">/inheritance:r</span> on
              Windows. Avoid cloud-synced folders.
            </p>
          )}

          {/* Consent gate note — only for MCP-based runtimes */}
          {active.consentNote && (
            <div className="rounded-[8px] border border-[var(--v2-warning)]/25 bg-[var(--v2-warning-soft)] px-3 py-2.5">
              <p className="text-xs font-medium text-[var(--v2-warning)]">
                One-time setup required
              </p>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-xs leading-relaxed text-[var(--v2-warning)]">
                {active.consentNote}
              </pre>
            </div>
          )}

          {/* Try it — Card.Section inset for secondary context */}
          <Card.Section inset className="py-3">
            <p className="text-xs font-medium text-[var(--v2-ink-3)] uppercase tracking-tight">
              Try it
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
              {tryItPrompt}
            </p>
          </Card.Section>
        </div>
      )}
    </Card>
  )
}

function ModeToggleButton({
  label,
  isActive,
  onClick,
}: {
  label: string
  isActive: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={onClick}
      className={
        'rounded-[6px] px-2.5 h-7 text-[12px] font-medium transition-colors ' +
        (isActive
          ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand-strong)]'
          : 'text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface)]')
      }
    >
      {label}
    </button>
  )
}
