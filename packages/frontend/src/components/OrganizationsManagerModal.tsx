'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Pencil, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useOrganizations, type Organization } from '@/hooks/useOrganizations'
import { organizationPath } from '@/lib/agent-organizations'
import { orgDeleteBody } from '@/lib/organization-copy'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import ConfirmDialog from './ConfirmDialog'

/**
 * Manage the organization tree (#3164): create, rename, move, delete.
 *
 * Reached from the agents panel's organization tree ("Manage") and
 * "Add organization". Deleting is the destructive path and goes through
 * `ConfirmDialog`, whose body states the guarantee the API gives: the
 * contents move up one level, no agent is deleted, spending is untouched.
 *
 * A move inside this modal is a `Select` over "Top level" and every OTHER
 * organization — the API refuses a folder inside its own subtree (400), and
 * the modal surfaces that answer rather than re-deriving it.
 */
export default function OrganizationsManagerModal({
  open,
  onClose,
  onOrganizationsChanged,
}: {
  open: boolean
  onClose: () => void
  /** Called after any change so callers can refresh agent reads (placement rides on the agent rows). */
  onOrganizationsChanged?: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  const { organizations, loading, error, fetchOrganizations, createOrganization, updateOrganization, deleteOrganization } =
    useOrganizations({ onChanged: onOrganizationsChanged })

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [movingId, setMovingId] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState('')
  const [newName, setNewName] = useState('')
  const [newParentId, setNewParentId] = useState('')
  const [rowError, setRowError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Organization | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setEditingId(null)
      setMovingId(null)
      setRowError(null)
      setNewName('')
      setNewParentId('')
      setDeleteError(null)
      void fetchOrganizations()
    }
  }, [open, fetchOrganizations])

  const handleClose = useCallback(() => {
    if (saving || deleting) return
    onClose()
  }, [onClose, saving, deleting])

  useEscapeToClose(open, handleClose, { enabled: !saving && !deleting })

  const startRename = useCallback((org: Organization) => {
    setEditingId(org.id)
    setEditName(org.name)
    setMovingId(null)
    setRowError(null)
  }, [])

  const saveRename = useCallback(
    async (org: Organization) => {
      const name = editName.trim()
      if (!name || name === org.name) {
        setEditingId(null)
        return
      }
      setSaving(true)
      setRowError(null)
      try {
        await updateOrganization(org.id, { name })
        setEditingId(null)
      } catch (err) {
        setRowError(err instanceof Error ? err.message : 'This name could not be saved.')
      } finally {
        setSaving(false)
      }
    },
    [editName, updateOrganization],
  )

  const startMove = useCallback((org: Organization) => {
    setMovingId(org.id)
    setMoveTarget(org.parent_organization_id ?? '')
    setEditingId(null)
    setRowError(null)
  }, [])

  const saveMove = useCallback(
    async (org: Organization) => {
      setSaving(true)
      setRowError(null)
      try {
        await updateOrganization(org.id, { parent_organization_id: moveTarget || null })
        setMovingId(null)
      } catch (err) {
        setRowError(err instanceof Error ? err.message : 'This move could not be saved.')
      } finally {
        setSaving(false)
      }
    },
    [moveTarget, updateOrganization],
  )

  const submitNew = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    setSaving(true)
    setRowError(null)
    try {
      await createOrganization(name, newParentId || null)
      setNewName('')
      setNewParentId('')
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'The organization could not be created.')
    } finally {
      setSaving(false)
    }
  }, [createOrganization, newParentId, newName])

  const startDelete = useCallback((org: Organization) => {
    setDeleteError(null)
    setDeleteTarget(org)
  }, [])

  // #3236: the catch is the point — without it a rejected DELETE escapes past
  // the `void confirmDelete()` call site as an unhandled rejection and the
  // dialog sits silent. The error renders inside the confirm dialog, which
  // stays open (the organization was not deleted).
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteOrganization(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'The organization could not be deleted.')
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleteOrganization])

  /** Move options: every organization except the one being moved. */
  const moveOptions = useMemo(
    () => organizations.filter((o) => o.id !== movingId),
    [organizations, movingId],
  )
  const newParentOptions = useMemo(() => organizations, [organizations])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center v2-safe-overlay [--v2-safe-gutter:1rem] v2-modal-backdrop">
      <div className="absolute inset-0" onClick={handleClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage organizations"
        className="relative max-h-[calc(90vh-var(--v2-safe-top)-var(--v2-safe-bottom))] w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-[var(--v2-ink)]">Manage organizations</h2>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
              Create, rename, move and remove the organizations your agents file under.
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
          {/* Create */}
          <div className="mb-4" data-testid="organization-create-form">
            <p className="mb-1.5 text-xs font-medium text-[var(--v2-ink-3)]">Add an organization</p>
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void submitNew()
                  }
                }}
                placeholder="Organization name"
                aria-label="New organization name"
                className="flex-1"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void submitNew()}
                disabled={saving || newName.trim().length === 0}
              >
                Add
              </Button>
            </div>
            {/* #3236: rowError had no render site on the create form — a
                rejected POST (409 sibling-name collision is the common case)
                did nothing visible. It renders here, next to the form. */}
            {rowError ? (
              <p role="alert" className="mt-2 text-xs text-[var(--v2-danger)]">
                {rowError}
              </p>
            ) : null}
            {organizations.length > 0 && (
              <Select
                aria-label="Place the new organization inside"
                value={newParentId}
                onChange={(event) => setNewParentId(event.target.value)}
                className="mt-2"
              >
                <option value="">Top level</option>
                {newParentOptions.map((org) => (
                  <option key={org.id} value={org.id}>
                    {organizationPath(organizations, org.id)}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {loading ? (
            <div role="status" aria-busy="true" className="space-y-2">
              <div className="h-9 animate-pulse rounded-md bg-[var(--v2-surface-2)]" />
              <div className="h-9 animate-pulse rounded-md bg-[var(--v2-surface-2)]" />
              <span className="sr-only">Loading organizations</span>
            </div>
          ) : error ? (
            <div className="space-y-3 text-center">
              <p className="text-sm text-[var(--v2-ink-2)]">{error}</p>
              <Button variant="ghost" onClick={() => void fetchOrganizations()}>
                Try again
              </Button>
            </div>
          ) : organizations.length === 0 ? (
            <p className="py-4 text-center text-sm text-[var(--v2-ink-2)]">
              No organizations yet. Add the first one above.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="organization-manager-list">
              {organizations.map((org) => (
                <li key={org.id} className="rounded-lg border border-[var(--v2-border)] p-3">
                  {editingId === org.id ? (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <Input
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void saveRename(org)
                            }
                          }}
                          aria-label="Organization name"
                          className="flex-1"
                        />
                        <Button size="sm" onClick={() => void saveRename(org)} disabled={saving}>
                          Save
                        </Button>
                      </div>
                      {rowError ? (
                        <p role="alert" className="text-xs text-[var(--v2-danger)]">{rowError}</p>
                      ) : null}
                    </div>
                  ) : movingId === org.id ? (
                    <div className="space-y-2">
                      <Select
                        aria-label={`Move ${org.name} inside`}
                        value={moveTarget}
                        onChange={(event) => setMoveTarget(event.target.value)}
                      >
                        <option value="">Top level</option>
                        {moveOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {organizationPath(organizations, option.id)}
                          </option>
                        ))}
                      </Select>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setMovingId(null)} className="flex-1">
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => void saveMove(org)} disabled={saving} className="flex-1">
                          Move
                        </Button>
                      </div>
                      {rowError ? (
                        <p role="alert" className="text-xs text-[var(--v2-danger)]">{rowError}</p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="sm:flex sm:items-center sm:gap-2">
                      <div className="min-w-0 sm:flex-1">
                        <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{org.name}</p>
                        <p className="truncate text-xs text-[var(--v2-ink-3)]">
                          {org.parent_organization_id
                            ? organizationPath(organizations, org.parent_organization_id)
                            : 'Top level'}
                          {' · '}
                          <span className="v2-tabular">{org.agent_count}</span>
                          {org.agent_count === 1 ? ' agent' : ' agents'}
                        </p>
                      </div>
                      {/* Round-3 review (NB3): the name takes the FULL row
                          below `sm` and the actions sit on their own line —
                          the old `flex-1` name beside this fixed group
                          truncated every name and path to 2-3 characters at
                          390px, leaving the user unable to tell which
                          organization they were about to DELETE. At `sm` and
                          up the row shares one line as before. */}
                      <div className="mt-2 flex items-center gap-1 sm:mt-0 sm:shrink-0">
                        <Button
                          variant="tertiary"
                          size="sm"
                          onClick={() => startRename(org)}
                          aria-label={`Rename ${org.name}`}
                        >
                          <Icon icon={Pencil} className="h-3.5 w-3.5" />
                          Rename
                        </Button>
                        <Button
                          variant="tertiary"
                          size="sm"
                          onClick={() => startMove(org)}
                          aria-label={`Move ${org.name}`}
                        >
                          Move
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => startDelete(org)}
                          aria-label={`Delete ${org.name}`}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  )}
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
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : 'Delete organization?'}
        body={
          <>
            <p>
              {orgDeleteBody(
                deleteTarget
                  ? organizations.filter((o) => o.parent_organization_id === deleteTarget.id).length
                  : 0,
                deleteTarget?.agent_count ?? 0,
              )}
            </p>
            {deleteError ? (
              <p role="alert" className="mt-2 text-xs text-[var(--v2-danger)]">
                {deleteError}
              </p>
            ) : null}
          </>
        }
        confirmLabel="Delete organization"
        tone="danger"
        loading={deleting}
      />
    </div>
  )
}
