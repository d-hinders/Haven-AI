'use client'

/**
 * One list manager for the vocabularies an agent carries (#4565).
 *
 * `LabelsManagerModal` and `OrganizationsManagerModal` shipped the same shape
 * twice: a `Modal`-less `role="dialog"` shell, a fetched list, a per-row rename
 * field, a per-row delete, and the same `startRename` / `saveRename` /
 * `confirmDelete` handlers. This is that shape, once. The two callers keep only
 * what is genuinely theirs — labels keep recolour, organisations keep create,
 * move and their nesting — and pass it in as slots.
 *
 * **Delete confirms inline, inside this dialog.** The organisations manager
 * used to mount `ConfirmDialog` over itself, which is two dialogs at once and
 * against `docs/product/README.md` ("Never nest modals. Use inline confirmation
 * panels…"). The panel below the row names the item, carries Cancel and Delete,
 * shows the busy and error states, and puts focus back on the row's Delete
 * trigger when it closes. Escape cancels the panel rather than the manager, so
 * the document holds exactly one `role="dialog"` throughout.
 *
 * The row layout is the organisations manager's, which is the one that survived
 * a 390px review: the name takes the full row below `sm` and the actions sit on
 * their own line, joining it only from `sm` up. Labels rows get the same
 * treatment, which is what their chip + Rename + Delete + four swatches needed
 * anyway.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { InlineAlert } from '@haven_ai/ui/InlineAlert'
import { Skeleton } from '@haven_ai/ui/Skeleton'
import { Icon } from '@/components/ui/Icon'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Modal } from './ui/Modal'

/** The minimum a managed row must carry: an id to key on and a name to edit. */
export interface ManagedItem {
  id: string
  name: string
}

/** What a caller's row slots may do to the row they are rendered in. */
export interface ListManagerRowApi {
  /** Open this row's rename field. */
  startRename: () => void
  /** Open this row's inline delete confirmation. */
  startDelete: () => void
  /** True while this row's rename field is open. */
  editing: boolean
}

interface Props<T extends ManagedItem> {
  open: boolean
  onClose: () => void
  /** The dialog's title — the same words as the menu item that opens it. */
  title: string
  /** The sentence under the title: what this manager is for. */
  subtitle: string
  items: T[]
  loading: boolean
  loadError: string | null
  onReload: () => void
  /** Screen-reader text for the loading skeletons, e.g. "Loading labels". */
  loadingLabel: string
  emptyMessage: string
  /** `data-testid` on the `<ul>`, kept from each manager's own tests. */
  listTestId: string
  /** Accessible name for the rename field, e.g. "Label name". */
  renameInputLabel: string
  /**
   * Rename one item. Reject with an `Error` whose message is the row's copy —
   * the caller owns its wording, this component owns where it renders.
   */
  onRename: (item: T, name: string) => Promise<void>
  /**
   * Delete one item. Reject to keep the panel open with the error; resolve to
   * close it. A caller that treats a failure as "already gone" resolves.
   */
  onDelete: (item: T) => Promise<void>
  deleteTitle: (item: T) => string
  deleteBody: (item: T) => ReactNode
  deleteConfirmLabel: string
  /** Extra content above the list — the organisations manager's create form. */
  header?: ReactNode
  /** The row's title. Defaults to the item's name. */
  renderRowTitle?: (item: T) => ReactNode
  /** Content under the title, inside the name column (path, counts, swatches). */
  renderRowMeta?: (item: T, api: ListManagerRowApi) => ReactNode
  /** Extra actions beside Rename and Delete (the organisations manager's Move). */
  renderRowActions?: (item: T, api: ListManagerRowApi) => ReactNode
  /**
   * Replaces the whole row body when the caller is in its own row mode — the
   * organisations manager's move picker. Return `null` for the normal row.
   */
  renderRowOverride?: (item: T, api: ListManagerRowApi) => ReactNode | null
}

export function ListManagerModal<T extends ManagedItem>({
  open,
  onClose,
  title,
  subtitle,
  items,
  loading,
  loadError,
  onReload,
  loadingLabel,
  emptyMessage,
  listTestId,
  renameInputLabel,
  onRename,
  onDelete,
  deleteTitle,
  deleteBody,
  deleteConfirmLabel,
  header,
  renderRowTitle,
  renderRowMeta,
  renderRowActions,
  renderRowOverride,
}: Props<T>) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [rowError, setRowError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<T | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // The row's Delete trigger, so closing the panel puts focus back on the
  // control that opened it. Only the confirming row's button holds the ref.
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null)
  const deleteConfirmRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    setEditingId(null)
    setRowError(null)
    setDeleteTarget(null)
    setDeleteError(null)
  }, [open])

  // A failed delete keeps the panel open — it is where the error belongs — so
  // focus moves to the retry rather than out of the panel.
  useEffect(() => {
    if (deleteError) deleteConfirmRef.current?.focus()
  }, [deleteError])

  const handleClose = useCallback(() => {
    if (saving || deleting) return
    onClose()
  }, [deleting, onClose, saving])

  const cancelDelete = useCallback(() => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteError(null)
    deleteTriggerRef.current?.focus()
  }, [deleting])

  const startRename = useCallback((item: T) => {
    setEditingId(item.id)
    setEditName(item.name)
    setRowError(null)
    // One row mode at a time: opening a rename closes an open confirmation.
    setDeleteTarget(null)
    setDeleteError(null)
  }, [])

  const saveRename = useCallback(
    async (item: T) => {
      const name = editName.trim()
      if (!name || name === item.name) {
        setEditingId(null)
        return
      }
      setSaving(true)
      setRowError(null)
      try {
        await onRename(item, name)
        setEditingId(null)
      } catch (err) {
        setRowError(err instanceof Error ? err.message : 'This name could not be saved.')
      } finally {
        setSaving(false)
      }
    },
    [editName, onRename],
  )

  const startDelete = useCallback((item: T) => {
    setDeleteError(null)
    setDeleteTarget(item)
    // One row mode at a time: opening a confirmation closes an open rename.
    setEditingId(null)
    setRowError(null)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await onDelete(deleteTarget)
      setDeleteTarget(null)
    } catch {
      // Our words, naming the item, not the server's raw message (#3236).
      setDeleteError(`${deleteTarget.name} was not deleted. Try again.`)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, onDelete])

  return (
    <Modal
      open={open}
      // Escape, the backdrop and the ✕ cancel an open confirmation before they
      // close the manager — one dialog, one dismiss, in that order. `Modal`
      // owns all three through this one handler, so the ✕ cannot close the
      // manager while a confirmation is open; the second press does.
      onClose={deleteTarget ? cancelDelete : handleClose}
      title={title}
      subtitle={subtitle}
      width="lg"
      closeButtonDisabled={saving || deleting}
      closeOnBackdrop={!saving && !deleting}
      closeOnEscape={!saving && !deleting}
    >
      {header}

      {loading ? (
        <div role="status" aria-busy="true" className="space-y-2">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <span className="sr-only">{loadingLabel}</span>
        </div>
      ) : loadError ? (
        <div className="space-y-3 text-center">
          <p className="text-sm text-[var(--v2-ink-2)]">{loadError}</p>
          <Button variant="ghost" onClick={onReload}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-sm text-[var(--v2-ink-2)]">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2" data-testid={listTestId}>
          {items.map((item) => {
            const api: ListManagerRowApi = {
              startRename: () => startRename(item),
              startDelete: () => startDelete(item),
              editing: editingId === item.id,
            }
            const override = renderRowOverride?.(item, api) ?? null
            const confirming = deleteTarget?.id === item.id

            return (
              <li key={item.id} className="rounded-lg border border-[var(--v2-border)] p-3">
                {override ??
                  (editingId === item.id ? (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <Input
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void saveRename(item)
                            }
                          }}
                          aria-label={renameInputLabel}
                          className="flex-1"
                        />
                        <Button size="sm" onClick={() => void saveRename(item)} disabled={saving}>
                          Save
                        </Button>
                      </div>
                      {rowError ? <InlineAlert>{rowError}</InlineAlert> : null}
                    </div>
                  ) : (
                    <div className="sm:flex sm:items-center sm:gap-2">
                      <div className="min-w-0 sm:flex-1">
                        {renderRowTitle ? (
                          renderRowTitle(item)
                        ) : (
                          <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{item.name}</p>
                        )}
                        {renderRowMeta?.(item, api)}
                      </div>
                      <div className="mt-2 flex items-center gap-1 sm:mt-0 sm:shrink-0">
                        {renderRowActions?.(item, api)}
                        <Button
                          variant="tertiary"
                          size="sm"
                          onClick={api.startRename}
                          aria-label={`Rename ${item.name}`}
                        >
                          <Icon icon={Pencil} className="h-3.5 w-3.5" />
                          Rename
                        </Button>
                        <Button
                          variant="tertiary"
                          size="sm"
                          onClick={api.startDelete}
                          aria-label={`Delete ${item.name}`}
                          ref={confirming ? deleteTriggerRef : undefined}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  ))}

                {confirming ? (
                  <div
                    className="mt-3 rounded-lg border border-danger/25 bg-[var(--v2-surface)] p-3"
                    data-testid="list-manager-delete-panel"
                  >
                    <p className="text-sm font-medium text-[var(--v2-ink)]">{deleteTitle(item)}</p>
                    <div className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">{deleteBody(item)}</div>
                    {deleteError ? (
                      <div className="mt-2">
                        <InlineAlert>{deleteError}</InlineAlert>
                      </div>
                    ) : null}
                    <div className="mt-3 flex gap-2">
                      <Button variant="tertiary" size="sm" onClick={cancelDelete} disabled={deleting}>
                        Cancel
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => void confirmDelete()}
                        disabled={deleting}
                        ref={deleteConfirmRef}
                      >
                        {deleting ? 'Deleting…' : deleteConfirmLabel}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}

export default ListManagerModal
