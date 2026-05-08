'use client'

import { useState, useRef, useEffect } from 'react'
import { useContacts, type Contact } from '@/hooks/useContacts'
import { ApiRequestError } from '@/lib/api'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { truncate, isValidAddress } from '@/lib/format'

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/)
  const initials =
    parts.length >= 2
      ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
      : parts[0].slice(0, 2).toUpperCase()
  return (
    <div className="w-9 h-9 rounded-full bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
      <span className="text-xs font-semibold text-[var(--v2-brand-strong)]">{initials}</span>
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
  useEscapeToClose(true, onClose, { enabled: !saving })
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  // When adding, surface if the address is already saved under another name.
  const duplicateContact = (() => {
    if (mode !== 'add') return null
    if (!isValidAddress(address)) return null
    const normalized = address.toLowerCase()
    return existingContacts.find((c) => c.address.toLowerCase() === normalized) ?? null
  })()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (mode === 'add' && !isValidAddress(address)) {
      setError('Invalid Ethereum address')
      return
    }
    setSaving(true)
    try {
      await onSave(name.trim(), address)
      onClose()
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} />
      <div className="relative w-full max-w-sm mx-4 bg-white border border-[var(--v2-border)] rounded-xl shadow-[var(--v2-shadow-modal)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--v2-border)]">
          <h2 className="text-base font-semibold text-[var(--v2-ink)]">
            {mode === 'add' ? 'Add contact' : 'Edit contact'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 -mr-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-[var(--v2-ink-2)] mb-1.5">Name</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError('') }}
              placeholder="Alice"
              className="w-full px-3 py-2.5 bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-lg text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)] focus:ring-1 focus:ring-[var(--v2-brand)]/20 transition-colors"
            />
          </div>

          {mode === 'add' && (
            <div>
              <label className="block text-xs text-[var(--v2-ink-2)] mb-1.5">Address</label>
              <input
                type="text"
                value={address}
                onChange={(e) => { setAddress(e.target.value); setError('') }}
                placeholder="0x..."
                className="w-full px-3 py-2.5 bg-[var(--v2-surface-2)] border border-[var(--v2-border)] rounded-lg text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)] focus:ring-1 focus:ring-[var(--v2-brand)]/20 transition-colors font-mono"
              />
            </div>
          )}

          {mode === 'edit' && initial && (
            <div>
              <label className="block text-xs text-[var(--v2-ink-2)] mb-1.5">Address</label>
              <p className="px-3 py-2.5 bg-[var(--v2-surface)] border border-[var(--v2-border)] rounded-lg text-sm text-[var(--v2-ink-3)] font-mono">
                {initial.address}
              </p>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2.5">
              {error}
            </div>
          )}

          {duplicateContact && !error && (
            <div className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2.5">
              This address is already saved as{' '}
              <span className="font-medium">&ldquo;{duplicateContact.name}&rdquo;</span>.
              Saving will create a second entry.
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-lg border border-[var(--v2-border)] text-sm text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 rounded-lg bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-all duration-200 shadow-[var(--v2-shadow-button)] disabled:opacity-50"
            >
              {saving ? 'Saving...' : mode === 'add' ? 'Add contact' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface ContactRowProps {
  contact: Contact
  onEdit: (contact: Contact) => void
  onDelete: (contact: Contact) => void
}

function ContactRow({ contact, onEdit, onDelete }: ContactRowProps) {
  const [copied, setCopied] = useState(false)

  const copyAddress = async (e: React.MouseEvent) => {
    e.preventDefault()
    await navigator.clipboard.writeText(contact.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-[var(--v2-surface)] transition-colors group">
      <Initials name={contact.name} />

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--v2-ink)] truncate">{contact.name}</p>
        <p className="text-xs text-[var(--v2-ink-3)] font-mono mt-0.5">{truncate(contact.address)}</p>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={copyAddress}
          title="Copy address"
          className="p-1.5 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
        >
          {copied ? (
            <svg className="w-4 h-4 text-emerald-400 animate-check-pop" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
            </svg>
          )}
        </button>

        <button
          onClick={() => onEdit(contact)}
          title="Edit contact"
          className="p-1.5 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
          </svg>
        </button>

        <button
          onClick={() => onDelete(contact)}
          title="Delete contact"
          className="p-1.5 rounded-md text-[var(--v2-ink-3)] hover:text-red-400 hover:bg-red-400/10 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
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
  useEscapeToClose(true, onClose, { enabled: !deleting })

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await onConfirm()
      onClose()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} />
      <div className="relative w-full max-w-sm mx-4 bg-white border border-[var(--v2-border)] rounded-xl shadow-[var(--v2-shadow-modal)] p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--v2-ink)]">Delete contact</p>
            <p className="text-xs text-[var(--v2-ink-3)] mt-0.5">This action cannot be undone.</p>
          </div>
        </div>

        <div className="bg-[var(--v2-surface)] border border-[var(--v2-border)] rounded-lg px-4 py-3 mb-4">
          <p className="text-sm font-medium text-[var(--v2-ink)]">{contact.name}</p>
          <p className="text-xs text-[var(--v2-ink-3)] font-mono mt-0.5">{truncate(contact.address)}</p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg border border-[var(--v2-border)] text-sm text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex-1 py-2.5 rounded-lg bg-red-500/80 hover:bg-red-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ContactsPage() {
  const { contacts, loading, addContact, updateContact, deleteContact } = useContacts()
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editTarget, setEditTarget] = useState<Contact | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null)

  const filtered = contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.address.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">Contacts</h1>
          <p className="text-sm text-[var(--v2-ink-3)]">Save and label frequently used addresses</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-all duration-200 shadow-[var(--v2-shadow-button)]"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add contact
          </button>
        </div>
      </div>

      {contacts.length > 0 && (
        <div className="relative mb-4">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--v2-ink-3)] pointer-events-none"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or address..."
            className="w-full pl-9 pr-4 py-2.5 bg-[var(--v2-surface)] border border-[var(--v2-border)] rounded-lg text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)] focus:ring-1 focus:ring-[var(--v2-brand)]/20 transition-colors"
          />
        </div>
      )}

      {loading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 rounded-lg">
              <div className="w-9 h-9 rounded-full bg-[var(--v2-surface-2)] animate-pulse flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-32 bg-[var(--v2-surface-2)] rounded animate-pulse" />
                <div className="h-2 w-24 bg-[var(--v2-surface-2)] rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="rounded-xl border border-[var(--v2-border)] overflow-hidden">
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

      {!loading && contacts.length > 0 && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--v2-border)] py-12 text-center">
          <p className="text-sm text-[var(--v2-ink-3)]">No contacts match &quot;{search}&quot;</p>
        </div>
      )}

      {!loading && contacts.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--v2-border)] p-16 text-center">
          <div className="w-14 h-14 rounded-xl bg-indigo-500/10 flex items-center justify-center mb-5">
            <svg
              className="w-7 h-7 text-[var(--v2-brand)]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
              />
            </svg>
          </div>
          <h2 className="text-base font-semibold mb-1">No contacts yet</h2>
          <p className="text-sm text-[var(--v2-ink-3)] max-w-xs leading-relaxed mb-6">
            Save addresses with names for quick access when sending payments.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--v2-brand-soft)] border border-[var(--v2-brand)]/20 text-[var(--v2-brand)] text-sm font-medium hover:bg-[var(--v2-brand-soft)] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add your first contact
          </button>
        </div>
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
