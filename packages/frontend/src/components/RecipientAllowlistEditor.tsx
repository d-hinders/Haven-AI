'use client'

import { useState, useMemo } from 'react'
import { useContacts, type Contact } from '@/hooks/useContacts'

// ── Types ──────────────────────────────────────────────────────────

export interface RecipientEntry {
  address: string
  label?: string
}

interface Props {
  enabled: boolean
  onToggle: (enabled: boolean) => void
  recipients: RecipientEntry[]
  onChange: (recipients: RecipientEntry[]) => void
}

// ── Helpers ─────────────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

// ── Component ───────────────────────────────────────────────────────

export default function RecipientAllowlistEditor({
  enabled,
  onToggle,
  recipients,
  onChange,
}: Props) {
  const { contacts } = useContacts()
  const [inputAddress, setInputAddress] = useState('')
  const [inputLabel, setInputLabel] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)

  // Already-added addresses (lowercase set for dedup)
  const addedAddresses = useMemo(
    () => new Set(recipients.map((r) => r.address.toLowerCase())),
    [recipients],
  )

  // Filter contacts to show suggestions
  const filteredContacts = useMemo(() => {
    if (!inputAddress && !showSuggestions) return []
    return contacts.filter((c) => {
      if (addedAddresses.has(c.address.toLowerCase())) return false
      if (!inputAddress) return true
      const q = inputAddress.toLowerCase()
      return (
        c.name.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q)
      )
    })
  }, [contacts, inputAddress, addedAddresses, showSuggestions])

  function handleAddRecipient() {
    if (!isValidAddress(inputAddress)) return
    if (addedAddresses.has(inputAddress.toLowerCase())) return
    onChange([...recipients, { address: inputAddress.toLowerCase(), label: inputLabel.trim() || undefined }])
    setInputAddress('')
    setInputLabel('')
    setShowSuggestions(false)
  }

  function handleAddContact(contact: Contact) {
    if (addedAddresses.has(contact.address.toLowerCase())) return
    onChange([...recipients, { address: contact.address.toLowerCase(), label: contact.name }])
    setInputAddress('')
    setInputLabel('')
    setShowSuggestions(false)
  }

  function handleRemove(address: string) {
    onChange(recipients.filter((r) => r.address.toLowerCase() !== address.toLowerCase()))
  }

  return (
    <div className="space-y-3">
      {/* Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] text-zinc-500 uppercase tracking-wide">
            Recipient allowlist
          </p>
          <p className="text-[10px] text-zinc-700 mt-0.5">
            {enabled
              ? 'Only listed addresses can receive payments'
              : 'Agent can send to any address'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          className={`relative w-9 h-5 rounded-full transition-colors ${
            enabled ? 'bg-indigo-500' : 'bg-white/[0.08]'
          }`}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-4.5 left-0' : 'translate-x-0.5 left-0'
            }`}
          />
        </button>
      </div>

      {/* Recipient list + input (only when enabled) */}
      {enabled && (
        <div className="space-y-3 p-3 bg-white/[0.02] rounded-xl border border-white/[0.08]">
          {/* Added recipients */}
          {recipients.length > 0 && (
            <div className="space-y-1.5">
              {recipients.map((r) => (
                <div
                  key={r.address}
                  className="flex items-center justify-between px-3 py-2 bg-white/[0.03] rounded-lg border border-white/[0.06] group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-5 h-5 rounded-full bg-indigo-500/10 text-indigo-400 flex items-center justify-center flex-shrink-0">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      {r.label && (
                        <p className="text-xs text-zinc-300 truncate">{r.label}</p>
                      )}
                      <p className="text-[10px] font-mono text-zinc-600 truncate">
                        {truncate(r.address)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemove(r.address)}
                    className="text-zinc-800 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 p-1"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add recipient input */}
          <div className="space-y-2">
            <div className="relative">
              <input
                value={inputAddress}
                onChange={(e) => {
                  setInputAddress(e.target.value)
                  setShowSuggestions(true)
                }}
                onFocus={() => setShowSuggestions(true)}
                placeholder="0x... or search contacts"
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50"
              />

              {/* Contact suggestions dropdown */}
              {showSuggestions && filteredContacts.length > 0 && (
                <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-[#141414] border border-white/[0.08] rounded-lg shadow-xl max-h-36 overflow-y-auto">
                  {filteredContacts.slice(0, 5).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => handleAddContact(c)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04] transition-colors"
                    >
                      <div className="w-5 h-5 rounded-full bg-white/[0.06] flex items-center justify-center flex-shrink-0">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs text-zinc-300 truncate">{c.name}</p>
                        <p className="text-[10px] font-mono text-zinc-600 truncate">
                          {truncate(c.address)}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Show label input when typing a valid address */}
            {isValidAddress(inputAddress) && !addedAddresses.has(inputAddress.toLowerCase()) && (
              <div className="flex gap-2">
                <input
                  value={inputLabel}
                  onChange={(e) => setInputLabel(e.target.value)}
                  placeholder="Label (optional)"
                  className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50"
                />
                <button
                  onClick={handleAddRecipient}
                  className="px-3 py-2 text-xs font-medium bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 rounded-lg transition-colors"
                >
                  Add
                </button>
              </div>
            )}
          </div>

          {/* Empty state */}
          {recipients.length === 0 && (
            <p className="text-[10px] text-zinc-700 text-center py-2">
              Add addresses this agent is allowed to send to
            </p>
          )}
        </div>
      )}
    </div>
  )
}
