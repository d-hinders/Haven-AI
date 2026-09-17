'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, ApiRequestError } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'

/**
 * #1445: was a hand-written copy that had fallen two fields behind the spec —
 * `tool_arguments` (suggested MCP tool arguments for a product variant) and
 * `asset_transfer_methods` were invisible to the UI because the local type
 * never declared them.
 */
export type CatalogEntry = ApiSchema<'CatalogEntry'>

/** `GET /merchants` / `GET /merchants/{slug}` wire shape (#3078, epic #3077). */
export type Merchant = ApiSchema<'Merchant'>

/** POST /catalog/submit response (epic #1717, issue #1715). */
export type CatalogSubmissionAccepted = ApiSchema<'CatalogSubmissionAccepted'>

/** GET /catalog/submit/{id} wire shape. `verify_token` never crosses it. */
export type CatalogSubmissionStatus = ApiSchema<'CatalogSubmissionStatus'>

/**
 * Public self-service listing (issue #1715). The `website` field is a
 * honeypot: bots autofill it and the backend drops those submissions. We
 * always send the empty string and never forward a filled value.
 *
 * `merchantName`/`merchantWebsite` are optional (#3078): the seller's display
 * name and public site, used to name a NEW merchant when the submission is
 * verified payable and no merchant already owns the host — ignored when one
 * does. Distinct from the honeypot `website` field, which is always sent
 * empty.
 */
export function submitCatalog(
  resourceUrl: string,
  merchant?: { name?: string; website?: string },
): Promise<CatalogSubmissionAccepted> {
  return api.post<CatalogSubmissionAccepted>('/catalog/submit', {
    resource_url: resourceUrl,
    website: '',
    ...(merchant?.name ? { merchant_name: merchant.name } : {}),
    ...(merchant?.website ? { merchant_website: merchant.website } : {}),
  })
}

/** Coarse public status of a submission; 404s on an unknown id. */
export function getSubmissionStatus(id: string): Promise<CatalogSubmissionStatus> {
  return api.get<CatalogSubmissionStatus>(`/catalog/submit/${id}`)
}

export function useCatalog() {
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchCatalog = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await api.get<{ entries: CatalogEntry[] }>('/catalog')
      // `?? []`: `api.get` does no response validation, so an absent key stores
      // `undefined` and the next `.map` takes the whole route into the
      // ErrorBoundary (#1075, #2295, #3091 — #3093 sweeps the array stores).
      setEntries(res.entries ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not load the catalog.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCatalog()
  }, [fetchCatalog])

  return { entries, loading, error, refetch: fetchCatalog }
}

/** `GET /merchants` — every live merchant on a listed chain, plus prospects for an owner who may see them. */
export function useMerchants() {
  const [merchants, setMerchants] = useState<Merchant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchMerchants = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await api.get<{ merchants: Merchant[] }>('/merchants')
      setMerchants(res.merchants)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not load the marketplace.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMerchants()
  }, [fetchMerchants])

  return { merchants, loading, error, refetch: fetchMerchants }
}

/**
 * `GET /merchants/{slug}` — one merchant plus its offers. `notFound` is a
 * distinct terminal state from `error`: a 404 (unknown slug, or a prospect
 * hidden from this caller) is not a network/server failure to retry, it is
 * "this merchant page does not exist" — the caller renders it as such.
 */
export function useMerchant(slug: string) {
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [offers, setOffers] = useState<CatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const fetchMerchant = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      setNotFound(false)
      const res = await api.get<{ merchant: Merchant; offers: CatalogEntry[] }>(
        `/merchants/${slug}`,
      )
      setMerchant(res.merchant)
      setOffers(res.offers)
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        setNotFound(true)
      } else {
        setError(err instanceof Error ? err.message : 'We could not load this merchant.')
      }
    } finally {
      setLoading(false)
    }
  }, [slug])

  useEffect(() => {
    fetchMerchant()
  }, [fetchMerchant])

  return { merchant, offers, loading, error, notFound, refetch: fetchMerchant }
}
