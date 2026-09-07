'use client'

import { Check, X } from 'lucide-react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { Icon } from '@/components/ui/Icon'
import { api } from '@/lib/api'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import type { Agent } from '@/hooks/useAgents'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { useFocusTrap } from '@/hooks/useFocusTrap'

type Step = 'form' | 'review' | 'saving' | 'done'

/**
 * Edit the readable agent identity only. Budget changes are rail-specific and
 * live in the delegation budget card; legacy Safe accounts have no Haven
 * authority-management path.
 */
export default function EditAgentModal({
  open,
  onClose,
  agent,
  onUpdated,
}: {
  open: boolean
  onClose: () => void
  agent: Agent
  onUpdated: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)
  const [step, setStep] = useState<Step>('form')
  const [agentName, setAgentName] = useState(agent.name)
  const [agentDescription, setAgentDescription] = useState(agent.description ?? '')
  const [error, setError] = useState<string | null>(null)

  const resetForm = useCallback(() => {
    setStep('form')
    setAgentName(agent.name)
    setAgentDescription(agent.description ?? '')
    setError(null)
  }, [agent.description, agent.name])

  useEffect(() => {
    if (open) resetForm()
  }, [open, resetForm])

  const handleClose = useCallback(() => {
    if (step === 'saving') return
    resetForm()
    onClose()
  }, [onClose, resetForm, step])

  useEscapeToClose(open, handleClose, { enabled: step !== 'saving' })

  const trimmedName = agentName.trim()
  const trimmedDescription = agentDescription.trim()
  const detailsChanged =
    trimmedName !== agent.name || trimmedDescription !== (agent.description ?? '')
  const canReview = trimmedName.length > 0 && detailsChanged

  async function saveDetails() {
    if (!canReview) return
    setStep('saving')
    setError(null)
    try {
      await api.put(`/agents/${agent.id}`, {
        name: trimmedName,
        description: trimmedDescription,
      })
      setStep('done')
      onUpdated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The agent details could not be saved.')
      setStep('saving')
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center p-4 v2-modal-backdrop">
      <div className="absolute inset-0" onClick={step !== 'saving' ? handleClose : undefined} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit agent"
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--v2-border)] bg-white shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-[var(--v2-ink)]">Edit agent</h2>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">Update the name and description shown in Haven.</p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={step === 'saving'}
            aria-label="Close"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:opacity-50"
          >
            <Icon icon={X} className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6">
          {step === 'form' && (
            <div className="space-y-5">
              <div>
                <label htmlFor="edit-agent-name" className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-3)]">
                  Agent name
                </label>
                <Input
                  id="edit-agent-name"
                  value={agentName}
                  onChange={(event) => setAgentName(event.target.value)}
                  placeholder="Agent name"
                />
              </div>
              <div>
                <label htmlFor="edit-agent-description" className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-3)]">
                  Description <span className="text-[var(--v2-ink-3)]">(optional)</span>
                </label>
                <Textarea
                  id="edit-agent-description"
                  value={agentDescription}
                  onChange={(event) => setAgentDescription(event.target.value)}
                  placeholder="What does this agent do?"
                  rows={3}
                />
              </div>
              {!canReview ? (
                <p className="text-xs text-[var(--v2-ink-3)]">Edit the name or description to continue.</p>
              ) : null}
              <div className="flex gap-3">
                <Button variant="ghost" onClick={handleClose} className="flex-1">Cancel</Button>
                <Button onClick={() => setStep('review')} disabled={!canReview} className="flex-1">
                  Review changes
                </Button>
              </div>
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-5">
              <div className="space-y-3 rounded-xl border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Agent name</p>
                  <p className="text-sm font-medium text-[var(--v2-ink)]">{trimmedName}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Description</p>
                  <p className="text-sm text-[var(--v2-ink-2)]">{trimmedDescription || 'No description'}</p>
                </div>
              </div>
              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setStep('form')} className="flex-1">Back</Button>
                <Button onClick={() => void saveDetails()} className="flex-1">Save details</Button>
              </div>
            </div>
          )}

          {step === 'saving' && (
            <div className="space-y-4 py-8 text-center">
              {error ? (
                <>
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--v2-danger-soft)]">
                    <Icon icon={X} className="h-5 w-5 text-[var(--v2-danger)]" />
                  </div>
                  <p className="text-sm font-medium text-[var(--v2-danger)]">Update failed</p>
                  <p className="mx-auto max-w-xs text-xs text-[var(--v2-ink-3)]">{error}</p>
                  <div className="flex gap-3 pt-2">
                    <Button variant="ghost" onClick={() => setStep('review')} className="flex-1">Back</Button>
                    <Button onClick={() => void saveDetails()} className="flex-1">Retry</Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[var(--v2-brand)] border-t-transparent" />
                  <p className="text-sm font-medium text-[var(--v2-ink)]">Saving changes…</p>
                </>
              )}
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-5">
              <div className="py-4 text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--v2-success-soft)]">
                  <Icon icon={Check} className="h-6 w-6 text-[var(--v2-success)]" />
                </div>
                <p className="text-sm font-medium text-[var(--v2-ink)]">Agent updated</p>
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Name and description saved</p>
              </div>
              <Button variant="ghost" onClick={handleClose} className="w-full">Done</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
