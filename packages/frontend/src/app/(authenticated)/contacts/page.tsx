'use client'

import { useState, type FormEvent, type MouseEvent } from 'react'
import { useContacts, type Contact } from '@/hooks/useContacts'
import { ApiRequestError } from '@/lib/api'
import { truncate, isValidAddress } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'

function ContactIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 19.128A8.97 8.97 0 0 0 18 19.5a8.96 8.96 0 0 0 4.121-.997 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003A6.374 6.374 0 0 0 12.75 14.25M15 19.128A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12.75 14.25A3.375 3.375 0 1 0 6 14.25a3.375 3.375 0 0 0 6.75 0Zm8.25-6a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"
      />
    </svg>
  )
}

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const initials =
    parts.length >= 2
      ? `${parts[0][0]}${parts[parts.length - 1][0]}`
      : (parts[0] ?? '?').slice(0, 2)

  return (
    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-[var(--v2-brand)]/20 bg-[var(--v2-brand-soft)]">
      <span className="text-xs font-semibold text-[var(--v2-brand)]">{initials.toUpperCase()}</span>
    </div>
  )
}

interface ContactModalProps {
  mode: 'add' | 'edit'
  initial?: { id: string; name: string; address: string }
  existingContacts?: Contact[]
  onSave: (name: string, address: string) => Promise<void>
  onClose: () => void
}

function ContactModal({ mode, initial, existingContacts = [], onSave, onClose }: ContactModalProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [address, setAddress] = useState(initial?.address ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const trimmedAddress = address.trim()
  const duplicateContact =
    mode === 'add' && isValidAddress(trimmedAddress)
      ? existingContacts.find((contact) => contact.address.toLowerCase() === trimmedAddress.toLowerCase()) ?? null
      : null

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError('Enter a contact name.')
      return
    }
    if (mode === 'add' && !isValidAddress(trimmedAddress)) {
      setError('Enter a valid recipient address.')
      return
    }
    if (duplicateContact) {
      setError(`This address is already saved as ${duplicateContact.name}.`)
      return
    }

    setSaving(true)
    setError('')
    try {
      await onSave(name.trim(), trimmedAddress)
      onClose()
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'We could not save this contact. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      closeOnBackdrop={!saving}
      title={mode === 'add' ? 'Add contact' : 'Edit contact'}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
          Save a name for a recipient address so payment reviews can show who you are paying.
          The payment network is chosen when you send from a Haven wallet.
        </p>

        <div>
          <label htmlFor="contact-name" className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-2)]">
            Contact name
          </label>
          <Input
            id="contact-name"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError('')
            }}
            placeholder="Acme Services"
          />
        </div>

        {mode === 'add' ? (
          <div>
            <label htmlFor="contact-address" className="mb-1.5 block text-xs font-medium text-[var(--v2-ink-2)]">
              Recipient address
            </label>
            <Input
              id="contact-address"
              type="text"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value)
                setError('')
              }}
              placeholder="0x..."
              className="font-mono"
            />
          </div>
        ) : initial ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-[var(--v2-ink-2)]">Recipient address</p>
            <p className="break-all rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-2 font-mono text-sm text-[var(--v2-ink-2)]">
              {initial.address}
            </p>
          </div>
        ) : null}

        {duplicateContact && !error && (
          <div className="rounded-lg border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] px-3 py-2.5 text-xs leading-relaxed text-[var(--v2-warning)]">
            This address is already saved as <span className="font-medium">{duplicateContact.name}</span>.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2.5 text-sm text-[var(--v2-danger)]">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !!duplicateContact} className="flex-1">
            {saving ? 'Saving...' : mode === 'add' ? 'Add contact' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

interface ContactRowProps {
  contact: Contact
  onEdit: (contact: Contact) => void
  onDelete: (contact: Contact) => void
}

function ContactRow({ contact, onEdit, onDelete }: ContactRowProps) {
  const [copied, setCopied] = useState(false)

  const copyAddress = async (event: MouseEvent) => {
    event.preventDefault()
    await navigator.clipboard.writeText(contact.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--v2-surface)]">
      <Initials name={contact.name} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{contact.name}</p>
        <p className="mt-0.5 font-mono text-xs text-[var(--v2-ink-3)]">{truncate(contact.address)}</p>
      </div>

      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={copyAddress}
          aria-label={copied ? 'Address copied' : 'Copy address'}
          title={copied ? 'Address copied' : 'Copy address'}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 sm:h-9 sm:w-9"
        >
          {copied ? (
            <svg className="h-4 w-4 text-[var(--v2-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          ) : (
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 8.25V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.25" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 10a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8Z" />
            </svg>
          )}
        </button>

        <button
          type="button"
          onClick={() => onEdit(contact)}
          aria-label={`Edit ${contact.name}`}
          title="Edit contact"
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 sm:h-9 sm:w-9"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => onDelete(contact)}
          aria-label={`Delete ${contact.name}`}
          title="Delete contact"
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-danger-soft)] hover:text-[var(--v2-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 sm:h-9 sm:w-9"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75v7.5m4.5-7.5v7.5M4.5 6.75h15m-12 0 .75 12A2.25 2.25 0 0 0 10.5 21h3a2.25 2.25 0 0 0 2.25-2.25l.75-12m-6-3h3a1.5 1.5 0 0 1 1.5 1.5v1.5h-6v-1.5a1.5 1.5 0 0 1 1.5-1.5Z" />
          </svg>
        </button>
      </div>
    </div>
  )
}

interface DeleteConfirmProps {
  contact: Contact
  onConfirm: () => Promise<void>
  onClose: () => void
}

function DeleteConfirm({ contact, onConfirm, onClose }: DeleteConfirmProps) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  const handleDelete = async () => {
    setDeleting(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch {
      setError('We could not delete this contact. Try again.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Modal
      open
      onClose={deleting ? () => {} : onClose}
      closeOnBackdrop={!deleting}
      title="Delete contact"
    >
      <div className="space-y-4">
        <p>
          Delete <span className="font-medium text-[var(--v2-ink)]">{contact.name}</span>? This removes the saved
          name from Haven, but it does not affect past payments.
        </p>
        <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3">
          <p className="text-sm font-medium text-[var(--v2-ink)]">{contact.name}</p>
          <p className="mt-0.5 font-mono text-xs text-[var(--v2-ink-3)]">{truncate(contact.address)}</p>
        </div>
        {error && (
          <div className="rounded-lg border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2.5 text-sm text-[var(--v2-danger)]">
            {error}
          </div>
        )}
        <div className="flex gap-3 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={deleting} className="flex-1">
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleDelete} disabled={deleting} className="flex-1">
            {deleting ? 'Deleting...' : 'Delete contact'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export default function ContactsPage() {
  const { contacts, loading, error, refetch, addContact, updateContact, deleteContact } = useContacts()
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editTarget, setEditTarget] = useState<Contact | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null)

  const filtered = contacts.filter(
    (contact) =>
      contact.name.toLowerCase().includes(search.toLowerCase()) ||
      contact.address.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)]">Contacts</h1>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-[var(--v2-ink-2)]">
            Save recipients you pay often so payment reviews show names instead of only wallet addresses.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)} className="sm:flex-shrink-0">
          Add contact
        </Button>
      </div>

      {contacts.length > 0 && (
        <div className="relative mb-4">
          <label htmlFor="contacts-search" className="sr-only">Search contacts</label>
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--v2-ink-3)]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <Input
            id="contacts-search"
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or address"
            className="pl-9"
          />
        </div>
      )}

      {loading && (
        <div className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)]">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-center gap-3 border-b border-[var(--v2-border)] px-4 py-3 last:border-b-0">
              <div className="h-9 w-9 flex-shrink-0 animate-pulse rounded-full bg-[var(--v2-surface-2)]" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-32 animate-pulse rounded bg-[var(--v2-surface-2)]" />
                <div className="h-2 w-24 animate-pulse rounded bg-[var(--v2-surface-2)]" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && error && (
        <EmptyState
          icon={<ContactIcon />}
          title="Contacts could not load"
          body={error}
          action={<Button onClick={() => { void refetch() }}>Try again</Button>}
        />
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)]">
          <div className="divide-y divide-[var(--v2-border)]">
            {filtered.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                onEdit={setEditTarget}
                onDelete={setDeleteTarget}
              />
            ))}
          </div>
        </div>
      )}

      {!loading && !error && contacts.length > 0 && filtered.length === 0 && (
        <EmptyState
          title="No matching contacts"
          body={`No saved recipients match "${search}".`}
          action={<Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button>}
        />
      )}

      {!loading && !error && contacts.length === 0 && (
        <EmptyState
          icon={<ContactIcon />}
          title="No saved recipients yet"
          body="Add a contact for any wallet address you pay often. Haven will show the name in Send, approvals, and transaction history. You confirm the network when sending."
          action={<Button onClick={() => setShowAdd(true)}>Add your first contact</Button>}
        />
      )}

      {showAdd && (
        <ContactModal
          mode="add"
          existingContacts={contacts}
          onSave={async (name, address) => { await addContact(name, address) }}
          onClose={() => setShowAdd(false)}
        />
      )}

      {editTarget && (
        <ContactModal
          mode="edit"
          initial={editTarget}
          onSave={async (name) => { await updateContact(editTarget.id, name) }}
          onClose={() => setEditTarget(null)}
        />
      )}

      {deleteTarget && (
        <DeleteConfirm
          contact={deleteTarget}
          onConfirm={() => deleteContact(deleteTarget.id)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
