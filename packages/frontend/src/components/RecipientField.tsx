'use client'

/**
 * The Send dialog's recipient field (#4640) — a controlled field that receives
 * its data.
 *
 * ── It owns no data and calls no data hook ──────────────────────────────────
 *
 * Each `useContacts()` call keeps its own list (`useState` in
 * `hooks/useContacts.ts`) and `addContact` updates only the instance it was
 * called on. A field that called its own hook would never see a contact the
 * Send dialog saves, so the caller owns ONE `useContacts()` and ONE
 * `useAccounts()` and passes them in. `rg -n "useContacts|useAccounts"` on this
 * file returns nothing, and that is the contract, not an accident.
 *
 * ── Precedence ──────────────────────────────────────────────────────────────
 *
 * An address can be both one of your own accounts and a saved contact. The
 * order is **own account, then contact, then new**: the account is the thing
 * Haven itself tracks, so it is the more specific answer, and showing two
 * options for one address would ask the user a question with no consequence.
 *
 * ── No last-paid line ───────────────────────────────────────────────────────
 *
 * Contacts are `{ id, name, address, created_at, updated_at }` — no chain and no
 * last-paid date — so the mockup's "Paid 3 days ago" is out. No backend change.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { isAddress } from 'viem'
import { Wallet, X } from 'lucide-react'
import { Monogram } from '@/components/ui/Monogram'
import { Icon } from '@haven_ai/ui/Icon'
import { Skeleton } from '@haven_ai/ui/Skeleton'
import { Combobox, type ComboboxGroup, type ComboboxOption } from '@/components/ui/Combobox'
import { truncate } from '@/lib/format'
import type { Contact } from '@/hooks/useContacts'
import type { SmartAccount } from '@/context/AuthContext'

/** What the field reports. `kind` is where the address came from. */
export interface Recipient {
  address: string
  name?: string
  kind: 'account' | 'contact' | 'new'
}

export interface RecipientFieldProps {
  value: Recipient | null
  onChange: (next: Recipient | null) => void
  /**
   * An address to resolve into a chip. It may arrive before the data loads: the
   * field shows the short address and resolves it to a name and kind once
   * `accounts` and `contacts` are available, calling `onChange` once.
   */
  presetAddress?: string
  /** Only own accounts on this chain are offered. */
  chainId: number
  /** The sending account — never offered. */
  excludeAddress: string
  /** The caller's `useAccounts().accounts`. */
  accounts: SmartAccount[]
  /** From the caller's single `useContacts()`. */
  contacts: Contact[]
  contactsLoading: boolean
  contactsError: string | null
  /** Accessible name of the input. */
  label?: string
  /**
   * The query the field starts with. The `/design-system` specimens use it to
   * render a filtered or pasted state deterministically; a caller that opens
   * Send with a search already in the field uses it too.
   */
  initialQuery?: string
  className?: string
}

const KIND_LABEL: Record<Recipient['kind'], string> = {
  account: 'Your account',
  contact: 'Saved contact',
  new: 'New address',
}

/** The failure line `docs/product/screen-recipes.md` requires. */
const CONTACTS_UNAVAILABLE = 'Saved recipients are unavailable. You can still paste an address.'

function matchesQuery(name: string | undefined, address: string, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  if (address.toLowerCase().startsWith(needle)) return true
  return (name ?? '').toLowerCase().startsWith(needle)
}

export function RecipientField({
  value,
  onChange,
  presetAddress,
  chainId,
  excludeAddress,
  accounts,
  contacts,
  contactsLoading,
  contactsError,
  label = 'Recipient',
  initialQuery = '',
  className = '',
}: RecipientFieldProps) {
  const [query, setQuery] = useState(initialQuery)
  // A cleared chip must stay cleared: `presetAddress` is still a prop, so the
  // fallback below would otherwise re-render the chip the user just dismissed.
  const [presetDismissed, setPresetDismissed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const changeButtonRef = useRef<HTMLButtonElement>(null)
  const focusChipRef = useRef(false)
  const focusInputRef = useRef(false)
  const resolvedPresetRef = useRef<string | null>(null)

  // #4026's filter, unchanged: the user's OTHER Haven accounts on the SAME
  // chain, deduped by address (one address can be registered on two chains).
  const ownAccounts = useMemo(() => {
    const seen = new Set<string>()
    const excluded = excludeAddress.toLowerCase()
    return accounts
      .filter((account) => account.chain_id === chainId)
      .filter((account) => {
        const address = account.account_address.toLowerCase()
        if (address === excluded) return false
        if (seen.has(address)) return false
        seen.add(address)
        return true
      })
  }, [accounts, chainId, excludeAddress])

  const trimmed = query.trim()
  const pastedAddress = isAddress(trimmed) ? trimmed : null

  const { groups, recipients } = useMemo(() => {
    const byOptionId = new Map<string, Recipient>()

    const accountOption = (account: SmartAccount): ComboboxOption => {
      const id = `account:${account.account_address.toLowerCase()}`
      byOptionId.set(id, {
        address: account.account_address,
        name: account.name,
        kind: 'account',
      })
      return {
        id,
        title: account.name,
        subtitle: `${KIND_LABEL.account} · ${truncate(account.account_address)}`,
        leading: <Monogram name={account.name} size="xs" decorative />,
      }
    }

    const contactOption = (contact: Contact): ComboboxOption => {
      const id = `contact:${contact.address.toLowerCase()}`
      byOptionId.set(id, { address: contact.address, name: contact.name, kind: 'contact' })
      return {
        id,
        title: contact.name,
        subtitle: `${KIND_LABEL.contact} · ${truncate(contact.address)}`,
        leading: <Monogram name={contact.name} size="xs" decorative />,
      }
    }

    // ── A pasted (or fully typed) address collapses the list to one entry ────
    if (pastedAddress) {
      const key = pastedAddress.toLowerCase()
      const account = ownAccounts.find((candidate) => candidate.account_address.toLowerCase() === key)
      if (account) {
        return {
          groups: [{ id: 'match', label: 'Your accounts', options: [accountOption(account)] }],
          recipients: byOptionId,
        }
      }
      const contact = contacts.find((candidate) => candidate.address.toLowerCase() === key)
      if (contact) {
        return {
          groups: [{ id: 'match', label: 'Contacts', options: [contactOption(contact)] }],
          recipients: byOptionId,
        }
      }
      const id = `new:${key}`
      byOptionId.set(id, { address: trimmed, kind: 'new' })
      return {
        groups: [
          {
            id: 'match',
            label: KIND_LABEL.new,
            options: [
              {
                id,
                title: `Send to ${truncate(trimmed)}`,
                subtitle: KIND_LABEL.new,
                leading: <Icon icon={Wallet} className="h-4 w-4" />,
              },
            ],
          },
        ],
        recipients: byOptionId,
      }
    }

    // ── The ordinary list: your accounts, then your contacts ────────────────
    const accountOptions = ownAccounts
      .filter((account) => matchesQuery(account.name, account.account_address, trimmed))
      .map(accountOption)

    const contactOptions = contacts
      .filter((contact) => matchesQuery(contact.name, contact.address, trimmed))
      .map(contactOption)

    const next: ComboboxGroup[] = []
    if (accountOptions.length > 0) {
      next.push({ id: 'accounts', label: 'Your accounts', options: accountOptions })
    }
    if (contactsLoading) {
      next.push({
        id: 'contacts',
        label: 'Contacts',
        options: [],
        status: {
          kind: 'loading',
          text: <Skeleton variant="text" className="h-3 w-32" />,
        },
      })
    } else if (contactsError) {
      next.push({
        id: 'contacts',
        label: 'Contacts',
        options: [],
        status: { kind: 'error', text: CONTACTS_UNAVAILABLE },
      })
    } else if (contactOptions.length > 0) {
      next.push({ id: 'contacts', label: 'Contacts', options: contactOptions })
    }

    return { groups: next, recipients: byOptionId }
  }, [contacts, contactsError, contactsLoading, ownAccounts, pastedAddress, trimmed])

  // ── `presetAddress` resolves once, when the data has settled ───────────────
  // The chip renders from `presetAddress` while `value` is null, so the short
  // address is on screen before the data arrives. The resolution then calls
  // `onChange` exactly once — guarded by the ref, because `onChange` is
  // routinely a fresh closure on every render.
  useEffect(() => {
    if (!presetAddress || !isAddress(presetAddress)) return
    if (value !== null) return
    const key = presetAddress.toLowerCase()
    if (resolvedPresetRef.current === key) return
    // A contact match may still be on its way; resolving now would report
    // `new` for an address the user has saved.
    if (contactsLoading) return
    const account = ownAccounts.find((candidate) => candidate.account_address.toLowerCase() === key)
    const contact = contacts.find((candidate) => candidate.address.toLowerCase() === key)
    resolvedPresetRef.current = key
    if (account) {
      onChange({ address: account.account_address, name: account.name, kind: 'account' })
    } else if (contact) {
      onChange({ address: contact.address, name: contact.name, kind: 'contact' })
    } else {
      onChange({ address: presetAddress, kind: 'new' })
    }
  }, [contacts, contactsLoading, onChange, ownAccounts, presetAddress, value])

  // Focus follows the state change: the chip's Change button after a pick, the
  // input after a clear. Both targets mount on the render that follows.
  useEffect(() => {
    if (value && focusChipRef.current) {
      focusChipRef.current = false
      changeButtonRef.current?.focus()
    }
    if (!value && focusInputRef.current) {
      focusInputRef.current = false
      inputRef.current?.focus()
    }
  }, [value])

  const shown: Recipient | null =
    value ??
    (!presetDismissed && presetAddress && isAddress(presetAddress)
      ? { address: presetAddress, kind: 'new' }
      : null)

  if (shown) {
    const title = shown.name ?? truncate(shown.address)
    const subtitle = shown.name
      ? `${KIND_LABEL[shown.kind]} · ${truncate(shown.address)}`
      : KIND_LABEL[shown.kind]
    return (
      <div
        data-recipient-chip=""
        className={`flex items-center gap-3 rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] px-3 py-2 ${className}`}
      >
        {shown.kind === 'new' ? (
          <span
            aria-hidden="true"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]"
          >
            <Icon icon={Wallet} className="h-4 w-4" />
          </span>
        ) : (
          <Monogram name={shown.name ?? shown.address} size="xs" decorative />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{title}</p>
          <p className="mt-0.5 truncate text-xs text-[var(--v2-ink-3)]">{subtitle}</p>
        </div>
        <button
          ref={changeButtonRef}
          type="button"
          aria-label="Change recipient"
          onClick={() => {
            focusInputRef.current = true
            setPresetDismissed(true)
            onChange(null)
          }}
          className="-m-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
        >
          <Icon icon={X} className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <Combobox
      label={label}
      placeholder="Name or address"
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      footer="Or paste a wallet address"
      emptyMessage="No saved recipient matches. Paste a wallet address to send to it."
      inputRef={inputRef}
      className={className}
      onPick={(option) => {
        const recipient = recipients.get(option.id)
        if (!recipient) return
        setQuery('')
        focusChipRef.current = true
        onChange(recipient)
      }}
    />
  )
}

export default RecipientField
