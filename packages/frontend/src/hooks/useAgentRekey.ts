'use client'

/**
 * Agent re-key — the owner-facing half (#1701, epic #1694).
 *
 * Drives the five owner-signed stages of `routes/agent-rekey.ts` (#1698):
 *
 *   preflight → revoke (prepare) → revoke/submit → issue → complete
 *
 * Haven signs none of it. The revoke is an owner signature over a treasury
 * UserOperation; the replacement delegations are owner signatures over EIP-712
 * delegation payloads. This hook is the only client that exists for that
 * route — before it, `grep -rli rekey packages/frontend/` returned nothing.
 *
 * ## Two rules this file exists to hold
 *
 * **1. The revoke is a point of no return, and the state machine says so.**
 * Once `revoke/submit` lands, the agent's old delegations are revoked
 * on-chain and its authority is gone until `complete` issues the
 * replacements. Abandoning there does NOT give it back — `abandonRekey` marks
 * a row, it cannot un-revoke a transaction (#1868). Worse, the abandoned row
 * keeps the agent's one in-flight slot (`idx_agent_rekeys_one_in_flight`) and
 * nothing expires it, so a retry finds nothing left to revoke and issues
 * nothing. Recovery is a manual owner re-grant.
 *
 * So `pointOfNoReturnCrossed` is derived from the stage rather than tracked
 * as UI state, and the modal reads it to decide whether closing is safe. A
 * flow over a stage machine with no way out of the middle must not offer a
 * Cancel button that implies there is one.
 *
 * **2. Never render the backend's prose.** The route returns readable
 * `carry_note`, `ordering_note` and `skipped[].reason` strings. One of them
 * is currently FALSE: the skipped-carry reason says authority "resumes at the
 * original boundary", but `planCarry` anchors the replacement to the period
 * `/issue` runs in, not the period the meter was read in, so a boundary
 * crossing lands it a period later (#1849). This hook therefore returns
 * STRUCTURED fields only and the UI writes its own copy. A prose string from
 * an API is an API field like any other — it goes stale and nothing
 * type-checks it.
 */

import { useCallback, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { api, ApiRequestError } from '@/lib/api'
import { useActiveSigner } from '@/lib/signer'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'
import { pickSigningPath } from '@/hooks/useDelegationBudget'
import type { AccountSigners } from '@/lib/delegationPasskeySigner'

/** Mirrors `agent_rekeys.stage`. `idle` is client-only: nothing opened yet. */
export type RekeyStage = 'idle' | 'preflight' | 'revoked' | 'metered' | 'issued' | 'completed'

/**
 * Stages at which the on-chain revoke has already landed. Past this line the
 * agent has no spend authority and abandoning cannot restore it (#1868).
 */
const PAST_REVOKE: readonly RekeyStage[] = ['revoked', 'metered', 'issued']

export function isPastRevoke(stage: RekeyStage): boolean {
  return PAST_REVOKE.includes(stage)
}

/**
 * What can actually be done with a re-key found at `stage`, derived from what
 * `modules/agents/rekey-stages.ts` PERMITS — not from what would be
 * convenient.
 *
 * - `full` — nothing has happened on-chain; run the whole sequence.
 * - `resume` — the revoke landed and the meter is frozen. `issue` requires
 *   exactly `metered`, so this is the one interrupted state a client can
 *   carry to completion.
 * - `stranded` — reachable, and NOT finishable from here:
 *   - `revoked`: the only code that advances `revoked → metered` lives inside
 *     the revoke/submit handler, which itself requires stage `preflight`. So
 *     nothing can move it forward.
 *   - `issued`: `complete` needs the signing payloads that only the `/issue`
 *     response carried, and `issue` refuses at any stage but `metered`. A
 *     client that lost that response — a closed tab — cannot rebuild it,
 *     because no route exposes the pending delegations.
 *   Both are #1868's wedge. The UI must say so rather than offer a button
 *   that will 409, which is what makes the state legible instead of baffling.
 */
export type ResumeMode = 'full' | 'resume' | 'stranded' | 'done'

export function resumeModeFor(stage: RekeyStage): ResumeMode {
  switch (stage) {
    case 'idle':
    case 'preflight':
      return 'full'
    case 'metered':
      return 'resume'
    case 'revoked':
    case 'issued':
      return 'stranded'
    case 'completed':
      return 'done'
  }
}

export type ResidualDisposition = 'swept' | 'acknowledged_unrecoverable'

interface TypedDataPayload {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

export interface PreflightResult {
  rekey_id: string
  stage: RekeyStage
  old_delegate_address: string
  new_delegate_address: string
  residual: {
    atomic: string
    token_address: string | null
    disposition: string
    recoverable_after_rekey: boolean
  }
  delegations_to_revoke: string[]
}

interface RevokePrepare {
  signing_payload: TypedDataPayload
  user_op_hash: string
  user_operation: unknown
  delegation_hashes: string[]
  /** The no-authority shortcut: nothing on-chain to revoke (never granted). */
  revoked?: boolean
  stage?: RekeyStage
}

export interface IssuedDelegation {
  delegation_hash: string
  /** `carry` = capped at the frozen remainder; `steady` = the next full period. */
  carry_role: 'carry' | 'steady' | 'reanchor'
  token_address: string
  budget_atomic: string
  period_seconds: number
  start_date: number
  expires_at: number
  signing_payload: TypedDataPayload
}

export interface IssueResult {
  stage: RekeyStage
  delegate_account_address: string
  delegations: IssuedDelegation[]
  /**
   * Delegations that produced no replacement. The backend attaches a `reason`
   * string; it is deliberately NOT carried through — see the file header.
   */
  skipped: Array<{ delegation_hash: string }>
}

export interface CompleteResult {
  api_key: string
  api_key_prefix: string
  new_delegate_address: string
  invalidated_intents: number
  superseded_delegations: number
  residual_atomic: string
}

/**
 * Refusals the UI has a specific answer for. Everything else collapses to
 * `unknown` with the server's message — which is correct for a genuine
 * surprise and wrong for anything a user can act on, hence the named cases.
 */
export type RekeyFailure =
  | { kind: 'cancelled' }
  | { kind: 'residual'; atomic: string; tokenAddress: string | null }
  | { kind: 'in_flight'; rekeyId: string; stage: RekeyStage }
  | { kind: 'delegate_in_use' }
  | { kind: 'residual_read_failed' }
  | { kind: 'carry_refused'; delegationHash: string }
  | { kind: 'legacy_rail'; message: string }
  | { kind: 'out_of_order'; stage: RekeyStage }
  | { kind: 'missing_signature' }
  | { kind: 'completion_failed'; detail: string | null }
  | { kind: 'unknown'; message: string }

function bodyField(err: ApiRequestError, key: string): string | null {
  const body = err.body
  if (body && typeof body === 'object' && key in body) {
    const value = (body as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : null
  }
  return null
}

function classify(err: unknown): RekeyFailure {
  if (isPasskeyCancellation(err)) return { kind: 'cancelled' }
  if (err instanceof Error && /rejected/i.test(err.message)) return { kind: 'cancelled' }
  if (!(err instanceof ApiRequestError)) {
    return { kind: 'unknown', message: err instanceof Error ? err.message : String(err) }
  }
  const code = bodyField(err, 'error')
  switch (code) {
    case 'residual_funds_on_old_delegate':
      return {
        kind: 'residual',
        atomic: bodyField(err, 'residual_atomic') ?? '0',
        tokenAddress: bodyField(err, 'residual_token_address'),
      }
    case 'rekey_already_in_flight':
      return {
        kind: 'in_flight',
        rekeyId: bodyField(err, 'rekey_id') ?? '',
        stage: (bodyField(err, 'stage') as RekeyStage) ?? 'preflight',
      }
    case 'delegate_address_in_use':
      return { kind: 'delegate_in_use' }
    case 'residual_read_failed':
      return { kind: 'residual_read_failed' }
    case 'carry_refused':
      return { kind: 'carry_refused', delegationHash: bodyField(err, 'delegation_hash') ?? '' }
    // The three below all answer with a bare machine code as `error`, so
    // without these cases `failureCopy` would render the literal string
    // "missing_signature" to an owner mid-way through a money-path flow.
    case 'rekey_out_of_order':
      return { kind: 'out_of_order', stage: (bodyField(err, 'stage') as RekeyStage) ?? 'preflight' }
    case 'missing_signature':
      return { kind: 'missing_signature' }
    case 'rekey_completion_failed':
      return { kind: 'completion_failed', detail: bodyField(err, 'details') }
    default:
      break
  }
  // The legacy-rail refusal comes back as prose from `railRefusal`, not a code.
  if (err.status === 409 && /legacy|allowance module|re-onboard/i.test(err.message)) {
    return { kind: 'legacy_rail', message: err.message }
  }
  return { kind: 'unknown', message: err.message }
}

export type RekeyResult<T> = { ok: true; value: T } | { ok: false; failure: RekeyFailure }

export function useAgentRekey(agentId: string, chainId: number) {
  const [stage, setStage] = useState<RekeyStage>('idle')
  const [rekeyId, setRekeyId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signers, setSigners] = useState<AccountSigners | null>(null)
  const [issued, setIssued] = useState<IssueResult | null>(null)

  const signer = useActiveSigner({
    safeAddress: signers ? (signers.account_address as Address) : undefined,
    chainId,
  })

  const loadSigners = useCallback(async () => {
    try {
      setSigners(await api.get<AccountSigners>(`/agents/${agentId}/account-signers`))
    } catch {
      setSigners(null)
    }
  }, [agentId])

  const signingPath = pickSigningPath(signers, signer?.type === 'eoa')

  /**
   * Whether this device can sign the re-key at all.
   *
   * NOT the same question as `useDelegationBudget`'s `ready`, and the
   * difference is #1870: the re-key revoke prepares its UserOperation without
   * passing `signWith`, and returns no `signature_scheme`. So the op is
   * estimated for an EOA-sized signature, and there is no field telling a
   * client otherwise. Signing it with a passkey means a WebAuthn signature of
   * several hundred bytes validated against a `verificationGasLimit`
   * estimated for 65 — on the operation that revokes spend authority.
   *
   * Guessing would put the failure AFTER the revoke, which is exactly
   * #1868's permanent wedge. So this refuses up front instead.
   */
  const signingBlockedReason = useMemo<'no_signer' | 'passkey_unsupported' | null>(() => {
    if (signingPath === null) return 'no_signer'
    if (signingPath !== 'eoa') return 'passkey_unsupported'
    return null
  }, [signingPath])

  async function signTypedData(payload: TypedDataPayload): Promise<`0x${string}`> {
    if (!signer || signer.type !== 'eoa') {
      throw new Error('Connect your account owner wallet to replace this signing key.')
    }
    const types = { ...payload.types }
    delete (types as Record<string, unknown>).EIP712Domain
    return signer.walletClient.signTypedData({
      account: signer.address,
      domain: payload.domain,
      types,
      primaryType: payload.primaryType,
      message: payload.message,
    } as never)
  }

  /** Step 0 — nothing is revoked, nothing is signed, and this is retryable. */
  const preflight = useCallback(
    async (
      newDelegateAddress: string,
      residualDisposition?: ResidualDisposition,
    ): Promise<RekeyResult<PreflightResult>> => {
      setBusy(true)
      try {
        const res = await api.post<PreflightResult>(`/agents/${agentId}/rekey`, {
          new_delegate_address: newDelegateAddress,
          ...(residualDisposition ? { residual_disposition: residualDisposition } : {}),
        })
        setRekeyId(res.rekey_id)
        setStage(res.stage)
        return { ok: true, value: res }
      } catch (err) {
        const failure = classify(err)
        // Adopt an in-flight re-key's stage so the UI can resume at the right
        // step rather than restarting a flow that is already past the revoke.
        if (failure.kind === 'in_flight') {
          setRekeyId(failure.rekeyId)
          setStage(failure.stage)
        }
        return { ok: false, failure }
      } finally {
        setBusy(false)
      }
    },
    [agentId],
  )

  /**
   * THE point of no return. Prepares, signs and submits the revoke; the
   * backend reads the frozen meter in the same handler.
   */
  const revoke = useCallback(async (): Promise<RekeyResult<null>> => {
    if (!rekeyId) return { ok: false, failure: { kind: 'unknown', message: 'No re-key in progress.' } }
    setBusy(true)
    try {
      const prep = await api.post<RevokePrepare>(`/agents/${agentId}/rekey/${rekeyId}/revoke`)
      // An agent that never held a budget has nothing on-chain to revoke; the
      // backend walks it straight to `metered` and there is no signature.
      if (prep.revoked === true) {
        setStage(prep.stage ?? 'metered')
        return { ok: true, value: null }
      }
      const signature = await signTypedData(prep.signing_payload)
      const res = await api.post<{ stage: RekeyStage }>(
        `/agents/${agentId}/rekey/${rekeyId}/revoke/submit`,
        {
          signature,
          user_operation: prep.user_operation,
          delegation_hashes: prep.delegation_hashes,
        },
      )
      setStage(res.stage)
      return { ok: true, value: null }
    } catch (err) {
      return { ok: false, failure: classify(err) }
    } finally {
      setBusy(false)
    }
  }, [agentId, rekeyId, signer])

  /** Builds the replacement delegations. Owner signs them in `complete`. */
  const issue = useCallback(async (): Promise<RekeyResult<IssueResult>> => {
    if (!rekeyId) return { ok: false, failure: { kind: 'unknown', message: 'No re-key in progress.' } }
    setBusy(true)
    try {
      const res = await api.post<IssueResult>(`/agents/${agentId}/rekey/${rekeyId}/issue`)
      setIssued(res)
      setStage(res.stage)
      return { ok: true, value: res }
    } catch (err) {
      return { ok: false, failure: classify(err) }
    } finally {
      setBusy(false)
    }
  }, [agentId, rekeyId])

  /**
   * Signs every replacement delegation and completes. Partial signing is not
   * a state the backend accepts — it refuses rather than rotate credentials
   * against authority the owner has not signed for.
   */
  const complete = useCallback(
    async (delegations: IssuedDelegation[]): Promise<RekeyResult<CompleteResult>> => {
      if (!rekeyId) return { ok: false, failure: { kind: 'unknown', message: 'No re-key in progress.' } }
      setBusy(true)
      try {
        const signatures: Array<{ delegation_hash: string; signature: string }> = []
        for (const d of delegations) {
          signatures.push({
            delegation_hash: d.delegation_hash,
            signature: await signTypedData(d.signing_payload),
          })
        }
        const res = await api.post<{
          api_key: string
          api_key_prefix: string
          new_delegate_address: string
          invalidated_intents: number
          superseded_delegations: number
          residual_on_old_delegate: { atomic: string }
        }>(`/agents/${agentId}/rekey/${rekeyId}/complete`, { signatures })
        setStage('completed')
        return {
          ok: true,
          value: {
            api_key: res.api_key,
            api_key_prefix: res.api_key_prefix,
            new_delegate_address: res.new_delegate_address,
            invalidated_intents: res.invalidated_intents,
            superseded_delegations: res.superseded_delegations,
            residual_atomic: res.residual_on_old_delegate?.atomic ?? '0',
          },
        }
      } catch (err) {
        return { ok: false, failure: classify(err) }
      } finally {
        setBusy(false)
      }
    },
    [agentId, rekeyId, signer],
  )

  /**
   * Only ever offered BEFORE the revoke. Past it, abandoning records a row
   * and leaves the agent with no authority and no way to re-key (#1868), so
   * the modal does not present this as an exit there.
   */
  const abandon = useCallback(async (): Promise<void> => {
    if (!rekeyId) return
    try {
      await api.post(`/agents/${agentId}/rekey/${rekeyId}/abandon`, { reason: 'stopped in the dashboard' })
    } catch {
      // Best-effort: the user is leaving either way, and a failed abandon
      // leaves the row in-flight, which the resume path already handles.
    }
    setStage('idle')
    setRekeyId(null)
  }, [agentId, rekeyId])

  return {
    stage,
    rekeyId,
    busy,
    issued,
    loadSigners,
    signingBlockedReason,
    pointOfNoReturnCrossed: isPastRevoke(stage),
    resumeMode: resumeModeFor(stage),
    preflight,
    revoke,
    issue,
    complete,
    abandon,
  }
}
