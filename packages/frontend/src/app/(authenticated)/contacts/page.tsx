'use client'

import { Check, Copy, Info, Pencil, Search, Trash2, Users } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useState, type FormEvent, type MouseEvent } from 'react'
import { useContacts, type Contact } from '@/hooks/useContacts'
import { useContactChains } from '@/hooks/useContactChains'
import { useChainScope } from '@/hooks/useActiveChain'
import { getChainConfig } from '@/lib/chains'
import { ApiRequestError } from '@/lib/api'
import { isValidAddress } from '@/lib/format'
import { Address } from '@/components/haven'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'

// Per-chain dot colour for the "Used on" badges (Base blue, Gnosis teal,
// Base Sepolia amber to flag the testnet).
const CHAIN_DOT: Record<number, string> = {
  8453: '#0052FF',
  84532: '#F59E0B',
  100: '#3E9B8F',
}

function chainDotColor(chainId: number): string {
  return CHAIN_DOT[chainId] ?? 'var(--v2-ink-3)'
}

function chainName(chainId: number): string {
  try {
    return getChainConfig(chainId).name
  } catch {
    return `Chain ${chainId}`
  }
}

function ContactIcon() {
  return (
    <Icon icon={Users} className="h-5 w-5" />
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
          <p
            role="status"
            className="flex items-start gap-2 text-xs leading-relaxed text-[var(--v2-ink-3)]"
          >
            <Icon icon={Info} className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>
              This address is already saved as{' '}
              <span className="font-medium text-[var(--v2-ink-2)]">{duplicateContact.name}</span>.
            </span>
          </p>
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
  chains: number[]
  onEdit: (contact: Contact) => void
  onDelete: (contact: Contact) => void
}

function ContactRow({ contact, chains, onEdit, onDelete }: ContactRowProps) {
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
        <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
          <Address value={contact.address} />
        </p>
        {chains.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">Used on</span>
            {chains.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 text-xs text-[var(--v2-ink-2)]">
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: chainDotColor(id) }}
                />
                {chainName(id)}
              </span>
            ))}
          </div>
        )}
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
            <Icon icon={Check} className="h-4 w-4 text-[var(--v2-success)]" />
          ) : (
            <Icon icon={Copy} className="h-4 w-4" />
          )}
        </button>

        <button
          type="button"
          onClick={() => onEdit(contact)}
          aria-label={`Edit ${contact.name}`}
          title="Edit contact"
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 sm:h-9 sm:w-9"
        >
          <Icon icon={Pencil} className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={() => onDelete(contact)}
          aria-label={`Delete ${contact.name}`}
          title="Delete contact"
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-danger-soft)] hover:text-[var(--v2-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 sm:h-9 sm:w-9"
        >
          <Icon icon={Trash2} className="h-4 w-4" />
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
          <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
            <Address value={contact.address} />
          </p>
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
  const { chainsByAddress } = useContactChains()
  // Contacts always show every chain — the active chain never collapses the
  // list. This is an optional manual filter only (#634, epic #625).
  const { scope, setScope } = useChainScope('all-chains')
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editTarget, setEditTarget] = useState<Contact | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null)

  const chainsFor = (address: string): number[] =>
    chainsByAddress.get(address.toLowerCase()) ?? []

  // Chains present across all contacts' activity — the options for the filter.
  const filterableChains = Array.from(
    new Set(contacts.flatMap((c) => chainsFor(c.address))),
  ).sort((a, b) => a - b)

  const filtered = contacts.filter((contact) => {
    const matchesSearch =
      contact.name.toLowerCase().includes(search.toLowerCase()) ||
      contact.address.toLowerCase().includes(search.toLowerCase())
    if (!matchesSearch) return false
    if (scope === 'all') return true
    return chainsFor(contact.address).includes(scope)
  })

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Contacts"
        subtitle="Save recipients you pay often so payment reviews show names instead of only wallet addresses."
        actions={
          <Button onClick={() => setShowAdd(true)}>
            Add contact
          </Button>
        }
      />

      {contacts.length > 0 && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <label htmlFor="contacts-search" className="sr-only">Search contacts</label>
            <Icon icon={Search} className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--v2-ink-3)]" />
            <Input
              id="contacts-search"
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or address"
              className="pl-9"
            />
          </div>
          {filterableChains.length > 1 && (
            <Select
              aria-label="Filter contacts by network"
              value={scope === 'all' ? 'all' : String(scope)}
              onChange={(e) => setScope(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              className="sm:max-w-[200px]"
            >
              <option value="all">All networks</option>
              {filterableChains.map((id) => (
                <option key={id} value={String(id)}>
                  {chainName(id)}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}

      {loading && (
        <div
          role="status"
          aria-busy="true"
          aria-live="polite"
          aria-label="Loading contacts"
          className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)]"
        >
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-center gap-3 border-b border-[var(--v2-border)] px-4 py-3 last:border-b-0">
              <Skeleton variant="circle" className="h-9 w-9 flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton variant="text" className="h-3 w-32" />
                <Skeleton variant="text" className="h-2 w-24" />
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
                chains={chainsFor(contact.address)}
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
          body={
            scope !== 'all' && !search
              ? `No saved recipients have activity on ${chainName(scope)}.`
              : `No saved recipients match "${search}".`
          }
          action={
            <Button variant="ghost" onClick={() => { setSearch(''); setScope('all') }}>
              Clear filters
            </Button>
          }
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
