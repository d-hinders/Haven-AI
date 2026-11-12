'use client'

/**
 * Owner-initiated send from a delegation-rail account (#1083).
 *
 * The rail's "Send": the treasury executes an ERC-20 transfer as a sponsored
 * account op the OWNER signs — prepare/submit through the #1083 by-address
 * routes, calldata pinned server-side to what was signed. The signature
 * scheme is the DEVICE's choice (#1086 via `pickSigningPath`), dispatched
 * through the shared `signPreparedAccountOp`. Works on a counterfactual
 * account (#1106): deploy + transfer ride one sponsored op.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { api, ApiRequestError } from '@/lib/api'
import { useActiveSigner } from '@/lib/signer'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'
import { signPreparedAccountOp, type PreparedAccountOp } from '@/lib/hybridAccountOps'
import type { AccountSigners } from '@/lib/delegationPasskeySigner'
import { pickSigningPath, passkeyLikelyElsewhere } from './useDelegationBudget'

export type SendResult =
  | { ok: true; txHash: string | null }
  | { ok: false; reason: 'cancelled' | 'failed'; message?: string }
  /**
   * #4820: the submit request was rejected and nothing proves the transfer did
   * not go through. `userOpHash` is the operation the bundler received when the
   * route knew it — NOT the hash of a chain transaction, so it is not an
   * explorer link.
   */
  | { ok: false; reason: 'unconfirmed'; message?: string; userOpHash?: string }

export interface SendInput {
  tokenAddress: Address
  to: Address
  amountAtomic: string
}

/** The transfer submit route's two codes (#4820). */
const OUTCOME_UNKNOWN_CODE = 'submission_outcome_unknown'
const KNOWN_FAILURE_CODE = 'onchain_execution_failed'

function readStringField(body: unknown, field: string): string | null {
  if (!body || typeof body !== 'object') return null
  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * #4820: what a rejected SUBMIT request is evidence of.
 *
 * The submit POST is the only call that can move funds, so a rejection here is
 * NOT proof that nothing was sent:
 *
 * - no HTTP answer at all (a dropped connection, a timeout, a platform 502
 *   while the backend restarts) — the request may have reached the route;
 * - the route's own outcome-unknown answer (`submission_outcome_unknown`),
 *   which carries the UserOperation hash;
 * - a 5xx with no code, or with a code this client does not know — a proxy or
 *   platform answer, not the route's.
 *
 * All three are `unconfirmed`: the transfer may have gone through, so the
 * dialog must not offer a second send. A 4xx, or the route's known-failure
 * code (`onchain_execution_failed` — an explicit pre-send rejection, or an
 * operation that landed and reverted), is the route saying nothing moved:
 * `failed`, and retrying is safe.
 */
function classifySubmitFailure(err: unknown): SendResult {
  if (!(err instanceof ApiRequestError)) {
    return { ok: false, reason: 'unconfirmed', message: err instanceof Error ? err.message : undefined }
  }
  const code = readStringField(err.body, 'error_code')
  if (code === OUTCOME_UNKNOWN_CODE) {
    return {
      ok: false,
      reason: 'unconfirmed',
      message: err.message,
      userOpHash: readStringField(err.body, 'user_op_hash') ?? undefined,
    }
  }
  if (err.status >= 400 && err.status < 500) {
    return { ok: false, reason: 'failed', message: err.message }
  }
  if (code === KNOWN_FAILURE_CODE) {
    return { ok: false, reason: 'failed', message: err.message }
  }
  return { ok: false, reason: 'unconfirmed', message: err.message }
}

export function useDelegationSend(accountAddress: string, chainId: number) {
  const [signers, setSigners] = useState<AccountSigners | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const signer = useActiveSigner({
    accountAddress: signers ? (signers.account_address as Address) : undefined,
    chainId,
  })

  const reload = useCallback(async () => {
    // #1079 discipline: a failed fetch is a retryable ERROR state, never a
    // silent null the UI misreads as an account shape.
    setLoadError(false)
    try {
      setSigners(
        await api.get<AccountSigners>(`/accounts/hybrid/${accountAddress}/signers?chain_id=${chainId}`),
      )
    } catch {
      setSigners(null)
      setLoadError(true)
    }
  }, [accountAddress, chainId])

  useEffect(() => {
    void reload()
  }, [reload])

  const signingPath = pickSigningPath(signers, signer?.type === 'eoa' ? signer.address : null)

  const send = useCallback(
    async (input: SendInput): Promise<SendResult> => {
      setBusy(true)
      try {
        const body = {
          token_address: input.tokenAddress,
          to: input.to,
          amount_atomic: input.amountAtomic,
          signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop',
        }
        // Everything up to the signature moves nothing: a refusal here is a
        // plain failure, and retrying is safe.
        let prep: PreparedAccountOp
        let signature: string
        try {
          prep = await api.post<PreparedAccountOp>(
            `/accounts/hybrid/${accountAddress}/transfers/prepare?chain_id=${chainId}`,
            body,
          )
          signature = await signPreparedAccountOp(prep, signers, signer)
        } catch (err) {
          if (isPasskeyCancellation(err)) return { ok: false, reason: 'cancelled' }
          return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : undefined }
        }
        // #4820: the submit is the only call that can move funds, so its
        // rejection is classified rather than folded into `failed`.
        try {
          const done = await api.post<{ tx_hash?: string | null }>(
            `/accounts/hybrid/${accountAddress}/transfers/submit?chain_id=${chainId}`,
            { ...body, signature, user_operation: prep.user_operation },
          )
          return { ok: true, txHash: done.tx_hash ?? null }
        } catch (err) {
          return classifySubmitFailure(err)
        }
      } finally {
        setBusy(false)
      }
    },
    [accountAddress, chainId, signer, signers, signingPath],
  )

  return {
    busy,
    // Signer set fetched — until then `ready` is meaningless, not a blocker.
    loaded: signers !== null,
    loadError,
    reload,
    // Some signer for this account is reachable from THIS device.
    ready: signingPath !== null,
    // #1097: hint condition — the ceremony may hand off to another device.
    // #3825 design review: only when the PASSKEY will sign — with the owner
    // wallet connected the EOA path signs and nothing hands off.
    passkeyElsewhere: signingPath === 'passkey' && passkeyLikelyElsewhere(signers),
    send,
  }
}
