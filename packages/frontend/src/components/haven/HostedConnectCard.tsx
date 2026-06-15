'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useCopyTimeout } from '@/hooks/useCopyTimeout'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Button } from '@/components/ui/Button'
import type { AgentCredentialJson } from '@/lib/agent-credential'
import {
  HOSTED_CLIENT_REGISTRY,
  buildHostedConnectSnippet,
  buildHostedSetupPrompt,
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
 *   - Recommended path: copy setup prompt (revealed when a tile is picked)
 *   - Optional fallback: manual setup disclosure:
 *       · destination-path block with copy-path button
 *       · code block with copy-snippet button
 *       · post-note (e.g. "restart Claude Code")
 *       · Signing key copy for manual setup
 *   - Test connection button beside the recommended handoff path
 *
 * Custody invariant: the delegate private key never appears in the card body
 * until the user explicitly expands manual setup.
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
   * Optional callback fired when the user copies the delegate key from
   * section 2. The parent uses it for analytics and "credentials saved"
   * gating.
   */
  onCopySigningKey?: () => void
  /**
   * Fired whenever the user copies the connect snippet OR the signing
   * key. The modal listens to flip its "credentials saved" gate so the
   * Done button unlocks once at least one credential-bearing action has
   * happened.
   */
  onCredentialSaved?: () => void
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
  onCopySigningKey,
  onCredentialSaved,
  tryItPrompt = DEFAULT_TRY_IT_PROMPT,
  lastSeenAt,
}: HostedConnectCardProps) {
  const resolvedUrl = useMemo(() => resolveHostedMcpUrl(hostedUrl), [hostedUrl])

  const isConnected = Boolean(lastSeenAt)

  const [activeId, setActiveId] = useState<HostedClientId | null>(null)
  const { copied: copiedConnect, markCopied: markCopiedConnect } = useCopyTimeout(2000)
  const { copied: copiedKey, markCopied: markCopiedKey } = useCopyTimeout(2000)
  const { copied: copiedSetupPrompt, markCopied: markCopiedSetupPrompt } = useCopyTimeout(2000)
  const [copyError, setCopyError] = useState<string | null>(null)
  // The manual setup disclosure uses React state so secret-bearing content is
  // genuinely absent from the DOM until the user asks for it.
  const [showManualSetup, setShowManualSetup] = useState(false)
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
  const setupPrompt = useMemo(
    () => (activeId ? buildHostedSetupPrompt(activeId, credential, resolvedUrl) : null),
    [activeId, credential, resolvedUrl],
  )

  // Reset the fallback toggle + probe result whenever the user picks a
  // different client — the probe is per-bearer, but the visual association
  // is with the active client card, so a stale chip would be misleading.
  // Also collapse manual setup so secret-bearing content unmounts across
  // runtime switches.
  const handlePickClient = useCallback((id: HostedClientId) => {
    setActiveId(id)
    setShowManualSetup(false)
    setShowConfigFallback(false)
    setProbeState(null)
    setCopyError(null)
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
      setCopyError('Could not copy. Check clipboard permission and try again.')
      return
    }
    setCopyError(null)
    markCopiedConnect()
  }, [snippet, markCopiedConnect])

  const handleCopyKey = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(credential.delegate_key)
    } catch {
      setCopyError('Could not copy the signing key. Check clipboard permission and try again.')
      return
    }
    setCopyError(null)
    markCopiedKey()
    onCopySigningKey?.()
    onCredentialSaved?.()
  }, [credential.delegate_key, markCopiedKey, onCopySigningKey, onCredentialSaved])

  const handleCopySetupPrompt = useCallback(async () => {
    if (!setupPrompt) return
    try {
      await navigator.clipboard.writeText(setupPrompt)
    } catch {
      setCopyError('Could not copy the setup prompt. Check clipboard permission and try again.')
      return
    }
    setCopyError(null)
    markCopiedSetupPrompt()
    // The setup prompt embeds both connection identity and the signing key,
    // so copying it counts as having the Haven credential in hand.
    onCopySigningKey?.()
    onCredentialSaved?.()
  }, [setupPrompt, markCopiedSetupPrompt, onCopySigningKey, onCredentialSaved])

  const handleOpenDeepLink = useCallback(() => {
    if (!activeId || !hasDeepLink(activeId)) return
    const url = buildDeepLink(activeId, credential, resolvedUrl)
    window.open(url, '_self')
  }, [activeId, credential, resolvedUrl])

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

      {/* "Try it" prompt when connected + steps collapsed — inline, quiet */}
      {isConnected && !showSetupSteps && (
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--v2-ink-3)]">
          <span className="font-medium text-[var(--v2-ink-2)]">Try it · </span>
          {tryItPrompt}
        </p>
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

      {active && snippet && setupPrompt && (
        <div key={active.id} className="v2-animate-step-rise mt-4 space-y-4">
          {/* ── Recommended path · Copy setup prompt ───────────────────
              The full prompt contains the connect token and signing key, so
              it is copied directly and never rendered in the card by default. */}
          {(!isConnected || showSetupSteps) && (
            <Card.Section>
              <div className="py-4">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusBadge tone="brand">Recommended</StatusBadge>
                  <h4 className="text-[13px] font-semibold text-[var(--v2-ink)]">
                    Copy setup prompt
                  </h4>
                  {active.tagline && (
                    <span className="text-xs text-[var(--v2-ink-3)]">{active.tagline}</span>
                  )}
                </div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
                  Copy one prompt into {active.label}. It asks the agent to connect your Haven
                  credential, keep the signing key local, and check the agent budget before
                  payments from your Haven wallet.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button onClick={() => void handleCopySetupPrompt()}>
                    {copiedSetupPrompt ? 'Copied' : 'Copy setup prompt'}
                  </Button>
                  <span className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
                    Paste only into an agent or workspace you trust.
                  </span>
                </div>

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
                  <span className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
                    Checks that Haven&rsquo;s tools can be reached with this credential.
                  </span>
                  {probeState && probeState.status !== 'pending' && (
                    <ProbeResultChip result={probeState} />
                  )}
                </div>
                {probeState && probeState.status !== 'pending' && probeState.detail && (
                  <p
                    role="status"
                    className={
                      'mt-1.5 text-xs leading-relaxed ' +
                      (probeState.status === 'ok'
                        ? 'text-[var(--v2-success)]'
                        : 'text-[var(--v2-ink-3)]')
                    }
                  >
                    {probeState.detail}
                  </p>
                )}
              </div>
            </Card.Section>
          )}

          {/* ── Optional fallback · Manual setup ─────────────────────── */}
          {(!isConnected || showSetupSteps) && (
            <Card.Section>
              <div className="py-4">
                <button
                  type="button"
                  onClick={() => setShowManualSetup((v) => !v)}
                  aria-expanded={showManualSetup}
                  className="flex w-full items-start justify-between gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 focus-visible:ring-offset-2"
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="inline-flex items-center rounded-full bg-[var(--v2-surface)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-2)]">
                        Optional
                      </span>
                      <span className="text-[13px] font-semibold text-[var(--v2-ink)]">
                        Manual setup
                      </span>
                    </span>
                    <span className="mt-1.5 block text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
                      Not needed if you use the setup prompt. Open this only if you want to add the
                      config yourself or copy only the signing key.
                    </span>
                  </span>
                  <svg
                    aria-hidden="true"
                    className={
                      'mt-1 h-3.5 w-3.5 shrink-0 text-[var(--v2-ink-3)] transition-transform ' +
                      (showManualSetup ? 'rotate-90' : '')
                    }
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {showManualSetup && (
                  <div className="mt-3 space-y-4">
                    {hasDeepLink(active.id) ? (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button onClick={handleOpenDeepLink} aria-label={DEEP_LINK_LABEL[active.id]}>
                            {DEEP_LINK_LABEL[active.id]}
                          </Button>
                          <button
                            type="button"
                            onClick={() => setShowConfigFallback((v) => !v)}
                            className="rounded-sm text-[12px] text-[var(--v2-ink-3)] underline-offset-2 hover:text-[var(--v2-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
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

                    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-3">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h5 className="text-[12px] font-semibold text-[var(--v2-ink)]">
                          Signing key
                        </h5>
                        <SigningKeyChip
                          icon={
                            <svg aria-hidden="true" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                              <rect x="4" y="11" width="16" height="9" rx="2" />
                              <path d="M8 11V8a4 4 0 1 1 8 0v3" strokeLinecap="round" />
                            </svg>
                          }
                        >
                          stays local
                        </SigningKeyChip>
                        <SigningKeyChip
                          icon={
                            <svg aria-hidden="true" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                              <path d="M5 12l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          }
                        >
                          follows agent rules
                        </SigningKeyChip>
                      </div>
                      <p className="mt-2 text-[12px] leading-relaxed text-[var(--v2-ink-2)]">
                        Copy this only if you are setting up manually. It lets the agent sign
                        payments locally, and the agent budget still limits what can be spent.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button onClick={() => void handleCopyKey()}>
                          {copiedKey ? 'Copied' : 'Copy signing key'}
                        </Button>
                        <span className="text-xs text-[var(--v2-ink-3)]">
                          Shown once. Full backup below.
                        </span>
                      </div>
                    </div>

                    {active.id === 'other' && (
                      <details className="group">
                        <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] font-medium text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]">
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
                            Use <code className="font-mono text-xs">npx -y @haven_ai/mcp</code> with{' '}
                            <code className="font-mono text-xs">HAVEN_API_KEY</code> +{' '}
                            <code className="font-mono text-xs">HAVEN_DELEGATE_KEY</code> for a local
                            stdio server with no hosted URL. See the{' '}
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
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </Card.Section>
          )}

          {copyError && (!isConnected || showSetupSteps) && (
            <p role="alert" className="text-[12px] leading-relaxed text-[var(--v2-danger)]">
              {copyError}
            </p>
          )}

          {/* Try-it hint — quiet inline tip, not a separate dashed card.
              Collapses with section 1 once the agent has connected. */}
          {(!isConnected || showSetupSteps) && (
            <p className="text-[12px] leading-relaxed text-[var(--v2-ink-3)]">
              <span className="font-medium text-[var(--v2-ink-2)]">Try it · </span>
              {tryItPrompt}
            </p>
          )}
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
        // `min-w-0` lets the tile shrink below its intrinsic content width so
        // long taglines can't blow out the grid column and force the modal
        // to scroll horizontally. The tagline span clips with ellipsis below.
        'group flex h-full min-h-[68px] min-w-0 flex-col items-start justify-between gap-2 rounded-[10px] border px-3 py-2.5 text-left transition-colors ' +
        (active
          ? 'border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] text-[var(--v2-brand-strong)]'
          : 'border-[var(--v2-border)] bg-white text-[var(--v2-ink)] hover:border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)]')
      }
    >
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <span className="truncate text-[13px] font-semibold leading-tight">{option.label}</span>
        {option.oneClick && <OneClickChip active={active} />}
      </div>
      {option.tagline && (
        <span
          className={
            'block w-full truncate text-xs leading-tight ' +
            (active ? 'text-[var(--v2-brand-strong)]/70' : 'text-[var(--v2-ink-3)]')
          }
        >
          {option.tagline}
        </span>
      )}
    </button>
  )
}

/**
 * Small surface-tinted chip used in the Signing-key section header. Two of
 * these together carry the non-custodial story (key locality + agent budget
 * cap) so the body copy can stay short.
 */
function SigningKeyChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--v2-surface)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-2)]">
      {icon}
      {children}
    </span>
  )
}

function OneClickChip({ active }: { active: boolean }) {
  return (
    <span
      aria-label="one-click install"
      className={
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ' +
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
        <span className="text-xs font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">
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
  const { copied, markCopied } = useCopyTimeout(2000)
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path.path)
    } catch {
      /* clipboard can fail in restricted contexts */
      return
    }
    markCopied()
  }, [path.path, markCopied])

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--v2-ink-3)]" />
      <div className="flex min-w-0 flex-1 flex-col">
        {showLabel && (
          <span className="text-xs font-medium text-[var(--v2-ink-2)]">{path.label}</span>
        )}
        {/* `<code>` is inline-level by default — `overflow-x-auto` only takes
            effect on block (or inline-block) elements. Without `block` here
            a long path (e.g. Cline's 110-char Windows path) blows past the
            modal width and forces the panel itself to scroll horizontally. */}
        <code className="block overflow-x-auto whitespace-nowrap font-mono text-[12px] leading-snug text-[var(--v2-ink)]">
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
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.fg}`}
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
        <span className="text-xs font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">
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
