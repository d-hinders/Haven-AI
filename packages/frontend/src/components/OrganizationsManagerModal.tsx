'use client'

/**
 * Manage the organisation tree (#3164): create, rename, move, delete.
 *
 * Reached from the agents panel's ⋯ menu ("Manage organisations") and from the
 * tree's own "Add organisation". The dialog's title and the menu item are the
 * same words (#4565), and the copy inside uses the British spelling the owner
 * decided on 2026-10-30.
 *
 * #4565: the list, the rename field, the delete confirmation and the row errors
 * are `ListManagerModal`'s. What stays here is what only organisations have:
 * the create form, the move picker, and the nesting the tree shows. Deleting
 * confirms inline inside the manager — it used to mount `ConfirmDialog` over
 * itself, two dialogs at once — and its body states the guarantee the API
 * gives: the contents move up one level, no agent is deleted, spending is
 * untouched.
 *
 * A move inside this modal is a `Select` over "Top level" and every OTHER
 * organisation — the API refuses a folder inside its own subtree (400), and
 * the modal surfaces that answer rather than re-deriving it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOrganizations, type Organization } from '@/hooks/useOrganizations'
import { organizationPath, subtreeAgentCount } from '@/lib/agent-organizations'
import { orgDeleteBody } from '@/lib/organization-copy'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { InlineAlert } from '@haven_ai/ui/InlineAlert'
import { ListManagerModal } from './ListManagerModal'

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
  const { organizations, loading, error, fetchOrganizations, createOrganization, updateOrganization, deleteOrganization } =
    useOrganizations({ onChanged: onOrganizationsChanged })

  // The create form and the move picker are this manager's own actions, so
  // their busy and error states are their own: the shared manager's `saving`
  // covers renames, and its delete panel covers deletes.
  const [newName, setNewName] = useState('')
  const [newParentId, setNewParentId] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState('')
  const [moveError, setMoveError] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)

  useEffect(() => {
    if (!open) return
    setMovingId(null)
    setMoveError(null)
    setCreateError(null)
    setNewName('')
    setNewParentId('')
    void fetchOrganizations()
  }, [open, fetchOrganizations])

  const submitNew = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    setCreateError(null)
    try {
      await createOrganization(name, newParentId || null)
      setNewName('')
      setNewParentId('')
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'The organisation could not be created.')
    } finally {
      setCreating(false)
    }
  }, [createOrganization, newParentId, newName])

  const startMove = useCallback((org: Organization) => {
    setMovingId(org.id)
    setMoveTarget(org.parent_organization_id ?? '')
    setMoveError(null)
  }, [])

  const saveMove = useCallback(
    async (org: Organization) => {
      setMoving(true)
      setMoveError(null)
      try {
        await updateOrganization(org.id, { parent_organization_id: moveTarget || null })
        setMovingId(null)
      } catch (err) {
        setMoveError(err instanceof Error ? err.message : 'This move could not be saved.')
      } finally {
        setMoving(false)
      }
    },
    [moveTarget, updateOrganization],
  )

  // #3236: the catch is the point — without it a rejected DELETE escapes past
  // the call site as an unhandled rejection and the panel sits silent. A 404
  // means it is already gone (a lost race): refetch, tell the page, and resolve
  // so the panel closes — retrying could never succeed. Anything else rejects,
  // and the shared manager says the organisation was NOT deleted, in our words
  // rather than the server's, with the panel open for a retry.
  const removeOrganization = useCallback(
    async (org: Organization) => {
      try {
        await deleteOrganization(org.id)
      } catch (err) {
        if (httpStatusOf(err) === 404) {
          void fetchOrganizations()
          // The page's own tree holds its own copy of the list: tell it too,
          // exactly as a successful delete does through `onChanged` (#3236
          // round 2 — the tree kept listing the folder that was already gone).
          onOrganizationsChanged?.()
          return
        }
        throw err
      }
    },
    [deleteOrganization, fetchOrganizations, onOrganizationsChanged],
  )

  /** Move options: every organisation except the one being moved. */
  const moveOptions = useMemo(
    () => organizations.filter((o) => o.id !== movingId),
    [organizations, movingId],
  )

  return (
    <ListManagerModal<Organization>
      open={open}
      onClose={onClose}
      title="Manage organisations"
      subtitle="Create, rename, move and delete the organisations your agents file under."
      items={organizations}
      loading={loading}
      loadError={error}
      onReload={() => void fetchOrganizations()}
      loadingLabel="Loading organisations"
      emptyMessage="No organisations yet. Add the first one above."
      listTestId="organization-manager-list"
      renameInputLabel="Organisation name"
      onRename={(org, name) => updateOrganization(org.id, { name }).then(() => undefined)}
      onDelete={removeOrganization}
      deleteTitle={(org) => `Delete ${org.name}?`}
      deleteBody={(org) => (
        <p>
          {orgDeleteBody(
            organizations.filter((o) => o.parent_organization_id === org.id).length,
            org.agent_count ?? 0,
          )}
        </p>
      )}
      deleteConfirmLabel="Delete organisation"
      header={
        <div className="mb-4" data-testid="organization-create-form">
          <p className="mb-1.5 text-xs font-medium text-[var(--v2-ink-3)]">Add an organisation</p>
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
              placeholder="Organisation name"
              aria-label="New organisation name"
              className="flex-1"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => void submitNew()}
              disabled={creating || newName.trim().length === 0}
            >
              Add
            </Button>
          </div>
          {organizations.length > 0 && (
            <Select
              aria-label="Place the new organisation inside"
              value={newParentId}
              onChange={(event) => setNewParentId(event.target.value)}
              className="mt-2"
            >
              <option value="">Top level</option>
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {organizationPath(organizations, org.id)}
                </option>
              ))}
            </Select>
          )}
          {/* #3236: a rejected POST (409 sibling-name collision is the common
              case) used to show nothing. Its own state, rendered below the
              "place inside" select the message refers to ("in that place"). */}
          {createError ? (
            <div className="mt-2">
              <InlineAlert>{createError}</InlineAlert>
            </div>
          ) : null}
        </div>
      }
      renderRowMeta={(org) => (
        <p className="text-xs text-[var(--v2-ink-3)] [overflow-wrap:anywhere]">
          {org.parent_organization_id
            ? organizationPath(organizations, org.parent_organization_id)
            : 'Top level'}
          {' · '}
          {/* The subtree count — the number the tree and the filter show — with
              the direct count beside it when they differ (#3222 re-review). */}
          <OrgAgentCount total={subtreeAgentCount(organizations, org.id)} direct={org.agent_count} />
        </p>
      )}
      renderRowActions={(org, api) => (
        <Button
          variant="tertiary"
          size="sm"
          onClick={() => startMove(org)}
          aria-label={`Move ${org.name}`}
          disabled={api.editing}
        >
          Move
        </Button>
      )}
      renderRowOverride={(org) => {
        if (movingId !== org.id) return null
        return (
          <div className="space-y-2">
            {/* #3222 re-review: the row's own name stays visible while moving —
                the Select's value used to read as if it were the folder being
                moved. */}
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--v2-ink)] [overflow-wrap:anywhere]">{org.name}</p>
              <p className="text-xs text-[var(--v2-ink-3)] [overflow-wrap:anywhere]">
                {org.parent_organization_id
                  ? organizationPath(organizations, org.parent_organization_id)
                  : 'Top level'}
              </p>
            </div>
            <label htmlFor={`move-target-${org.id}`} className="block text-xs font-medium text-[var(--v2-ink-2)]">
              Move inside
            </label>
            {/* No aria-label: the visible "Move inside" label names it, so the
                accessible name contains the visible text (WCAG 2.5.3). */}
            <Select
              id={`move-target-${org.id}`}
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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMovingId(null)
                  setMoveError(null)
                }}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => void saveMove(org)} disabled={moving} className="flex-1">
                Move
              </Button>
            </div>
            {moveError ? <InlineAlert>{moveError}</InlineAlert> : null}
          </div>
        )
      }}
    />
  )
}

/** "3 agents", or "3 agents (1 directly)" when the subtree holds more than the folder itself. */
function OrgAgentCount({ total, direct }: { total: number; direct: number }) {
  return (
    <>
      <span className="v2-tabular">{total}</span>
      {total === 1 ? ' agent' : ' agents'}
      {direct !== total ? (
        <>
          {' ('}
          <span className="v2-tabular">{direct}</span>
          {' directly)'}
        </>
      ) : null}
    </>
  )
}

/** The HTTP status an API failure carries (`ApiRequestError.status`), if any. */
function httpStatusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status
    return typeof status === 'number' ? status : undefined
  }
  return undefined
}
