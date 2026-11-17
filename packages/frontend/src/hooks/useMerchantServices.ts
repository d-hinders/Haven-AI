'use client'

/**
 * The merchant-services setting read, and the two writes (#4904, epic #4885).
 *
 * ## One read, for the whole shell
 *
 * The dashboard reads the setting ONCE and makes it available to the shell, so
 * the Sales menu entry (#4900), Analytics (#4901) and the key screens (#4905)
 * all read the same answer. That is why this hook is mounted by
 * `MerchantServicesProvider` in `AuthenticatedShell` rather than by the
 * Settings card: a second call anywhere would be a second read of a setting
 * that decides whether a destination exists, and two reads can disagree for a
 * frame — the Sales entry appearing while the card says off.
 *
 * ## The three states
 *
 * - `loading` — the first read has not answered. The Sales entry is ABSENT
 *   while loading (design-system.md § Authenticated shell: an unknown answer
 *   hides the entry rather than offering a page that may not exist).
 * - `ready` — `state` is the wire answer. `enabled` is the setting;
 *   `merchantAccount` is the account, which survives turning Sales off.
 * - `error` — the read failed. Also hides the entry, and the Settings card
 *   shows a retry state rather than a blank.
 *
 * ## The writes
 *
 * `turnOn` and `turnOff` return a discriminated result instead of throwing:
 * the dialog owns the words, and a refusal is a normal outcome of the flow,
 * not an exception. Both update `state` from the response, so the shell's copy
 * moves with the card's — the Sales entry appears the moment Sales is on.
 *
 * A repeat is not an error. `POST /merchant-services` answers 200 with
 * `created: false` for a double click, a retry or a second tab (the route
 * derives its idempotency key and locks the setting row), so `turnOn` resolves
 * `ok: true` and the dialog shows the result state.
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import {
  classifyTurnOnError,
  type MerchantAccount,
  type MerchantServicesState,
  type TurnOnBody,
  type TurnOnRefusal,
} from '@/lib/merchant-services'

export type MerchantServicesStatus = 'loading' | 'ready' | 'error'

export type TurnOnResult =
  | { ok: true; state: MerchantServicesState }
  | { ok: false; refusal: TurnOnRefusal }

export type TurnOffResult =
  | { ok: true; state: MerchantServicesState }
  | { ok: false; message: string | null }

const PATH = '/merchant-services'

function messageOf(err: unknown): string | null {
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : null
}

export function useMerchantServices() {
  const [status, setStatus] = useState<MerchantServicesStatus>('loading')
  const [state, setState] = useState<MerchantServicesState | null>(null)

  const read = useCallback(async () => {
    setStatus('loading')
    try {
      const next = await api.get<MerchantServicesState>(PATH)
      setState(next)
      setStatus('ready')
    } catch {
      // A failed read is not "off": the card shows a retry state and the shell
      // hides the Sales entry, which is the same answer an unknown setting
      // gets. Never a blank crash, and never a silent "off".
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  const turnOn = useCallback(async (body: TurnOnBody): Promise<TurnOnResult> => {
    try {
      const next = await api.post<MerchantServicesState>(PATH, body)
      setState(next)
      setStatus('ready')
      return { ok: true, state: next }
    } catch (err) {
      return { ok: false, refusal: classifyTurnOnError(err) }
    }
  }, [])

  const turnOff = useCallback(async (): Promise<TurnOffResult> => {
    try {
      const next = await api.delete<MerchantServicesState>(PATH)
      setState(next)
      setStatus('ready')
      return { ok: true, state: next }
    } catch (err) {
      return { ok: false, message: messageOf(err) }
    }
  }, [])

  const merchantAccount: MerchantAccount | null = state?.merchant_account ?? null

  return {
    status,
    state,
    enabled: state?.enabled ?? false,
    merchantAccount,
    refresh: read,
    turnOn,
    turnOff,
  }
}

export type MerchantServices = ReturnType<typeof useMerchantServices>
