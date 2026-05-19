'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { timeAgo } from '@/lib/format'

interface PaymentCredentialsAgent {
  id: string
  name: string
  api_key?: string | null
  api_key_prefix?: string | null
  delegate_address: string | null
  created_at: string
}

interface Props {
  open: boolean
  onClose: () => void
  agent: PaymentCredentialsAgent
}

/**
 * Single modal that surfaces everything a developer needs to wire an agent
 * up to Haven: the API-key credential (shown once, masked after) and the
 * on-chain signing address. Replaces the inline "Haven credential" +
 * "Advanced details" cards that used to sit on the agent detail page.
 *
 * Pure presentation — no API calls. Reads everything it needs from the
 * agent prop the caller already has in hand.
 */
export default function PaymentCredentialsModal({ open, onClose, agent }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [showCredential, setShowCredential] = useState(false)
  const [credentialCopied, setCredentialCopied] = useState(false)
  const [addressCopied, setAddressCopied] = useState(false)
  const [idCopied, setIdCopied] = useState(false)
  const { toast } = useToast()

  useFocusTrap(panelRef, open)
  useEscapeToClose(open, onClose)

  // Reset toggles + copy state every time the modal opens so we don't
  // leak "Show" state from a previous open into a fresh view.
  useEffect(() => {
    if (open) {
      setShowCredential(false)
      setCredentialCopied(false)
      setAddressCopied(false)
      setIdCopied(false)
    }
  }, [open])

  const fullCredential = agent.api_key?.trim() || null
  const credentialPrefix =
    agent.api_key_prefix ?? (fullCredential ? fullCredential.slice(0, 12) : null)
  const maskedCredential = credentialPrefix
    ? `${credentialPrefix}${'•'.repeat(12)}`
    : 'Credential shown only when created'

  const copyCredential = useCallback(async () => {
    if (!fullCredential) return
    try {
      await navigator.clipboard.writeText(fullCredential)
      setCredentialCopied(true)
      toast.success('Credential copied')
      setTimeout(() => setCredentialCopied(false), 2000)
    } catch {
      toast.error('Could not copy credential')
    }
  }, [fullCredential, toast])

  const copyAddress = useCallback(async () => {
    if (!agent.delegate_address) return
    try {
      await navigator.clipboard.writeText(agent.delegate_address)
      setAddressCopied(true)
      toast.success('Signing address copied')
      setTimeout(() => setAddressCopied(false), 2000)
    } catch {
      toast.error('Could not copy address')
    }
  }, [agent.delegate_address, toast])

  const copyAgentId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(agent.id)
      setIdCopied(true)
      toast.success('Agent ID copied')
      setTimeout(() => setIdCopied(false), 2000)
    } catch {
      toast.error('Could not copy agent ID')
    }
  }, [agent.id, toast])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 v2-modal-backdrop">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-credentials-title"
        className="relative flex w-full max-w-lg flex-col rounded-2xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)] max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[var(--v2-border)] px-6 py-5 flex-shrink-0">
          <div className="min-w-0">
            <h2 id="payment-credentials-title" className="text-base font-semibold text-[var(--v2-ink)] leading-tight">
              Payment credentials
            </h2>
            <p className="mt-1 text-sm leading-snug text-[var(--v2-ink-3)]">
              Everything {agent.name} needs to request payments through Haven.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded-md p-1.5 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Haven credential */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Haven credential</h3>
            <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
              Your agent uses this credential to talk to Haven — treat it like an API key, keep it
              private. Haven only shows the full credential when you create the agent.
            </p>
            <div className="mt-3 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
              <code className="block break-all font-mono text-xs text-[var(--v2-ink-2)]">
                {fullCredential && showCredential ? fullCredential : maskedCredential}
              </code>
              {fullCredential ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setShowCredential((value) => !value)}>
                    {showCredential ? 'Hide' : 'Show'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void copyCredential()}>
                    {credentialCopied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              ) : (
                <p className="mt-3 text-xs leading-relaxed text-[var(--v2-ink-3)]">
                  If you lost the credential, create a new agent — Haven cannot show it again.
                </p>
              )}
            </div>
          </section>

          {/* Signing address */}
          {agent.delegate_address ? (
            <section>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Signing address</h3>
              <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
                The on-chain address your agent uses to sign payments on behalf of your account.
                Anyone watching the chain can see it — it&apos;s safe to share.
              </p>
              <div className="mt-3 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
                <code className="block break-all font-mono text-xs text-[var(--v2-ink)]">
                  {agent.delegate_address}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copyAddress()}
                  className="mt-3"
                >
                  {addressCopied ? 'Copied' : 'Copy address'}
                </Button>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-[var(--v2-ink-3)]">
                If you suspect this address is compromised, revoke the agent and create a new one.
              </p>
            </section>
          ) : (
            <section>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Signing address</h3>
              <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
                This agent does not currently have a signing address.
              </p>
            </section>
          )}

          {/* Reference */}
          <section className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 text-xs text-[var(--v2-ink-3)]">
            <p className="mb-2 font-medium text-[var(--v2-ink-2)]">Reference</p>
            <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5">
              <span>Agent ID</span>
              <span className="flex min-w-0 items-center gap-2">
                <code className="truncate font-mono text-[var(--v2-ink-2)]">{agent.id}</code>
                <button
                  type="button"
                  onClick={() => void copyAgentId()}
                  className="flex-shrink-0 text-[var(--v2-brand)] transition-colors hover:text-[var(--v2-brand-strong)]"
                  aria-label="Copy agent ID"
                >
                  {idCopied ? 'Copied' : 'Copy'}
                </button>
              </span>
              <span>Created</span>
              <span className="text-[var(--v2-ink-2)]">{timeAgo(agent.created_at)}</span>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-[var(--v2-border)] px-6 py-4 flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
