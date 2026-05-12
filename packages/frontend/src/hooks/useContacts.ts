'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

export interface Contact {
  id: string
  name: string
  address: string
  created_at: string
  updated_at: string
}

interface UseContactsReturn {
  contacts: Contact[]
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
  addContact: (name: string, address: string) => Promise<Contact>
  updateContact: (id: string, name: string) => Promise<Contact>
  deleteContact: (id: string) => Promise<void>
  resolveAddress: (address: string) => string | null
}

export function useContacts(): UseContactsReturn {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadContacts = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ contacts: Contact[] }>('/contacts')
      setContacts(res.contacts)
    } catch {
      setError('We could not load your contacts. Try again in a moment.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await api.get<{ contacts: Contact[] }>('/contacts')
        if (!cancelled) setContacts(res.contacts)
      } catch {
        if (!cancelled) setError('We could not load your contacts. Try again in a moment.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const addContact = useCallback(async (name: string, address: string): Promise<Contact> => {
    const contact = await api.post<Contact>('/contacts', { name, address })
    setContacts((prev) => [...prev, contact].sort((a, b) => a.name.localeCompare(b.name)))
    setError(null)
    return contact
  }, [])

  const updateContact = useCallback(async (id: string, name: string): Promise<Contact> => {
    const contact = await api.put<Contact>(`/contacts/${id}`, { name })
    setContacts((prev) =>
      prev.map((c) => (c.id === id ? contact : c)).sort((a, b) => a.name.localeCompare(b.name)),
    )
    setError(null)
    return contact
  }, [])

  const deleteContact = useCallback(async (id: string): Promise<void> => {
    await api.delete(`/contacts/${id}`)
    setContacts((prev) => prev.filter((c) => c.id !== id))
    setError(null)
  }, [])

  const resolveAddress = useCallback(
    (address: string): string | null => {
      const contact = contacts.find((c) => c.address.toLowerCase() === address.toLowerCase())
      return contact?.name ?? null
    },
    [contacts],
  )

  return { contacts, loading, error, refetch: loadContacts, addContact, updateContact, deleteContact, resolveAddress }
}
