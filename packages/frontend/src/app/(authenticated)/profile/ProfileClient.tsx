'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { api, ApiRequestError } from '@/lib/api'
import { displayName } from '@/lib/user'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatusBadge } from '@/components/ui/StatusBadge'

const MAX_NAME_LENGTH = 80
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/

function formatDate(value?: string): string {
  if (!value) return 'Not available'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not available'

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

function validateName(value: string): { name: string; error: null } | { name: null; error: string } {
  const normalized = value.trim().replace(/\s+/g, ' ')

  if (!normalized) {
    return { name: null, error: 'Enter a name for your Haven account.' }
  }

  if (CONTROL_CHAR_RE.test(value)) {
    return { name: null, error: 'Remove unsupported characters before saving.' }
  }

  if (normalized.length > MAX_NAME_LENGTH) {
    return { name: null, error: 'Use 80 characters or fewer.' }
  }

  return { name: normalized, error: null }
}

function ProfileDetail({
  label,
  value,
  description,
}: {
  label: string
  value: string
  description?: string
}) {
  return (
    <div className="flex flex-col gap-1 border-t border-[var(--v2-border)] px-6 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div>
        <p className="text-sm font-medium text-[var(--v2-ink)]">{label}</p>
        {description ? (
          <p className="mt-1 text-sm text-[var(--v2-ink-3)]">{description}</p>
        ) : null}
      </div>
      <p className="break-words text-sm text-[var(--v2-ink-2)] sm:max-w-md sm:text-right">{value}</p>
    </div>
  )
}

export default function ProfileClient() {
  const { user, updateUser } = useAuth()
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
    const validation = validateName(nameDraft)
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
        setNameError(err.message || 'We could not save your name. Please try again.')
      } else {
        setNameError('We could not save your name. Please try again.')
      }
    } finally {
      setSavingName(false)
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Profile"
        subtitle="Manage the personal details shown on your Haven account."
      />

      <Card hover={false} className="overflow-hidden">
        <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="v2-text-h3 text-[var(--v2-ink)]">Personal profile</h2>
            <StatusBadge tone="brand">Haven account</StatusBadge>
          </div>
          <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
            Keep your name recognizable for account notices and support.
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            void saveName()
          }}
          className="px-6 py-5"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <label htmlFor="profile-name" className="text-sm font-medium text-[var(--v2-ink)]">
                Name
              </label>
              {editingName ? (
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
                    helperText={nameError || 'Use the name you want shown in Haven.'}
                    aria-invalid={Boolean(nameError)}
                  />
                </div>
              ) : (
                <>
                  <p className="mt-1 text-sm text-[var(--v2-ink-2)]">{displayName(user)}</p>
                  {nameSaved ? (
                    <p className="mt-1 text-xs text-[var(--v2-success)]" role="status">
                      Name updated.
                    </p>
                  ) : null}
                </>
              )}
            </div>

            {editingName ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="tertiary" size="sm" disabled={savingName} onClick={cancelEdit}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={savingName}>
                  {savingName ? 'Saving...' : 'Save'}
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingName(true)
                  setNameSaved(false)
                }}
              >
                Edit
              </Button>
            )}
          </div>
        </form>

        <ProfileDetail
          label="Email"
          value={user?.email ?? 'Not available'}
          description="Used for sign-in and account recovery support."
        />
        <ProfileDetail
          label="Account created"
          value={formatDate(user?.created_at)}
        />
      </Card>
    </div>
  )
}
