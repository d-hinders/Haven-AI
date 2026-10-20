'use client'

import { Monogram } from '@/components/ui/Monogram'
import { Check, Copy, Info, Pencil, Trash2, Users } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useEffect, useId, useState, type FormEvent, type MouseEvent } from 'react'
import { useContacts, type Contact } from '@/hooks/useContacts'
import { useContactChains } from '@/hooks/useContactChains'
import { resolveChainOrNull } from '@/lib/chains'
import { ApiRequestError } from '@/lib/api'
import { isValidAddress } from '@/lib/format'
import { Address } from '@/components/haven'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { ListNoMatch, ListToolbar } from '@/components/ui/ListToolbar'
import type { ListFacet } from '@/components/ui/FacetMenu'
import type { ListNoun } from '@/components/ui/list-controls-copy'
import { clearedListState, type ListState, type ListUrlSchema } from '@/components/ui/list-url-codec'
import { useListUrlState } from '@/components/ui/useListUrlState'
import type { ChainScope } from '@/hooks/useChainScope'

// Per-chain dot colour for the "Used on" badges (Base blue, Base Sepolia amber
// to flag the testnet; any other chain falls back to neutral grey).
const CHAIN_DOT: Record<number, string> = {
  8453: 'var(--v2-chain-base)',
  84532: 'var(--v2-chain-testnet)',
}

function chainDotColor(chainId: number): string {
  return CHAIN_DOT[chainId] ?? 'var(--v2-ink-3)'
}

function chainName(chainId: number): string {
  return resolveChainOrNull(chainId)?.name ?? `Chain ${chainId}`
}

function ContactIcon() {
  return (
    <Icon icon={Users} className="h-5 w-5" />
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
  // Binds the footer's submit button to the form in the body (#1946). Two of
  // these dialogs never coexist, but a generated id costs nothing and cannot
  // collide with anything else on the page.
  const formId = useId()

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
      /*
        #1946: the actions live in the footer, which `ui/Modal` renders OUTSIDE
        the scrolling body. Measured before moving them, because an unmeasured
        fix is a change with no defect behind it: with the duplicate-address
        hint showing, this dialog's body overflows and the Save button sat 37px
        below the fold on a landscape phone (844x390) and 27px below at 200%
        browser zoom (640x400, which WCAG 1.4.4 requires to work). With the
        save-error box showing instead, both numbers go to ~98px and ~89px.
        Neither of #1946's other two candidates could be made to overflow at any
        supported viewport, so neither was touched.

        The submit button reaches the form below by `form={formId}` rather than
        by nesting, which is what keeps Enter-in-a-text-field submitting.
      */
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={saving || !!duplicateContact}>
            {saving ? 'Saving...' : mode === 'add' ? 'Add contact' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
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
          <div className="rounded-lg border border-danger/20 bg-[var(--v2-danger-soft)] px-3 py-2.5 text-sm text-[var(--v2-danger)]">
            {error}
          </div>
        )}

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
      <Monogram name={contact.name} />

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
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 sm:h-9 sm:w-9"
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
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 sm:h-9 sm:w-9"
        >
          <Icon icon={Pencil} className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={() => onDelete(contact)}
          aria-label={`Delete ${contact.name}`}
          title="Delete contact"
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-danger-soft)] hover:text-[var(--v2-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80 sm:h-9 sm:w-9"
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
          <div className="rounded-lg border border-danger/20 bg-[var(--v2-danger-soft)] px-3 py-2.5 text-sm text-[var(--v2-danger)]">
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

const contactNoun: ListNoun = { one: 'contact', other: 'contacts' }

/**
 * The page URL's keys (#4115, epic #4108). Contacts carried no URL state
 * before, so there are no legacy aliases: search is `q`, network is
 * `chainId` — the same network key every page uses. The chain facet lists no
 * `values`: its options derive from contacts' activity and load
 * asynchronously, so a value read before they arrive must survive.
 */
const contactsUrlSchema: ListUrlSchema = {
  facets: [{ id: 'chainId' }],
}

export default function ContactsPage() {
  const { contacts, loading, error, refetch, addContact, updateContact, deleteContact } = useContacts()
  const { chainsByAddress } = useContactChains()
  // #4115: the controls ride the list-controls pattern, and their state is
  // the URL — a shared link (or a refresh) lands on the same filtered list
  // the sender saw, and back/forward re-seeds it. Filtering runs in the
  // browser: the contact list is small, unpaged and already in memory.
  const [listState, setListState] = useListUrlState(contactsUrlSchema, { filtering: 'browser' })
  const [showAdd, setShowAdd] = useState(false)
  const [editTarget, setEditTarget] = useState<Contact | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null)

  const chainsFor = (address: string): number[] =>
    chainsByAddress.get(address.toLowerCase()) ?? []

  // The URL's `chainId` is the network scope the page's own state held
  // before #4115 (#634, epic #625): every chain unless one is picked. A
  // value that is not a network id is dropped here, as #4111 drops it on
  // Transactions — it would otherwise raise a "Network" chip over an
  // unfiltered list.
  const chainId = Number(listState.facets.chainId?.[0])
  const invalidChainId = listState.facets.chainId?.length === 1 && !(Number.isInteger(chainId) && chainId > 0)
  useEffect(() => {
    if (!invalidChainId) return
    setListState({ ...listState, facets: { ...listState.facets, chainId: [] } })
    // Once per bad link: the rewrite removes what it keys on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invalidChainId])
  const scope: ChainScope = invalidChainId || listState.facets.chainId?.length !== 1 ? 'all' : chainId

  // Chains present across all contacts' activity — the options for the facet.
  // The toolbar hides a facet with one option, and an empty option list while
  // the chains load is hidden with it.
  const filterableChains = Array.from(
    new Set(contacts.flatMap((c) => chainsFor(c.address))),
  ).sort((a, b) => a - b)

  const facets: ListFacet[] = [
    {
      id: 'chainId',
      label: 'Network',
      options: filterableChains.map((id) => ({ value: String(id), label: chainName(id) })),
    },
  ]

  const filtered = contacts.filter((contact) => {
    const q = listState.q.trim().toLowerCase()
    const matchesSearch =
      contact.name.toLowerCase().includes(q) ||
      contact.address.toLowerCase().includes(q)
    if (!matchesSearch) return false
    if (scope === 'all') return true
    return chainsFor(contact.address).includes(scope)
  })

  // Clear filters returns to the page default, the same state the toolbar's
  // own Clear filters reaches.
  const handleClearFilters = () => {
    setListState(clearedListState(listState, contactsUrlSchema))
  }

  // The standard no-match state (#4110): it sits where the rows were — in
  // place of the list card, not inside it — and leaves the toolbar in place,
  // so the cause stays editable. A list with NOTHING yet keeps the page's own
  // "No saved recipients yet" empty state below.
  const showNoMatch = !loading && !error && contacts.length > 0 && filtered.length === 0

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
        <div className="mb-4">
          <ListToolbar
            noun={contactNoun}
            state={listState}
            onChange={setListState}
            filtering="browser"
            facets={facets}
            searchDescription="by name or address"
            count={loading ? null : { shown: filtered.length, total: contacts.length }}
          />
        </div>
      )}

      {loading && (
        <div
          role="status"
          aria-busy="true"
          aria-live="polite"
          aria-label="Loading contacts"
          className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card"
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
        <div className="overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card">
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

      {showNoMatch && (
        <div data-testid="contacts-no-match">
          <ListNoMatch noun={contactNoun} onClear={handleClearFilters} />
        </div>
      )}

      {!loading && !error && contacts.length === 0 && (
        <EmptyState
          icon={<ContactIcon />}
          title="No saved recipients yet"
          body="Add a contact for any wallet address you pay often. Haven will show the name in Send and transaction history. You confirm the network when sending."
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
