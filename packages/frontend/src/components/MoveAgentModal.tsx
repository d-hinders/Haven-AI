'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { InlineAlert } from '@haven_ai/ui/InlineAlert'
import { api } from '@/lib/api'
import type { Agent } from '@/hooks/useAgents'
import type { Organization } from '@/hooks/useOrganizations'
import { organizationPath } from '@/lib/agent-organizations'
import { ORG_PICKER_LABEL, ORG_PICKER_NOTE } from '@/lib/organization-copy'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
import { Select } from './ui/Select'

/**
 * Move one agent between organizations (#3164), opened from the agent
 * card's "Move" action. A Select over "Top level" and every organization
 * (path-labelled), pre-set to the agent's current placement; save is one
 * PUT /agents/:id with `organization_id` and the response (the updated
 * agent) flows back to the caller.
 *
 * The manager modal owns creating and arranging organizations; this modal
 * only files one agent. Same separation as labels: EditAgentModal tags,
 * LabelsManagerModal owns the vocabulary.
 *
 * #4565: `ui/Modal` owns the shell, the ✕, the focus trap and the focus
 * return. This is a single-screen dialog — one screen, one decision — so its
 * pair is right-aligned and content-width in `Modal`'s `footer` (DS § Dialog
 * actions), not the full-width halves a multi-screen flow uses.
 */
export default function MoveAgentModal({
  open,
  onClose,
  agent,
  organizations,
  onMoved,
}: {
  open: boolean
  onClose: () => void
  agent: Agent
  organizations: Organization[]
  /** Called with the updated agent after a successful move. */
  onMoved: (agent: Agent) => void
}) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setValue(agent.organization_id ?? '')
      setSaving(false)
      setError(null)
    }
  }, [open, agent.organization_id])

  const handleClose = useCallback(() => {
    if (saving) return
    onClose()
  }, [onClose, saving])

  const unchanged = (agent.organization_id ?? '') === value
  const options = useMemo(() => organizations, [organizations])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const updated = await api.put<Agent>(`/agents/${agent.id}`, {
        organization_id: value || null,
      })
      onMoved(updated)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The agent could not be moved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Move ${agent.name}`}
      subtitle="Choose where the agent is filed."
      width="md"
      // A move in flight disables every way out together — the ✕, the backdrop
      // and Escape — or the ✕ becomes the one unguarded exit.
      closeButtonDisabled={saving}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      footer={
        <>
          <Button variant="tertiary" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || unchanged}>
            {saving ? 'Moving…' : 'Move agent'}
          </Button>
        </>
      }
    >
      <label
        htmlFor="move-agent-organization"
        className="mb-1.5 block text-sm font-medium text-[var(--v2-ink)]"
      >
        {ORG_PICKER_LABEL}
      </label>
      <Select
        id="move-agent-organization"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      >
        <option value="">Top level</option>
        {options.map((org) => (
          <option key={org.id} value={org.id}>
            {organizationPath(options, org.id)}
          </option>
        ))}
      </Select>
      <p className="mt-2 text-xs text-[var(--v2-ink-3)]">{ORG_PICKER_NOTE}</p>
      {error ? (
        <div className="mt-2">
          <InlineAlert>{error}</InlineAlert>
        </div>
      ) : null}
    </Modal>
  )
}
