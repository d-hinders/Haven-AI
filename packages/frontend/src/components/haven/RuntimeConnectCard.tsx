'use client'

import { useCallback, useMemo, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Button } from '@/components/ui/Button'
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

const DEFAULT_TRY_IT_PROMPT = "Ask your agent: “What's my Haven budget?”"

export function RuntimeConnectCard({
  credential,
  credentialFilePath,
  onSnippetCopied,
  tryItPrompt = DEFAULT_TRY_IT_PROMPT,
}: RuntimeConnectCardProps) {
  // Lands with nothing selected. The first click reveals the code block.
  const [activeId, setActiveId] = useState<RuntimeSnippetId | null>(null)
  const [mode, setMode] = useState<RuntimeSnippetMode>('inline')
  const [copiedId, setCopiedId] = useState<RuntimeSnippetId | null>(null)

  const snippets = useMemo(
    () => buildRuntimeSnippets({ credential, credentialFilePath }, mode),
    [credential, credentialFilePath, mode],
  )
  const active = activeId ? snippets.find((s) => s.id === activeId) ?? null : null

  const handleCopy = useCallback(
    async (snippet: RuntimeSnippet) => {
      try {
        await navigator.clipboard.writeText(snippet.code)
      } catch {
        /* Clipboard can fail in restricted contexts. Treat as a no-op rather
         * than blocking the modal — the user can still select the code by
         * hand from the visible <pre> block. */
      }
      setCopiedId(snippet.id)
      setTimeout(() => setCopiedId((id) => (id === snippet.id ? null : id)), 2000)
      onSnippetCopied?.(snippet)
    },
    [onSnippetCopied],
  )

  return (
    <Card hover={false} className="p-4" elevation="anchor">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="brand">Connect</StatusBadge>
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
              Add these payment credentials to your agent
            </h3>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            Pick where your agent lives and copy the credentials. Once your agent has them,
            it can start making payments within the rules you just set.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Agent connection options">
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
                'rounded-[10px] border px-3 h-9 text-[13px] font-medium transition-colors ' +
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

      {!active && (
        <p
          className="mt-3 text-[12px] italic leading-relaxed text-[var(--v2-ink-3)]"
          aria-live="polite"
        >
          Pick one above to see the credentials.
        </p>
      )}

      {active && (
        <div
          key={`${active.id}:${mode}`}
          className="v2-animate-step-rise mt-4 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
              {active.guidance}
              {active.destination && (
                <>
                  {' '}<span className="font-mono text-[var(--v2-ink-2)]">{active.destination}</span>
                </>
              )}
            </div>
            <div className="inline-flex items-center gap-1 rounded-[10px] border border-[var(--v2-border)] bg-white p-1 text-[12px]">
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

          <div className="overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)]">
            <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-3 py-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">
                {active.language}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleCopy(active)}
              >
                {copiedId === active.id ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre className="overflow-x-auto px-3 py-2 text-[12px] leading-snug text-[var(--v2-ink)]">
              <code>{active.code}</code>
            </pre>
          </div>

          {mode === 'inline' && (
            <p className="text-[11px] leading-relaxed text-[var(--v2-ink-3)]">
              The credentials are right there in the snippet — copy it once and you’re done.
              Your budget still caps what the agent can spend, and you can revoke it in Haven
              anytime.
            </p>
          )}
          {mode === 'file' && (
            <p className="text-[11px] leading-relaxed text-[var(--v2-ink-3)]">
              The credentials live in a separate file you save. The snippet only references that
              file by path — no secret in the snippet itself.
            </p>
          )}

          <div className="rounded-[10px] border border-dashed border-[var(--v2-border)] bg-white p-3">
            <div className="text-[12px] font-medium text-[var(--v2-ink)]">Try it</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
              {tryItPrompt}
            </div>
          </div>
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
        'rounded-[6px] px-2 h-7 transition-colors ' +
        (isActive
          ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand-strong)]'
          : 'text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface)]')
      }
    >
      {label}
    </button>
  )
}
