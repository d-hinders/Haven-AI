'use client'

import { Check, X } from 'lucide-react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { Icon } from '@/components/ui/Icon'
import { api } from '@/lib/api'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useLabels } from '@/hooks/useLabels'
import type { Agent } from '@/hooks/useAgents'
import { LabelOptionRow, LabelChip } from '@/components/haven/LabelChip'
import { LABEL_EDITOR_NOTE } from '@/lib/label-copy'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { useFocusTrap } from '@/hooks/useFocusTrap'

type Step = 'form' | 'review' | 'saving' | 'done'

/**
 * Edit the readable agent identity and its labels. Budget changes are
 * rail-specific and live in the delegation budget card; legacy Safe accounts
 * have no Haven authority-management path.
 *
 * #3167: labels ride in the same review+save flow as the identity fields —
 * the editor fetches the user's vocabulary on open, the checkbox list starts
 * from the agent's current set, and save is one PUT replacing the whole set
 * (the API's unit of intent). Tag-only saves are allowed: `canReview` no
 * longer requires a name/description change, only that SOMETHING changed.
 * A label that does not exist yet can be created inline while tagging.
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

  // ── Labels (#3167) ─────────────────────────────────────────────────────────
  // The vocabulary is fetched when the modal opens; the checked set starts
  // from the agent's current labels and changes only here, so the review
  // step can show the exact diff the save will make.
  const { labels: vocabulary, fetchLabels, createLabel, putAgentLabels } = useLabels()
  const [labelsReady, setLabelsReady] = useState(false)
  const [checkedLabelIds, setCheckedLabelIds] = useState<string[]>(
    agent.labels.map((l) => l.id),
  )
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelError, setNewLabelError] = useState<string | null>(null)
  const checkedSet = new Set(checkedLabelIds)

  const toggleLabel = useCallback((id: string) => {
    setCheckedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id],
    )
  }, [])

  // Stable-id create: the inline create POSTs on Enter/Add, selects the
  // result, and clears the field. The API folds a duplicate name into the
  // existing label (re-colouring it), so this cannot create a second "prod".
  const addNewLabel = useCallback(async () => {
    const name = newLabelName.trim().toLowerCase()
    if (!name) return
    const existing = vocabulary.find((l) => l.name.toLowerCase() === name)
    if (existing) {
      setCheckedLabelIds((prev) => (prev.includes(existing.id) ? prev : [...prev, existing.id]))
      setNewLabelName('')
      return
    }
    try {
      const label = await createLabel(name)
      setCheckedLabelIds((prev) => [...prev, label.id])
      setNewLabelName('')
      setNewLabelError(null)
    } catch {
      setNewLabelError('This label could not be created.')
    }
  }, [createLabel, newLabelName, vocabulary])

  useEffect(() => {
    if (!open) return
    setLabelsReady(false)
    void fetchLabels().then(() => setLabelsReady(true))
  }, [open, fetchLabels])

  const resetForm = useCallback(() => {
    setStep('form')
    setAgentName(agent.name)
    setAgentDescription(agent.description ?? '')
    setError(null)
    setCheckedLabelIds(agent.labels.map((l) => l.id))
    setNewLabelName('')
    setNewLabelError(null)
  }, [agent.description, agent.labels, agent.name])

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
  const labelsChanged =
    checkedLabelIds.length !== agent.labels.length ||
    agent.labels.some((l) => !checkedSet.has(l.id))
  const canReview = (trimmedName.length > 0 && detailsChanged) || labelsChanged

  async function saveDetails() {
    if (!canReview) return
    setStep('saving')
    setError(null)
    try {
      if (detailsChanged) {
        await api.put(`/agents/${agent.id}`, {
          name: trimmedName,
          description: trimmedDescription,
        })
      }
      if (labelsChanged) {
        await putAgentLabels(agent.id, checkedLabelIds)
      }
      setStep('done')
      onUpdated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The agent details could not be saved.')
      setStep('saving')
    }
  }

  if (!open) return null

  return (
    // `v2-safe-overlay` + a 1rem gutter is `p-4` that also clears the notch and
    // the home indicator (#2730), unchanged wherever the insets are 0. This
    // wrapper paints its own backdrop rather than nesting one, which is why the
    // first sweep missed it: the grep that enumerated the overlays excluded
    // every line carrying `v2-modal-backdrop`.
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center v2-safe-overlay [--v2-safe-gutter:1rem] v2-modal-backdrop">
      <div className="absolute inset-0" onClick={step !== 'saving' ? handleClose : undefined} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit agent"
        className="relative max-h-[calc(90vh-var(--v2-safe-top)-var(--v2-safe-bottom))] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-[var(--v2-ink)]">Edit agent</h2>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">Update the name, description and labels shown in Haven.</p>
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
              {/*
                #3167: the label editor — checkbox list over the user's whole
                vocabulary, inline create below it. Checking a box is NOT a
                save: every tag change lands through the review step's one
                PUT, the same review+save path the name and description take.
              */}
              <div>
                <p className="mb-1.5 text-xs font-medium text-[var(--v2-ink-3)]">Labels</p>
                {labelsReady && vocabulary.length === 0 ? (
                  <p className="text-xs text-[var(--v2-ink-3)]">
                    No labels yet. Add one below to start organising your agents.
                  </p>
                ) : (
                  <div className="space-y-1" data-testid="label-editor-list">
                    {vocabulary.map((label) => (
                      <LabelOptionRow
                        key={label.id}
                        label={label}
                        checked={checkedSet.has(label.id)}
                        onToggle={() => toggleLabel(label.id)}
                      />
                    ))}
                  </div>
                )}
                <div className="mt-2 flex gap-2">
                  <Input
                    id="edit-agent-new-label"
                    value={newLabelName}
                    onChange={(event) => setNewLabelName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void addNewLabel()
                      }
                    }}
                    placeholder="New label name"
                    aria-label="New label name"
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="tertiary"
                    size="sm"
                    onClick={() => void addNewLabel()}
                    disabled={newLabelName.trim().length === 0}
                  >
                    Add
                  </Button>
                </div>
                {newLabelError ? (
                  <p role="alert" className="mt-1 text-xs text-[var(--v2-danger)]">{newLabelError}</p>
                ) : null}
                <p className="mt-2 text-xs text-[var(--v2-ink-3)]">{LABEL_EDITOR_NOTE}</p>
              </div>
              {!canReview ? (
                <p className="text-xs text-[var(--v2-ink-3)]">Edit the name, description or labels to continue.</p>
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
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Labels</p>
                  {labelsChanged ? (
                    <div className="flex flex-wrap items-center gap-1" data-testid="review-label-chips">
                      {vocabulary
                        .filter((l) => checkedSet.has(l.id))
                        .map((l) => (
                          <LabelChip key={l.id} label={l} />
                        ))}
                      {checkedLabelIds.length === 0 ? (
                        <span className="text-sm text-[var(--v2-ink-2)]">No labels</span>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--v2-ink-2)]">Unchanged</p>
                  )}
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
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Details and labels saved</p>
              </div>
              <Button variant="ghost" onClick={handleClose} className="w-full">Done</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
