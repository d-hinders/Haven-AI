'use client'

import { useCallback, useMemo, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Button } from '@/components/ui/Button'
import type { AgentCredentialJson } from '@/lib/agent-credential'
import {
  HOSTED_CLIENT_OPTIONS,
  buildHostedConnectSnippet,
  resolveHostedMcpUrl,
  type HostedClientId,
  type HostedClientOption,
} from '@/lib/hosted-connect'

/**
 * Hosted Connect card — the redesigned Done-step surface (#187).
 *
 * Replaces `RuntimeConnectCard` for the hosted-MCP world. Renders a header,
 * a client picker, and (once a client is picked) the two-credential split:
 *
 *   1 · Connect            ←  remote URL + Bearer token, sent to Haven
 *   2 · Signing key 🔒     ←  delegate key, stays on the user's machine
 *
 * The split is the whole point: by separating the connect token (identity)
 * from the signing key (authority) in the UI, the non-custodial model is
 * legible. Haven receives the first; it never receives the second.
 *
 * Per-client deep links / one-click "Add to Cursor" / SDK code blocks land in
 * #188 — this PR ships the structural redesign with a working `claude mcp add`
 * / JSON MCP config / SDK env snippet per client.
 *
 * Live "Connected · last seen" is #189 (uses backend `last_seen_at` from #185).
 */

export interface HostedConnectCardProps {
  credential: AgentCredentialJson
  /**
   * Hosted MCP base URL. Resolves from `NEXT_PUBLIC_HAVEN_MCP_URL` env, with a
   * production fallback. The deploy runbook (`docs/deploy/hosted-mcp.md`)
   * covers when this would be a Railway URL vs `mcp.haven.ai`.
   */
  hostedUrl?: string
  /**
   * Trigger the "save signing key" action — the modal already owns the
   * download/copy mechanics for the credential JSON (which carries the
   * delegate key). Called when the user clicks Save or Copy in box 2.
   */
  onSaveSigningKey: () => void
  onCopySigningKey?: () => void
  /**
   * Fired whenever the user copies the box-1 connect snippet or saves the
   * signing key. The modal listens to this to flip its "credentials saved"
   * gate that backstops `handleClose`.
   */
  onCredentialSaved?: () => void
  /** Whether the signing key has been saved/copied already (UI affordance). */
  signingKeySaved?: boolean
  /** Suggested first-prompt copy shown beneath the snippet area. */
  tryItPrompt?: string
}

const DEFAULT_TRY_IT_PROMPT = "Ask your agent: “What's my Haven budget?”"

export function HostedConnectCard({
  credential,
  hostedUrl,
  onSaveSigningKey,
  onCopySigningKey,
  onCredentialSaved,
  signingKeySaved = false,
  tryItPrompt = DEFAULT_TRY_IT_PROMPT,
}: HostedConnectCardProps) {
  const resolvedUrl = useMemo(() => resolveHostedMcpUrl(hostedUrl), [hostedUrl])

  const [activeId, setActiveId] = useState<HostedClientId | null>(null)
  const [copiedConnect, setCopiedConnect] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)

  const active = useMemo<HostedClientOption | null>(
    () => HOSTED_CLIENT_OPTIONS.find((c) => c.id === activeId) ?? null,
    [activeId],
  )

  const snippet = useMemo(
    () => (activeId ? buildHostedConnectSnippet(activeId, credential, resolvedUrl) : null),
    [activeId, credential, resolvedUrl],
  )

  const handleCopyConnect = useCallback(async () => {
    if (!snippet) return
    try {
      await navigator.clipboard.writeText(snippet.code)
    } catch {
      /* clipboard can fail in restricted contexts — selection still works */
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

  return (
    <Card hover={false} elevation="anchor" className="p-5">
      <div className="flex items-start gap-2">
        <StatusBadge tone="brand">Connect</StatusBadge>
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
          Connect {credential.agent_name} to where it runs
        </h3>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--v2-ink-2)]">
        Pick the app your agent runs in. The connection token goes to Haven; the signing key
        never does.
      </p>

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
              onClick={() => setActiveId(option.id)}
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

      {active && snippet && (
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
                talk to Haven — it can&rsquo;t move money on its own.
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--v2-ink-3)]">
                {snippet.guidance}
              </p>

              <div className="mt-3 overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-3 py-1.5">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">
                    {snippet.language}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleCopyConnect()}
                  >
                    {copiedConnect ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <pre className="overflow-x-auto px-3 py-2 text-[12px] leading-snug text-[var(--v2-ink)]">
                  <code>{snippet.code}</code>
                </pre>
              </div>
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
                Saves the key your agent signs with. Haven never receives it — your budget caps
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
