'use client'

/**
 * Manage the label vocabulary (#3167): rename, recolour, delete.
 *
 * Reached from the agents list header ("Manage labels") and from the agent
 * detail page's menu (the same words). The editor (EditAgentModal) TAGS agents
 * with these labels; this modal owns the vocabulary itself.
 *
 * #4565: the list, the rename field, the delete confirmation and the row errors
 * are `ListManagerModal`'s — the same shape the organisations manager renders.
 * What stays here is what only labels have: the chip preview and the fixed
 * colour palette. Deleting confirms inline inside the manager, never through a
 * second dialog, and its body states the guarantee the API's cascade gives:
 * agents carrying the label keep everything else.
 *
 * A rename does not change which agents carry the label (the API renames the
 * vocabulary entry in place), so the row's chip previews the current colour
 * while the rename field edits the name.
 */

import { useCallback, useEffect, useState } from 'react'
import { useLabels, type Label } from '@/hooks/useLabels'
import { LABEL_COLORS, DEFAULT_LABEL_COLOR, type LabelColor } from '@haven_ai/core'
import { labelChipClass } from '@/lib/label-colors'
import { LABEL_DELETE_BODY } from '@/lib/label-copy'
import { LabelChip } from '@/components/haven/LabelChip'
import { ListManagerModal } from './ListManagerModal'

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
  const { labels, loading, error, fetchLabels, updateLabel, deleteLabel } = useLabels({
    onChanged: onLabelsChanged,
  })

  // Recolour is this manager's own action, so its busy state is its own: the
  // shared manager's `saving` covers renames only.
  const [recolouring, setRecolouring] = useState(false)

  useEffect(() => {
    if (open) void fetchLabels()
  }, [open, fetchLabels])

  const recolor = useCallback(
    async (label: Label, color: LabelColor) => {
      if (label.color === color) return
      setRecolouring(true)
      try {
        await updateLabel(label.id, { color })
      } finally {
        setRecolouring(false)
      }
    },
    [updateLabel],
  )

  return (
    <ListManagerModal<Label>
      open={open}
      onClose={onClose}
      title="Manage labels"
      subtitle="Rename, recolour and delete the labels your agents carry."
      items={labels}
      loading={loading}
      loadError={error}
      onReload={() => void fetchLabels()}
      loadingLabel="Loading labels"
      emptyMessage="No labels yet. Open an agent's edit panel to add the first one."
      listTestId="label-manager-list"
      renameInputLabel="Label name"
      onRename={async (label, name) => {
        try {
          await updateLabel(label.id, { name })
        } catch {
          // The API folds a duplicate name into a 409; the row says what the
          // user can act on rather than repeating the server's sentence.
          throw new Error('This name is already in use or could not be saved.')
        }
      }}
      onDelete={(label) => deleteLabel(label.id)}
      deleteTitle={(label) => `Delete ${label.name}?`}
      deleteBody={() => LABEL_DELETE_BODY}
      deleteConfirmLabel="Delete label"
      renderRowTitle={(label) => <LabelChip label={label} />}
      renderRowMeta={(label, api) => (
        <div className="mt-2 flex items-center gap-1.5" aria-label={`Colour for ${label.name}`}>
          {LABEL_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              disabled={recolouring || api.editing}
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
      )}
    />
  )
}
