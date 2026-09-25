'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { api } from '@/lib/api'
import type { Agent } from '@/hooks/useAgents'
import type { Organization } from '@/hooks/useOrganizations'
import { organizationPath } from '@/lib/agent-organizations'
import { ORG_PICKER_LABEL, ORG_PICKER_NOTE } from '@/lib/organization-copy'
import { Button } from './ui/Button'
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
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

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

  useEscapeToClose(open, handleClose, { enabled: !saving })

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

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center v2-safe-overlay [--v2-safe-gutter:1rem] v2-modal-backdrop">
      <div className="absolute inset-0" onClick={handleClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${agent.name}`}
        className="relative w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-[var(--v2-ink)]">Move {agent.name}</h2>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">Choose where the agent is filed.</p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
          >
            <Icon icon={X} className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6">
          <label
            htmlFor="move-agent-organization"
            className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-3)]"
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
            <p role="alert" className="mt-2 text-xs text-[var(--v2-danger)]">{error}</p>
          ) : null}
          <div className="mt-5 flex gap-3">
            <Button variant="ghost" onClick={handleClose} className="flex-1">
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving || unchanged} className="flex-1">
              {saving ? 'Moving…' : 'Move agent'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
