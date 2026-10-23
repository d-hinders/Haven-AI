'use client'

/**
 * The profile name editor, extracted from the old `/profile` page (#4358):
 * an inline Edit → input → Save/Cancel flow that writes
 * `PUT /user/profile` and pushes the new name into `AuthContext`. Rendered
 * as one `SettingsRow` inside Settings → General → Profile — the same
 * behaviour `/profile` had, on the settings row rhythm.
 *
 * All copy goes through i18n and "Member since" dates render with the
 * repo's shared `en-GB` formatter (`lib/format.ts` `formatLongDate`) — the
 * old hard-coded English strings and `en-US` date left with `/profile`.
 */

import { useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { api, ApiRequestError } from '@/lib/api'
import { displayName } from '@/lib/user'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SettingsRow } from '@/components/ui/SettingsSection'
import { useT } from '@/context/LocaleContext'

const MAX_NAME_LENGTH = 80
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/

function validateName(
  value: string,
  t: ReturnType<typeof useT>['settings']['profile'],
): { name: string; error: null } | { name: null; error: string } {
  const normalized = value.trim().replace(/\s+/g, ' ')

  if (!normalized) {
    return { name: null, error: t.errorEmpty }
  }

  if (CONTROL_CHAR_RE.test(value)) {
    return { name: null, error: t.errorControlChar }
  }

  if (normalized.length > MAX_NAME_LENGTH) {
    return { name: null, error: t.errorTooLong }
  }

  return { name: normalized, error: null }
}

export function ProfileNameEditor() {
  const { user, updateUser } = useAuth()
  const t = useT().settings.profile
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [nameError, setNameError] = useState('')
  const [nameSaved, setNameSaved] = useState(false)
  const [savingName, setSavingName] = useState(false)

  useEffect(() => {
    if (!editingName) {
      setNameDraft(user?.name ?? '')
    }
  }, [editingName, user?.name])

  function cancelEdit() {
    setEditingName(false)
    setNameDraft(user?.name ?? '')
    setNameError('')
  }

  async function saveName() {
    const validation = validateName(nameDraft, t)
    setNameSaved(false)

    if (validation.error) {
      setNameError(validation.error)
      return
    }

    setSavingName(true)
    setNameError('')

    try {
      const updated = await api.put<{ name: string }>('/user/profile', { name: validation.name })
      updateUser({ name: updated.name })
      setEditingName(false)
      setNameSaved(true)
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setNameError(err.message || t.errorGeneric)
      } else {
        setNameError(t.errorGeneric)
      }
    } finally {
      setSavingName(false)
    }
  }

  return (
    <SettingsRow
      label={
        editingName ? (
          <label htmlFor="profile-name" className="text-sm font-medium text-[var(--v2-ink)]">
            {t.nameLabel}
          </label>
        ) : (
          t.nameLabel
        )
      }
      detail={
        editingName ? (
          <div className="mt-2 max-w-sm">
            <Input
              id="profile-name"
              value={nameDraft}
              onChange={(event) => {
                setNameDraft(event.target.value)
                setNameError('')
                setNameSaved(false)
              }}
              autoComplete="name"
              invalid={Boolean(nameError)}
              helperText={nameError || t.helperText}
              aria-invalid={Boolean(nameError)}
            />
          </div>
        ) : (
          <>
            <p>{displayName(user)}</p>
            {nameSaved ? (
              <p className="mt-1 text-xs text-[var(--v2-success)]" role="status">
                {t.saved}
              </p>
            ) : null}
          </>
        )
      }
      action={
        editingName ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void saveName()
            }}
            className="flex shrink-0 items-center gap-2"
          >
            <Button variant="tertiary" size="sm" disabled={savingName} onClick={cancelEdit}>
              {t.cancel}
            </Button>
            <Button type="submit" size="sm" disabled={savingName}>
              {savingName ? t.saving : t.save}
            </Button>
          </form>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditingName(true)
              setNameSaved(false)
            }}
          >
            {t.edit}
          </Button>
        )
      }
    />
  )
}

export default ProfileNameEditor
