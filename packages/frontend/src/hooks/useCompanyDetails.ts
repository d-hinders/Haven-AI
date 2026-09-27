'use client'

/**
 * Owner company details (#3332), behind `HAVEN_OWNER_COMPANY_DETAILS`.
 *
 * ── Gating ──
 * `GET /user/company-details` answers 404 ONLY when the feature flag is off
 * (`requireFeatureEnabled` in `routes/owner-company-details.ts`). With the
 * feature on and nothing saved it answers 200 with `null`. So the status
 * alone decides: 404 hides the section, `null` shows an empty form ready to
 * fill in, a row shows the filled form.
 *
 * `status` is one of:
 * - `'loading'` — the first read has not answered yet.
 * - `'off'` — the feature flag is off; render nothing.
 * - `'empty'` — the flag is on, no details saved yet; render an empty form.
 * - `'ready'` — details are saved; `details` is populated.
 * - `'error'` — the read failed for a reason that is not "no details" (401,
 *   403, 5xx, network); render the retry state, never a blank crash.
 *
 * ── VIES polling ─────────────────────────────────────────────────────────
 * While `details.vies_status === 'pending'`, this hook polls
 * `GET /user/company-details` every `VIES_POLL_INTERVAL_MS` to pick up the
 * background check's outcome. Polling stops on: the status leaving
 * `pending`, the owner navigating away (unmount — the effect's cleanup
 * clears the timer), or `VIES_POLL_MAX_MS` of wall time elapsing (a bounded
 * wait — a check that never resolves must not poll forever; the last-seen
 * `pending` state stays on screen, and "Check again" still works).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiOperations } from '@haven_ai/core'
import { api, ApiRequestError } from '@/lib/api'

export type CompanyDetails = ApiOperations['getCompanyDetails']['responses']['200']['content']['application/json']
export type UpsertCompanyDetailsBody =
  ApiOperations['putCompanyDetails']['requestBody']['content']['application/json']
export type ViesStatus = NonNullable<CompanyDetails['vies_status']>

export type CompanyDetailsStatus = 'loading' | 'off' | 'empty' | 'ready' | 'error'

/**
 * `save`/`remove`/`recheckVies` return a CODE, not a rendered sentence — the
 * component owns copy (`t.settings.companyDetails.*`) so every user-facing
 * string lives in the message catalog the copy lint scans, not in this
 * (unscanned, `src/hooks`) file. `message` is the backend's own 400 body
 * text (`VALIDATION_MESSAGES` in `routes/owner-company-details.ts`) for the
 * one case (`'validation'`) where the backend's own words are the right
 * words to show, verbatim, per the issue's "surface the backend's 400
 * messages in plain words" acceptance point.
 */
export type SaveResult = { code: 'validation'; message: string } | { code: 'rate_limited' } | { code: 'unknown' }
export type ViesCheckResult = { code: 'rate_limited' } | { code: 'unknown' }

export const VIES_POLL_INTERVAL_MS = 4000
export const VIES_POLL_MAX_MS = 60_000

const PATH = '/user/company-details'
const VIES_CHECK_PATH = '/user/company-details/vies-check'

/**
 * A 404 on `GET /user/company-details` means ONLY "the feature is off" —
 * the backend answers 200 with `null` when the feature is on and nothing is
 * saved (#3332), so the gate reads the status, never an error string.
 */
function is404(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError && err.status === 404
}

export function useCompanyDetails() {
  const [status, setStatus] = useState<CompanyDetailsStatus>('loading')
  const [details, setDetails] = useState<CompanyDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<SaveResult | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(false)
  const [checkingVies, setCheckingVies] = useState(false)
  const [viesCheckError, setViesCheckError] = useState<ViesCheckResult | null>(null)

  const generationRef = useRef(0)

  const load = useCallback(async () => {
    const generation = ++generationRef.current
    setStatus((prev) => (prev === 'ready' || prev === 'empty' ? prev : 'loading'))
    setError(null)
    try {
      const row = await api.get<CompanyDetails | null>(PATH)
      if (generationRef.current !== generation) return
      setDetails(row)
      setStatus(row ? 'ready' : 'empty')
    } catch (err) {
      if (generationRef.current !== generation) return
      if (is404(err)) {
        setStatus('off')
        return
      }
      setDetails(null)
      setStatus('error')
      setError(err instanceof Error ? err.message : 'We could not load your company details.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Poll while a VIES check is in flight — bounded, and cleaned up on
  // unmount or the moment the status leaves `pending`.
  useEffect(() => {
    if (details?.vies_status !== 'pending') return
    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const startedAt = Date.now()

    async function tick() {
      if (cancelled) return
      if (Date.now() - startedAt >= VIES_POLL_MAX_MS) return
      try {
        const row = await api.get<CompanyDetails>(PATH)
        if (cancelled) return
        setDetails(row)
        if (row.vies_status === 'pending' && Date.now() - startedAt < VIES_POLL_MAX_MS) {
          timeout = setTimeout(() => void tick(), VIES_POLL_INTERVAL_MS)
        }
      } catch {
        // A flaky poll tick is not evidence the check failed — try again
        // until the bound runs out, silently (the same convention
        // `useAgentConnectionSetupStatus` follows).
        if (!cancelled && Date.now() - startedAt < VIES_POLL_MAX_MS) {
          timeout = setTimeout(() => void tick(), VIES_POLL_INTERVAL_MS)
        }
      }
    }

    timeout = setTimeout(() => void tick(), VIES_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timeout !== null) clearTimeout(timeout)
    }
  }, [details?.vies_status])

  const save = useCallback(async (body: UpsertCompanyDetailsBody) => {
    setSaving(true)
    setSaveError(null)
    try {
      const row = await api.put<CompanyDetails>(PATH, body)
      setDetails(row)
      setStatus('ready')
      return { ok: true as const }
    } catch (err) {
      let result: SaveResult
      if (err instanceof ApiRequestError && err.status === 429) {
        result = { code: 'rate_limited' }
      } else if (err instanceof ApiRequestError && err.status === 400) {
        const bodyError = (err.body as { error?: string } | undefined)?.error
        result = { code: 'validation', message: bodyError ?? err.message }
      } else {
        result = { code: 'unknown' }
      }
      setSaveError(result)
      return { ok: false as const, ...result }
    } finally {
      setSaving(false)
    }
  }, [])

  const remove = useCallback(async () => {
    setDeleting(true)
    setDeleteError(false)
    try {
      await api.delete<{ ok: boolean }>(PATH)
      setDetails(null)
      setStatus('empty')
      return { ok: true as const }
    } catch {
      setDeleteError(true)
      return { ok: false as const }
    } finally {
      setDeleting(false)
    }
  }, [])

  const recheckVies = useCallback(async () => {
    setCheckingVies(true)
    setViesCheckError(null)
    try {
      const row = await api.post<CompanyDetails>(VIES_CHECK_PATH)
      setDetails(row)
      return { ok: true as const }
    } catch (err) {
      const result: ViesCheckResult =
        err instanceof ApiRequestError && err.status === 429 ? { code: 'rate_limited' } : { code: 'unknown' }
      setViesCheckError(result)
      return { ok: false as const, ...result }
    } finally {
      setCheckingVies(false)
    }
  }, [])

  return {
    status,
    details,
    error,
    reload: load,
    save,
    saving,
    saveError,
    remove,
    deleting,
    deleteError,
    recheckVies,
    checkingVies,
    viesCheckError,
  }
}
