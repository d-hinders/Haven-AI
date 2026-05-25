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
 * Tile-style tabs for each supported agent runtime. Each tile shows a single
 * copy-pasteable snippet. Two modes per tile:
 *
 *   - Inline (default): the snippet embeds the credential env vars directly.
 *     No file for the user to manage. Demo-friendly: copy → paste → restart.
 *   - With credential file: snippet references the downloaded credential JSON
 *     by absolute path. Used in production-ish setups where the secret lives
 *     in a managed location on disk.
 *
 * The card never displays the secret outside the snippet body — there is no
 * standalone "your secret is X" line. Secrets only appear where they are
 * actionable (inside the code block), which keeps the surface honest and
 * keeps copy-everything-to-clipboard a deliberate action.
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
   * has the credential outside this once-only view.
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
  const [activeId, setActiveId] = useState<RuntimeSnippetId>('claude-desktop')
  const [mode, setMode] = useState<RuntimeSnippetMode>('inline')
  const [copiedId, setCopiedId] = useState<RuntimeSnippetId | null>(null)

  const snippets = useMemo(
    () => buildRuntimeSnippets({ credential, credentialFilePath }, mode),
    [credential, credentialFilePath, mode],
  )
  const active = snippets.find((s) => s.id === activeId) ?? snippets[0]

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
              Add this agent to your runtime
            </h3>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            Pick where the agent will run. Copy the snippet, paste it into that runtime's config,
            and the agent can start using its Haven budget right away.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Agent runtimes">
        {snippets.map((s) => {
          const isActive = s.id === active.id
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
        <div className="ml-auto inline-flex items-center gap-1 rounded-[10px] border border-[var(--v2-border)] bg-white p-1 text-[12px]">
          <ModeToggleButton
            label="Inline"
            isActive={mode === 'inline'}
            onClick={() => setMode('inline')}
          />
          <ModeToggleButton
            label="With credential file"
            isActive={mode === 'file'}
            onClick={() => setMode('file')}
          />
        </div>
      </div>

      <div className="mt-3 text-xs leading-relaxed text-[var(--v2-ink-3)]">
        {active.guidance}
        {active.destination && (
          <>
            {' '}<span className="font-mono text-[var(--v2-ink-2)]">{active.destination}</span>
          </>
        )}
      </div>

      <div className="mt-2 overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)]">
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
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--v2-ink-3)]">
          This snippet contains the agent’s secret. The secret authenticates the agent;
          the on-chain Safe AllowanceModule still caps what it can spend. You can revoke this
          agent from Haven at any time.
        </p>
      )}
      {mode === 'file' && (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--v2-ink-3)]">
          Save the credential JSON to a private path on the machine that runs the agent, then
          point this snippet at that path. The agent runtime config holds no secret.
        </p>
      )}

      <div className="mt-4 rounded-[10px] border border-dashed border-[var(--v2-border)] bg-white p-3">
        <div className="text-[12px] font-medium text-[var(--v2-ink)]">Try it</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
          {tryItPrompt}
        </div>
      </div>
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
