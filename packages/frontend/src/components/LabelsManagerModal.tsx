'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Pencil, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useLabels, type Label } from '@/hooks/useLabels'
import { LABEL_COLORS, DEFAULT_LABEL_COLOR, type LabelColor } from '@haven_ai/core'
import { labelChipClass } from '@/lib/label-colors'
import { LABEL_DELETE_BODY } from '@/lib/label-copy'
import { LabelChip } from '@/components/haven/LabelChip'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import ConfirmDialog from './ConfirmDialog'

/**
 * Manage the label vocabulary (#3167): rename, recolor, delete.
 *
 * Reached from the agent list header ("Labels" button) and from the agent
 * detail page's menu. The editor (EditAgentModal) TAGS agents with these
 * labels; this modal owns the vocabulary itself. Deleting is the destructive
 * path and goes through `ConfirmDialog`, whose body states the guarantee the
 * API's cascade gives: agents carrying the label keep everything else.
 *
 * A rename does not change which agents carry the label (the API renames the
 * vocabulary entry in place), so the row's chip previews the current colour
 * while the rename field edits the name.
 */
export default function LabelsManagerModal({
  open,
  onClose,
  onLabelsChanged,
}: {
  open: boolean
  onClose: () => void
  /** Called after any create-adjacent change so callers can refresh agent reads. */
  onLabelsChanged?: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  const { labels, loading, error, fetchLabels, updateLabel, deleteLabel } = useLabels({
    onChanged: onLabelsChanged,
  })

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [rowError, setRowError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Label | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (open) {
      setEditingId(null)
      setRowError(null)
      void fetchLabels()
    }
  }, [open, fetchLabels])

  const handleClose = useCallback(() => {
    if (saving || deleting) return
    onClose()
  }, [onClose, saving, deleting])

  useEscapeToClose(open, handleClose, { enabled: !saving && !deleting })

  const startRename = useCallback((label: Label) => {
    setEditingId(label.id)
    setEditName(label.name)
    setRowError(null)
  }, [])

  const saveRename = useCallback(
    async (label: Label) => {
      const name = editName.trim()
      if (!name || name === label.name) {
        setEditingId(null)
        return
      }
      setSaving(true)
      setRowError(null)
      try {
        await updateLabel(label.id, { name })
        setEditingId(null)
      } catch {
        setRowError('This name is already in use or could not be saved.')
      } finally {
        setSaving(false)
      }
    },
    [editName, updateLabel],
  )

  const recolor = useCallback(
    async (label: Label, color: LabelColor) => {
      if (label.color === color) return
      setSaving(true)
      try {
        await updateLabel(label.id, { color })
      } finally {
        setSaving(false)
      }
    },
    [updateLabel],
  )

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteLabel(deleteTarget.id)
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleteLabel])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center v2-safe-overlay [--v2-safe-gutter:1rem] v2-modal-backdrop">
      <div className="absolute inset-0" onClick={handleClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage labels"
        className="relative max-h-[calc(90vh-var(--v2-safe-top)-var(--v2-safe-bottom))] w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-[var(--v2-ink)]">Manage labels</h2>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
              Rename, recolour and remove the labels your agents carry.
            </p>
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
          {loading ? (
            <div role="status" aria-busy="true" className="space-y-2">
              <div className="h-9 animate-pulse rounded-md bg-[var(--v2-surface-2)]" />
              <div className="h-9 animate-pulse rounded-md bg-[var(--v2-surface-2)]" />
              <span className="sr-only">Loading labels</span>
            </div>
          ) : error ? (
            <div className="space-y-3 text-center">
              <p className="text-sm text-[var(--v2-ink-2)]">{error}</p>
              <Button variant="ghost" onClick={() => void fetchLabels()}>Try again</Button>
            </div>
          ) : labels.length === 0 ? (
            <p className="py-4 text-center text-sm text-[var(--v2-ink-2)]">
              No labels yet. Open an agent&apos;s edit panel to add the first one.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="label-manager-list">
              {labels.map((label) => (
                <li key={label.id} className="rounded-lg border border-[var(--v2-border)] p-3">
                  {editingId === label.id ? (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <Input
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void saveRename(label)
                            }
                          }}
                          aria-label="Label name"
                          className="flex-1"
                        />
                        <Button size="sm" onClick={() => void saveRename(label)} disabled={saving}>
                          Save
                        </Button>
                      </div>
                      {rowError ? (
                        <p role="alert" className="text-xs text-[var(--v2-danger)]">{rowError}</p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <LabelChip label={label} />
                      <span className="ml-auto flex items-center gap-1">
                        <Button
                          variant="tertiary"
                          size="sm"
                          onClick={() => startRename(label)}
                          aria-label={`Rename ${label.name}`}
                        >
                          <Icon icon={Pencil} className="h-3.5 w-3.5" />
                          Rename
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setDeleteTarget(label)}
                          aria-label={`Delete ${label.name}`}
                        >
                          Delete
                        </Button>
                      </span>
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-1.5" aria-label={`Colour for ${label.name}`}>
                    {LABEL_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        disabled={saving || editingId === label.id}
                        onClick={() => void recolor(label, color)}
                        aria-label={`Use ${color} colour`}
                        aria-pressed={label.color === color}
                        className={`h-5 w-5 rounded-full transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] ${
                          label.color === color
                            ? 'ring-2 ring-[var(--v2-brand)] ring-offset-2 ring-offset-[var(--v2-bg)]'
                            : ''
                        } ${labelChipClass(color)}`}
                      >
                        <span className="sr-only">{color}</span>
                      </button>
                    ))}
                    <span className="ml-1 text-xs text-[var(--v2-ink-3)]">
                      {label.color === DEFAULT_LABEL_COLOR ? 'Default colour' : 'Pick a colour'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onCancel={() => (deleting ? undefined : setDeleteTarget(null))}
        onConfirm={() => void confirmDelete()}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : 'Delete label?'}
        body={LABEL_DELETE_BODY}
        confirmLabel="Delete label"
        tone="danger"
        loading={deleting}
      />
    </div>
  )
}
