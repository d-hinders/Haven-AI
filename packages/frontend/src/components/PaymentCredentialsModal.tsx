'use client'

import { Spinner } from '@haven_ai/ui/Spinner'
import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { Modal } from '@/components/ui/Modal'
import { timeAgo } from '@/lib/format'
import { api } from '@/lib/api'

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
  onKeyRotated?: (newKey: string, newPrefix: string) => void
}

/**
 * Single modal that surfaces everything a developer needs to wire an agent
 * up to Haven: the API-key credential (shown once, masked after) and the
 * on-chain signing address. Replaces the inline "Haven credential" +
 * "Advanced details" cards that used to sit on the agent detail page.
 *
 * Also handles key rotation: when the full credential is no longer available
 * (masked), the user can rotate to get a new key via POST /agents/:id/rotate-key.
 * The caller is notified via onKeyRotated so it can update its local state.
 *
 * #4566: the shell is `ui/Modal` — the shared anatomy (title, subtitle, ✕,
 * one scroller, footer outside it) instead of a hand-built overlay. The
 * dialog is single-screen, so its one action is a content-width ghost in the
 * footer, per `docs/product/design-system.md` § Dialog actions.
 */
export default function PaymentCredentialsModal({ open, onClose, agent, onKeyRotated }: Props) {
  const [showCredential, setShowCredential] = useState(false)
  const [rotating, setRotating] = useState(false)
  const { toast } = useToast()

  // Reset toggles + copy state every time the modal opens so we don't
  // leak "Show" state from a previous open into a fresh view.
  // Also reset `rotating` so a mid-flight rotation that was closed doesn't
  // leave the button stuck in spinner state on reopen.
  useEffect(() => {
    if (open) {
      setShowCredential(false)
      setRotating(false)
    }
  }, [open])

  const fullCredential = agent.api_key?.trim() || null
  const credentialPrefix =
    agent.api_key_prefix ?? (fullCredential ? fullCredential.slice(0, 12) : null)
  const maskedCredential = credentialPrefix
    ? `${credentialPrefix}${'•'.repeat(12)}`
    : 'Credential shown only when created'

  const rotateKey = useCallback(async () => {
    setRotating(true)
    try {
      const result = await api.rotateAgentKey(agent.id)
      onKeyRotated?.(result.api_key, result.api_key_prefix)
      toast.success("API key rotated — save it now, it won't be shown again")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rotate API key')
    } finally {
      setRotating(false)
    }
  }, [agent.id, onKeyRotated, toast])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Payment credentials"
      subtitle={`Everything ${agent.name} needs to request payments through Haven.`}
      width="lg"
      bodyClassName="space-y-6"
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
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
              {/* #4573: the shared copy primitive. A one-time credential
                  must never fail silently, so the failure is a toast; the
                  success is the button's own inline "Copied", not a toast
                  as well. */}
              <CopyButton
                value={fullCredential}
                label="credential"
                text="Copy"
                onCopyFailed={() => toast.error('Could not copy credential')}
              />
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void rotateKey()}
                disabled={rotating}
                className="text-[var(--v2-warning)] hover:text-warning/80"
              >
                {rotating ? (
                  <span className="flex items-center gap-1.5">
                    <Spinner size="sm" />
                    Rotating…
                  </span>
                ) : (
                  'Rotate API key'
                )}
              </Button>
              <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
                Rotating generates a new key immediately. The old key stops working right away.
              </p>
            </div>
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
            <CopyButton
              value={agent.delegate_address}
              label="signing address"
              text="Copy address"
              className="mt-3"
              onCopyFailed={() => toast.error('Could not copy address')}
            />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-[var(--v2-ink-3)]">
            If you suspect this agent’s signing key is compromised, choose Replace signing key from this
            agent’s menu, or Remove agent… to end its budgets. The key also controls any funds already at
            this address; ending the budget does not recover them.
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
            <CopyButton value={agent.id} label="agent ID" />
          </span>
          <span>Created</span>
          <span className="text-[var(--v2-ink-2)]">{timeAgo(agent.created_at)}</span>
        </div>
      </section>
    </Modal>
  )
}
