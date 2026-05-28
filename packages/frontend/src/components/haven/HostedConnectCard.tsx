'use client'

import { useCallback, useMemo, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Button } from '@/components/ui/Button'
import type { AgentCredentialJson } from '@/lib/agent-credential'
import {
  HOSTED_CLIENT_OPTIONS,
  buildHostedConnectSnippet,
  buildDeepLink,
  hasDeepLink,
  DEEP_LINK_LABEL,
  resolveHostedMcpUrl,
  type HostedClientId,
  type HostedClientOption,
} from '@/lib/hosted-connect'

/**
 * Hosted Connect card — the redesigned Done-step surface (#187, #188, #189).
 *
 * Replaces `RuntimeConnectCard` for the hosted-MCP world. Renders a header,
 * a client picker, and (once a client is picked) the two-credential split:
 *
 *   1 · Connect            ←  remote URL + Bearer token, sent to Haven
 *   2 · Signing key 🔒     ←  delegate key, stays on the user's machine
 *
 * #188 additions:
 *   - Claude Desktop / Cursor: primary "Add to [App]" deep-link button
 *     + collapsible config fallback for manual placement.
 *   - Other / SDK: advanced disclosure (<details>) that exposes the
 *     local-server env-var and SDK snippet for power users.
 *
 * #189 additions:
 *   - `lastSeenAt` prop — when non-null, renders a green "Connected · last seen
 *     Xs ago" banner and collapses the setup steps. A toggle re-expands them.
 */

/** Format a timestamp into a human-readable "X ago" string. */
function formatRelativeTime(isoTs: string): string {
  const diffMs = Date.now() - new Date(isoTs).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return `${Math.floor(diffHr / 24)}d ago`
}

export interface HostedConnectCardProps {
  credential: AgentCredentialJson
  /**
   * Hosted MCP base URL. Resolves from `NEXT_PUBLIC_HAVEN_MCP_URL` env, with a
   * production fallback.
   */
  hostedUrl?: string
  /**
   * Trigger the "save signing key" action.
   * Called when the user clicks Save in box 2.
   */
  onSaveSigningKey: () => void
  onCopySigningKey?: () => void
  /**
   * Fired whenever the user copies the connect snippet or saves/copies the
   * signing key. The modal listens to flip its "credentials saved" gate.
   */
  onCredentialSaved?: () => void
  /** Whether the signing key has been saved/copied already (UI affordance). */
  signingKeySaved?: boolean
  /** Suggested first-prompt copy shown beneath the snippet area. */
  tryItPrompt?: string
  /**
   * ISO timestamp of the agent's most recent MCP tool call, supplied by the
   * parent via `useAgentLastSeen`. When non-null the card flips into a
   * "Connected" summary view and the setup steps are collapsed.
   */
  lastSeenAt?: string | null
}

const DEFAULT_TRY_IT_PROMPT = "Ask your agent: “What’s my Haven budget?”"

export function HostedConnectCard({
  credential,
  hostedUrl,
  onSaveSigningKey,
  onCopySigningKey,
  onCredentialSaved,
  signingKeySaved = false,
  tryItPrompt = DEFAULT_TRY_IT_PROMPT,
  lastSeenAt,
}: HostedConnectCardProps) {
  const resolvedUrl = useMemo(() => resolveHostedMcpUrl(hostedUrl), [hostedUrl])

  const isConnected = Boolean(lastSeenAt)

  const [activeId, setActiveId] = useState<HostedClientId | null>(null)
  const [copiedConnect, setCopiedConnect] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)
  // Per-client: whether the manual config fallback is expanded
  const [showConfigFallback, setShowConfigFallback] = useState(false)
  // #189: when connected, setup steps are collapsed; user can re-open them
  const [showSetupSteps, setShowSetupSteps] = useState(!isConnected)

  const active = useMemo<HostedClientOption | null>(
    () => HOSTED_CLIENT_OPTIONS.find((c) => c.id === activeId) ?? null,
    [activeId],
  )

  const snippet = useMemo(
    () => (activeId ? buildHostedConnectSnippet(activeId, credential, resolvedUrl) : null),
    [activeId, credential, resolvedUrl],
  )

  // Reset the fallback toggle whenever the user picks a different client.
  const handlePickClient = useCallback((id: HostedClientId) => {
    setActiveId(id)
    setShowConfigFallback(false)
  }, [])

  const handleCopyConnect = useCallback(async () => {
    if (!snippet) return
    try {
      await navigator.clipboard.writeText(snippet.code)
    } catch {
      /* clipboard can fail in restricted contexts */
    }
    setCopiedConnect(true)
    setTimeout(() => setCopiedConnect(false), 2000)
    onCredentialSaved?.()
  }, [snippet, onCredentialSaved])

  const handleCopyKey = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(credential.delegate_key)
    } catch {
      /* clipboard can fail */
    }
    setCopiedKey(true)
    setTimeout(() => setCopiedKey(false), 2000)
    onCopySigningKey?.()
    onCredentialSaved?.()
  }, [credential.delegate_key, onCopySigningKey, onCredentialSaved])

  const handleSaveKey = useCallback(() => {
    onSaveSigningKey()
    onCredentialSaved?.()
  }, [onSaveSigningKey, onCredentialSaved])

  const handleOpenDeepLink = useCallback(() => {
    if (!activeId || !hasDeepLink(activeId)) return
    const url = buildDeepLink(activeId, credential, resolvedUrl)
    window.open(url, '_self')
    onCredentialSaved?.()
  }, [activeId, credential, resolvedUrl, onCredentialSaved])

  return (
    <Card hover={false} elevation="anchor" className="p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          {isConnected ? (
            <StatusBadge tone="success">Connected</StatusBadge>
          ) : (
            <StatusBadge tone="brand">Connect</StatusBadge>
          )}
          <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
            Connect {credential.agent_name} to where it runs
          </h3>
        </div>
        {/* #189: re-expand toggle when connected */}
        {isConnected && (
          <button
            type="button"
            onClick={() => setShowSetupSteps((v) => !v)}
            className="shrink-0 text-[12px] text-[var(--v2-ink-3)] underline-offset-2 hover:text-[var(--v2-ink)] hover:underline"
            aria-label={showSetupSteps ? 'Hide setup steps' : 'Show setup steps'}
          >
            {showSetupSteps ? 'Hide setup' : 'Show setup'}
          </button>
        )}
      </div>

      {/* #189: Connected banner */}
      {isConnected && lastSeenAt && (
        <div
          className="mt-3 flex items-center gap-2 rounded-[10px] border border-[var(--v2-success)]/25 bg-[var(--v2-success-soft)] px-3 py-2"
          role="status"
          aria-label="Agent connected"
        >
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-[var(--v2-success-strong)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[12px] font-medium text-[var(--v2-success-strong)]">
            Connected &middot; last seen {formatRelativeTime(lastSeenAt)}
          </span>
        </div>
      )}

      {/* #189: "Try it" prompt when connected + steps collapsed */}
      {isConnected && !showSetupSteps && (
        <div className="mt-3 rounded-[10px] border border-dashed border-[var(--v2-border)] bg-white p-3">
          <div className="text-[12px] font-medium text-[var(--v2-ink)]">Try it</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
            {tryItPrompt}
          </div>
        </div>
      )}

      {(!isConnected || showSetupSteps) && (
        <>
          <p className="mt-1.5 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            Pick the app your agent runs in. The connection token goes to Haven; the signing key
            never does.
          </p>

          {/* Client picker */}
          <div
            className="mt-4 flex flex-wrap items-center gap-2"
            role="tablist"
            aria-label="Connect target"
          >
            {HOSTED_CLIENT_OPTIONS.map((option) => {
              const isActive = option.id === activeId
              return (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => handlePickClient(option.id)}
                  className={
                    'rounded-[10px] border px-3 h-9 text-[13px] font-medium transition-colors ' +
                    (isActive
                      ? 'border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] text-[var(--v2-brand-strong)]'
                      : 'border-[var(--v2-border)] bg-white text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface)]')
                  }
                >
                  {option.label}
                </button>
              )
            })}
          </div>

          {!active && (
            <p
              className="mt-3 text-[12px] italic leading-relaxed text-[var(--v2-ink-3)]"
              aria-live="polite"
            >
              Pick one above to see the connect steps.
            </p>
          )}
        </>
      )}

      {active && snippet && (!isConnected || showSetupSteps) && (
        <div key={active.id} className="v2-animate-step-rise mt-4 space-y-4">
          {/* ── 1 · Connect ───────────────────────────────────────────── */}
          <Card.Section>
            <div className="py-4">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--v2-brand-soft)] text-[11px] font-semibold text-[var(--v2-brand-strong)]">
                  1
                </span>
                <h4 className="text-[13px] font-semibold text-[var(--v2-ink)]">Connect</h4>
                {active.destination && (
                  <span className="text-[11px] text-[var(--v2-ink-3)]">{active.destination}</span>
                )}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
                Adds Haven&rsquo;s hosted tools to {active.label}. This token only lets your agent
                talk to Haven &mdash; it can&rsquo;t move money on its own.
              </p>

              {/* Deep-link clients: primary button + collapsible config fallback */}
              {hasDeepLink(active.id) ? (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={handleOpenDeepLink} aria-label={DEEP_LINK_LABEL[active.id]}>
                      {DEEP_LINK_LABEL[active.id]}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setShowConfigFallback((v) => !v)}
                      className="text-[12px] text-[var(--v2-ink-3)] underline-offset-2 hover:text-[var(--v2-ink)] hover:underline"
                    >
                      {showConfigFallback ? 'Hide config' : "Didn't work? Show config"}
                    </button>
                  </div>

                  {showConfigFallback && (
                    <div>
                      <p className="text-[12px] leading-relaxed text-[var(--v2-ink-3)]">
                        {snippet.guidance}
                      </p>
                      <ConnectCodeBlock
                        snippet={snippet}
                        copied={copiedConnect}
                        onCopy={() => void handleCopyConnect()}
                      />
                    </div>
                  )}
                </div>
              ) : (
                /* Claude Code / Other: show the command block directly */
                <div className="mt-3">
                  <p className="text-[12px] leading-relaxed text-[var(--v2-ink-3)]">
                    {snippet.guidance}
                  </p>
                  <ConnectCodeBlock
                    snippet={snippet}
                    copied={copiedConnect}
                    onCopy={() => void handleCopyConnect()}
                  />
                </div>
              )}

              {/* Other / SDK: advanced disclosure for local-server path */}
              {active.id === 'other' && (
                <details className="mt-3 group">
                  <summary className="cursor-pointer list-none text-[12px] font-medium text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] flex items-center gap-1">
                    <svg
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Self-hosted / local server (advanced)
                  </summary>
                  <div className="mt-2 rounded-[8px] border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
                    <p>
                      Use <code className="text-[11px] font-mono">npx -y @haven_ai/mcp</code> with{' '}
                      <code className="text-[11px] font-mono">HAVEN_API_KEY</code> +{' '}
                      <code className="text-[11px] font-mono">HAVEN_DELEGATE_KEY</code> for a local
                      stdio server — no hosted URL needed. See the{' '}
                      <a
                        href="https://www.npmjs.com/package/@haven_ai/mcp"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--v2-brand)] underline underline-offset-2"
                      >
                        @haven_ai/mcp docs
                      </a>{' '}
                      for the full env-var reference.
                    </p>
                    <p className="mt-1.5 text-[var(--v2-ink-3)]">
                      With the local server your delegate key sits in the config file rather than in
                      a separate signing process. Use the hosted path above for lower key exposure.
                    </p>
                  </div>
                </details>
              )}
            </div>
          </Card.Section>

          {/* ── 2 · Signing key ──────────────────────────────────────── */}
          <Card.Section>
            <div className="py-4">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--v2-brand-soft)] text-[11px] font-semibold text-[var(--v2-brand-strong)]">
                  2
                </span>
                <h4 className="text-[13px] font-semibold text-[var(--v2-ink)]">Signing key</h4>
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--v2-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--v2-ink-2)]">
                  <svg
                    aria-hidden="true"
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <rect x="4" y="11" width="16" height="9" rx="2" />
                    <path d="M8 11V8a4 4 0 1 1 8 0v3" strokeLinecap="round" />
                  </svg>
                  stays on your machine
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
                Saves the key your agent signs with. Haven never receives it &mdash; your budget caps
                it either way.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button onClick={handleSaveKey}>
                  {signingKeySaved ? 'Saved · Save again' : 'Save signing key'}
                </Button>
                <Button variant="ghost" onClick={() => void handleCopyKey()}>
                  {copiedKey ? 'Copied' : 'Copy'}
                </Button>
                <span className="ml-1 text-[11px] text-[var(--v2-ink-3)]">
                  Shown once. Haven can&rsquo;t show it again.
                </span>
              </div>
            </div>
          </Card.Section>

          {/* Try it */}
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

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ConnectCodeBlock({
  snippet,
  copied,
  onCopy,
}: {
  snippet: { language: string; code: string }
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="mt-2 overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">
          {snippet.language}
        </span>
        <Button variant="ghost" size="sm" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-[12px] leading-snug text-[var(--v2-ink)]">
        <code>{snippet.code}</code>
      </pre>
    </div>
  )
}
