'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { useLabels } from '@/hooks/useLabels'
import { useOrganizations } from '@/hooks/useOrganizations'
import type { Agent } from '@/hooks/useAgents'
import { LabelOptionRow, LabelChip } from '@/components/haven/LabelChip'
import { LABEL_EDITOR_NOTE } from '@/lib/label-copy'
import { organizationPath } from '@/lib/agent-organizations'
import { ORG_PICKER_LABEL, ORG_PICKER_NOTE } from '@/lib/organization-copy'
import { Button } from './ui/Button'
import { DialogActions } from './ui/DialogActions'
import { DialogResult } from './ui/DialogResult'
import { Input } from './ui/Input'
import { Modal } from './ui/Modal'
import { Select } from './ui/Select'
import { Textarea } from './ui/Textarea'

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
 *
 * #4565: the dialog is `ui/Modal` — the shared shell, its ✕, its focus trap and
 * its focus return — instead of a bespoke dialog panel with its own close
 * button and its own Escape hook. The screen's action pair lives in
 * `Modal`'s `footer`, outside the scroll box, so a short viewport can never push
 * the forward action off screen (#1946); a multi-screen dialog uses
 * `DialogActions`. The busy, success and failure screens are `ui/DialogResult`
 * (#4564), so they read the same as the budget dialog's.
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

  // ── Organization (#3164) ───────────────────────────────────────────────────
  // Same review+save flow as the identity fields and the labels: the picker
  // starts from the agent's current placement, and the save is one PUT that
  // carries organization_id (absent = keep, null = top level). Fetched with
  // the labels on open — one modal, one open, both vocabularies.
  const { organizations, fetchOrganizations } = useOrganizations()
  const [orgChoice, setOrgChoice] = useState(agent.organization_id ?? '')

  useEffect(() => {
    if (!open) return
    void fetchOrganizations()
  }, [open, fetchOrganizations])

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
    setOrgChoice(agent.organization_id ?? '')
  }, [agent.description, agent.labels, agent.name, agent.organization_id])

  // Reset on the closed → open edge only (#3537). `resetForm` changes identity
  // whenever the parent's 10s agent poll hands us a fresh `agent.labels`
  // array, so keying the reset on it wiped in-progress edits mid-typing.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) resetForm()
    wasOpenRef.current = open
  }, [open, resetForm])

  // A request in flight is the only state that guards closing. The failure
  // screen keeps `step === 'saving'` (it is the same screen, with the error
  // filled in), so it must not inherit the guard — its ✕, Escape and backdrop
  // are the way out of a save that did not land.
  const busy = step === 'saving' && !error

  const handleClose = useCallback(() => {
    if (busy) return
    resetForm()
    onClose()
  }, [busy, onClose, resetForm])

  const trimmedName = agentName.trim()
  const trimmedDescription = agentDescription.trim()
  const detailsChanged =
    trimmedName !== agent.name || trimmedDescription !== (agent.description ?? '')
  const labelsChanged =
    checkedLabelIds.length !== agent.labels.length ||
    agent.labels.some((l) => !checkedSet.has(l.id))
  // #3164: '' means top level, an id means filed under that organization.
  const orgChanged = (agent.organization_id ?? '') !== orgChoice
  const canReview = (trimmedName.length > 0 && detailsChanged) || labelsChanged || orgChanged

  async function saveDetails() {
    if (!canReview) return
    setStep('saving')
    setError(null)
    try {
      if (detailsChanged || orgChanged) {
        await api.put(`/agents/${agent.id}`, {
          ...(detailsChanged ? { name: trimmedName, description: trimmedDescription } : {}),
          ...(orgChanged ? { organization_id: orgChoice || null } : {}),
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

  // #4565: the screen's action pair lives in `Modal`'s footer — outside the
  // scroll box, so a short viewport can never push the forward action off
  // screen (#1946). A multi-screen dialog uses `DialogActions`; a screen with
  // a single action renders one full-width primary.
  const footer =
    step === 'form' ? (
      <DialogActions className="w-full">
        <Button variant="ghost" onClick={handleClose} className="flex-1">
          Cancel
        </Button>
        <Button onClick={() => setStep('review')} disabled={!canReview} className="flex-1">
          Review changes
        </Button>
      </DialogActions>
    ) : step === 'review' ? (
      <DialogActions className="w-full">
        <Button variant="ghost" onClick={() => setStep('form')} className="flex-1">
          Back
        </Button>
        <Button onClick={() => void saveDetails()} className="flex-1">
          Save details
        </Button>
      </DialogActions>
    ) : step === 'done' ? (
      <Button variant="ghost" onClick={handleClose} className="w-full">
        Done
      </Button>
    ) : error ? (
      <DialogActions className="w-full">
        <Button variant="ghost" onClick={() => setStep('review')} className="flex-1">
          Back
        </Button>
        <Button onClick={() => void saveDetails()} className="flex-1">
          Retry
        </Button>
      </DialogActions>
    ) : undefined

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Edit agent"
      subtitle="Update the name, description, labels and organisation shown in Haven."
      width="lg"
      // A save in flight disables every way out together — the ✕, the backdrop
      // and Escape — or the ✕ becomes the one unguarded exit.
      closeButtonDisabled={busy}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      footer={footer}
    >
      {step === 'form' && (
        <div className="space-y-5">
          <div>
            <label htmlFor="edit-agent-name" className="mb-1.5 block text-sm font-medium text-[var(--v2-ink)]">
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
            <label htmlFor="edit-agent-description" className="mb-1.5 block text-sm font-medium text-[var(--v2-ink)]">
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
            <p className="mb-1.5 text-sm font-medium text-[var(--v2-ink)]">Labels</p>
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
          {/*
            #3164: the organization picker — placement alongside identity
            and labels, the same review+save flow. Top level is the
            explicit choice; the note says what the choice changes
            (placement, nothing else).
          */}
          <div>
            <label
              htmlFor="edit-agent-organization"
              className="mb-1.5 block text-sm font-medium text-[var(--v2-ink)]"
            >
              {ORG_PICKER_LABEL}
            </label>
            <Select
              id="edit-agent-organization"
              value={orgChoice}
              onChange={(event) => setOrgChoice(event.target.value)}
            >
              <option value="">Top level</option>
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {organizationPath(organizations, org.id)}
                </option>
              ))}
            </Select>
            <p className="mt-2 text-xs text-[var(--v2-ink-3)]">{ORG_PICKER_NOTE}</p>
          </div>
          {!canReview ? (
            <p className="text-xs text-[var(--v2-ink-3)]">Edit the name, description or labels to continue.</p>
          ) : null}
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
            <div>
              <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">{ORG_PICKER_LABEL}</p>
              {orgChanged ? (
                <p className="text-sm text-[var(--v2-ink)]" data-testid="review-organization">
                  {orgChoice
                    ? organizationPath(organizations, orgChoice)
                    : 'Top level'}
                </p>
              ) : (
                <p className="text-sm text-[var(--v2-ink-2)]">Unchanged</p>
              )}
            </div>
          </div>
        </div>
      )}

      {step === 'saving' && !error && (
        <DialogResult state="busy" title="Saving changes…" />
      )}

      {step === 'saving' && error && (
        <DialogResult state="error" title="Update failed" description={error} />
      )}

      {step === 'done' && (
        <DialogResult
          state="success"
          title="Agent updated"
          description="Details, labels and organisation saved"
        />
      )}
    </Modal>
  )
}
