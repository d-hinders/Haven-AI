'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Button } from '@/components/ui/Button'
import type { AgentCredentialJson } from '@/lib/agent-credential'
import {
  HOSTED_CLIENT_REGISTRY,
  buildHostedConnectSnippet,
  buildDeepLink,
  hasDeepLink,
  DEEP_LINK_LABEL,
  resolveHostedMcpUrl,
  probeHostedConnection,
  type HostedClientId,
  type HostedClientOption,
  type HostedConnectSnippet,
  type ProbeResult,
  type ProbeStatus,
} from '@/lib/hosted-connect'

/**
 * Hosted Connect card — the Done-step surface for the Create Agent flow.
 *
 * Layout:
 *   - Header: status badge + agent name
 *   - Tile grid: pick the runtime your agent runs in
 *   - 1 · Connect section (revealed when a tile is picked):
 *       · destination-path block with copy-path button
 *       · code block with copy-snippet button
 *       · post-note (e.g. "restart Claude Code")
 *       · Test connection button + result chip
 *   - 2 · Signing key section (delegate key stays on the user's machine)
 *
 * Custody invariant: the delegate private key never appears in the card body
 * apart from the explicit Signing-key save/copy controls in section 2.
 */

/** Format a timestamp into a human-readable "X ago" string. */
function formatRelativeTime(isoTs: string): string {
  const d = new Date(isoTs)
  // Guard: invalid ISO string → getTime() returns NaN → all comparisons are false
  // → would produce "NaNd ago" without this check.
  if (isNaN(d.getTime())) return 'just now'
  const diffMs = Date.now() - d.getTime()
  // Guard: server clock slightly ahead of client → negative diff.
  if (diffMs < 0) return 'just now'
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
  // Test-connection probe state. `pending` is the in-flight state; a fresh
  // `null` is shown either at first paint or after the user re-picks a client.
  const [probeState, setProbeState] = useState<
    { status: 'pending' } | (ProbeResult & { status: ProbeStatus }) | null
  >(null)
  // When connected, setup steps are collapsed; user can re-open them.
  const [showSetupSteps, setShowSetupSteps] = useState(!isConnected)
  useEffect(() => {
    if (isConnected) setShowSetupSteps(false)
  }, [isConnected])

  const active = useMemo<HostedClientOption | null>(
    () => HOSTED_CLIENT_REGISTRY.find((c) => c.id === activeId) ?? null,
    [activeId],
  )

  const snippet = useMemo(
    () => (activeId ? buildHostedConnectSnippet(activeId, credential, resolvedUrl) : null),
    [activeId, credential, resolvedUrl],
  )

  // Reset the fallback toggle + probe result whenever the user picks a
  // different client — the probe is per-bearer, but the visual association
  // is with the active client card, so a stale chip would be misleading.
  const handlePickClient = useCallback((id: HostedClientId) => {
    setActiveId(id)
    setShowConfigFallback(false)
    setProbeState(null)
  }, [])

  const handleTestConnection = useCallback(async () => {
    setProbeState({ status: 'pending' })
    const result = await probeHostedConnection(credential.api_key, resolvedUrl)
    setProbeState(result)
  }, [credential.api_key, resolvedUrl])

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
        {/* Re-expand toggle when connected */}
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

      {/* Connected banner */}
      {isConnected && lastSeenAt && (
        <div
          className="mt-3 flex items-center gap-2 rounded-[10px] border border-[var(--v2-success)]/25 bg-[var(--v2-success-soft)] px-3 py-2"
          role="status"
          aria-label="Agent connected"
        >
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-[var(--v2-success)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[12px] font-medium text-[var(--v2-success)]">
            Connected &middot; last seen {formatRelativeTime(lastSeenAt)}
          </span>
        </div>
      )}

      {/* "Try it" prompt when connected + steps collapsed */}
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

          {/* Tile grid — 3 cols on sm+, 2 cols below. Tiles are toggle buttons,
              not nested Cards (Haven UX guideline: tinted surfaces are reserved
              for callouts/chips/code-blocks, not for grouping inside a Card). */}
          <div
            className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3"
            role="tablist"
            aria-label="Connect target"
          >
            {HOSTED_CLIENT_REGISTRY.map((option) => (
              <RuntimeTile
                key={option.id}
                option={option}
                active={option.id === activeId}
                onPick={() => handlePickClient(option.id)}
              />
            ))}
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
                {active.tagline && (
                  <span className="text-[11px] text-[var(--v2-ink-3)]">{active.tagline}</span>
                )}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
                Adds Haven&rsquo;s hosted tools to {active.label}. This token only lets your agent
                talk to Haven &mdash; it can&rsquo;t move money on its own.
              </p>

              {/* Deep-link clients: primary button + collapsible config fallback.
                  Others fall through to the inline destination + snippet pair. */}
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
                    <ManualConfigBlock
                      snippet={snippet}
                      copied={copiedConnect}
                      onCopy={() => void handleCopyConnect()}
                    />
                  )}
                </div>
              ) : (
                <ManualConfigBlock
                  snippet={snippet}
                  copied={copiedConnect}
                  onCopy={() => void handleCopyConnect()}
                />
              )}

              {/* Test connection — browser-side probe against the hosted MCP
                  endpoint. Surfaces 401/network/CORS in-modal instead of
                  waiting for the never-arriving "Connected" banner. */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleTestConnection()}
                  disabled={probeState?.status === 'pending'}
                  aria-label="Test connection"
                >
                  {probeState?.status === 'pending' ? 'Testing…' : 'Test connection'}
                </Button>
                {probeState && probeState.status !== 'pending' && (
                  <ProbeResultChip result={probeState} />
                )}
              </div>
              {probeState && probeState.status !== 'pending' && probeState.detail && (
                <p
                  role="status"
                  className={
                    'mt-1.5 text-[11px] leading-relaxed ' +
                    (probeState.status === 'ok'
                      ? 'text-[var(--v2-success)]'
                      : 'text-[var(--v2-ink-3)]')
                  }
                >
                  {probeState.detail}
                </p>
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

/**
 * A single runtime tile. Acts as a toggle button — does not render as a
 * nested filled Card (Haven UX guideline). The selected state uses
 * brand-soft for clear differentiation; the chip-style is reserved for the
 * one-click ⚡ badge which sits inside the tile.
 */
function RuntimeTile({
  option,
  active,
  onPick,
}: {
  option: HostedClientOption
  active: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onPick}
      className={
        'group flex h-full min-h-[68px] flex-col items-start justify-between gap-2 rounded-[10px] border px-3 py-2.5 text-left transition-colors ' +
        (active
          ? 'border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] text-[var(--v2-brand-strong)]'
          : 'border-[var(--v2-border)] bg-white text-[var(--v2-ink)] hover:border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)]')
      }
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="text-[13px] font-semibold leading-tight">{option.label}</span>
        {option.oneClick && <OneClickChip active={active} />}
      </div>
      {option.tagline && (
        <span
          className={
            'text-[11px] leading-tight ' +
            (active ? 'text-[var(--v2-brand-strong)]/70' : 'text-[var(--v2-ink-3)]')
          }
        >
          {option.tagline}
        </span>
      )}
    </button>
  )
}

function OneClickChip({ active }: { active: boolean }) {
  return (
    <span
      aria-label="one-click install"
      className={
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ' +
        (active
          ? 'bg-white/70 text-[var(--v2-brand-strong)]'
          : 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand-strong)]')
      }
    >
      <svg
        aria-hidden="true"
        className="h-2.5 w-2.5"
        viewBox="0 0 24 24"
        fill="currentColor"
        strokeLinejoin="round"
      >
        <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
      </svg>
      1-click
    </span>
  )
}

/**
 * The "manual config" pair: destination-path block above + code block below.
 * Used for non-one-click runtimes, and inside the "Didn't work? Show config"
 * fallback for one-click runtimes too.
 */
function ManualConfigBlock({
  snippet,
  copied,
  onCopy,
}: {
  snippet: HostedConnectSnippet
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="mt-3 space-y-2.5">
      <p className="text-[12px] leading-relaxed text-[var(--v2-ink-3)]">{snippet.guidance}</p>
      {snippet.destinationPaths && snippet.destinationPaths.length > 0 && (
        <DestinationPathBlock paths={snippet.destinationPaths} />
      )}
      <ConnectCodeBlock snippet={snippet} copied={copied} onCopy={onCopy} />
      {snippet.postNote && (
        <p className="text-[12px] leading-relaxed text-[var(--v2-ink-2)]">{snippet.postNote}</p>
      )}
    </div>
  )
}

/**
 * Prominent destination-path block. Renders the file path(s) where the
 * snippet should be saved, each with a Copy-path button so the user can
 * navigate straight to the file without having to read the snippet to
 * figure out where it goes.
 *
 * Single-path runtimes (e.g. Cursor) render as one row with a folder
 * marker. Multi-path runtimes (Claude Desktop OS variants, VS Code
 * workspace vs user) render as a labelled row list.
 */
function DestinationPathBlock({ paths }: { paths: { label: string; path: string }[] }) {
  const isMulti = paths.length > 1

  return (
    <div
      className="overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-white"
      aria-label="Where to save"
    >
      <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">
          {isMulti ? 'Save to one of' : 'Save to'}
        </span>
      </div>
      <ul className="divide-y divide-[var(--v2-border)]">
        {paths.map((p) => (
          <DestinationPathRow key={`${p.label}-${p.path}`} path={p} showLabel={isMulti} />
        ))}
      </ul>
    </div>
  )
}

function DestinationPathRow({
  path,
  showLabel,
}: {
  path: { label: string; path: string }
  showLabel: boolean
}) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path.path)
    } catch {
      /* clipboard can fail in restricted contexts */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [path.path])

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--v2-ink-3)]" />
      <div className="flex min-w-0 flex-1 flex-col">
        {showLabel && (
          <span className="text-[11px] font-medium text-[var(--v2-ink-2)]">{path.label}</span>
        )}
        <code className="overflow-x-auto whitespace-nowrap font-mono text-[12px] leading-snug text-[var(--v2-ink)]">
          {path.path}
        </code>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleCopy()}
        aria-label={`Copy ${path.label} path`}
      >
        {copied ? 'Copied' : 'Copy path'}
      </Button>
    </li>
  )
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  )
}

function ProbeResultChip({ result }: { result: ProbeResult }) {
  // Tones reuse the defined v2-* tokens. `*-strong` isn't a defined token, so
  // we use the base `--v2-success` / `--v2-warning` / `--v2-danger` colors
  // (which all have AA contrast against the `-soft` backgrounds).
  const tone =
    result.status === 'ok'
      ? { bg: 'bg-[var(--v2-success-soft)]', fg: 'text-[var(--v2-success)]', label: 'Connected' }
      : result.status === 'unauthorized'
        ? { bg: 'bg-[var(--v2-danger-soft)]', fg: 'text-[var(--v2-danger)]', label: 'Token rejected' }
        : result.status === 'network-error'
          ? { bg: 'bg-[var(--v2-warning-soft)]', fg: 'text-[var(--v2-warning)]', label: "Couldn't reach" }
          : { bg: 'bg-[var(--v2-warning-soft)]', fg: 'text-[var(--v2-warning)]', label: 'Unexpected response' }

  return (
    <span
      role="status"
      aria-label={`Test connection result: ${tone.label}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone.bg} ${tone.fg}`}
    >
      {tone.label}
      {result.status === 'ok' && typeof result.toolCount === 'number' ? ` · ${result.toolCount} tools` : null}
    </span>
  )
}

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
    <div className="overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">
          {snippet.language}
        </span>
        <Button variant="ghost" size="sm" onClick={onCopy} aria-label="Copy snippet">
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-[12px] leading-snug text-[var(--v2-ink)]">
        <code>{snippet.code}</code>
      </pre>
    </div>
  )
}
