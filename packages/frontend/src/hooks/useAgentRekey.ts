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
 * ## Which signer, and who decides (#1890)
 *
 * Both owner-signed steps run on either scheme. The DEVICE picks — an account
 * with an EOA owner AND enrolled passkeys signs with whichever is reachable
 * here — and `pickSigningPath` is the same decision the budget hook makes.
 * The revoke tells the server that choice up front (`signature_scheme`) so the
 * UserOperation is estimated for the signature it will really carry, then
 * branches on the scheme the SERVER resolved.
 *
 * Both halves matter, and the second is the quiet one: `complete` runs past
 * the revoke, so a passkey path that stopped at the revoke would strand the
 * owner on the far side of the irreversible step. There is no scheme this hook
 * will start that it cannot finish.
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
 * `carry_note`, `ordering_note` and `skipped[].reason` strings. The old
 * original-boundary sentence was false before #1849 fixed `planCarry` to use
 * the metering clock. This hook still returns STRUCTURED fields only and the
 * UI writes its own copy: API prose can drift across releases even when its
 * underlying behavior is later corrected, and nothing type-checks it.
 */

import { useCallback, useMemo, useState } from 'react'
import type { Address } from 'viem'
import type { ApiSchema } from '@haven_ai/core'
import { api, ApiRequestError } from '@/lib/api'
import { useActiveSigner } from '@/lib/signer'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'
import { pickSigningPath } from '@/hooks/useDelegationBudget'
import type { AccountSigners, DelegationMessage } from '@/lib/delegationPasskeySigner'

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

/**
 * The re-key wire shapes come from the SPEC, not from a copy kept here
 * (#1447/#1442). The routes are documented in `openapi/spec.ts`, so
 * restating them in the hook would leave two definitions of one contract
 * with nothing keeping them equal — on a flow that revokes and re-issues
 * spend authority. #1701 promoted them from inline path bodies to named
 * `components/schemas` so they could be imported here.
 */
export type PreflightResult = ApiSchema<'AgentRekeyPreflight'>

/**
 * The revoke prepare, imported rather than restated (#1890).
 *
 * This was a hand-rolled interface until PR #1891 added the named schema, and
 * the copy was not merely redundant — it declared `signing_payload` as always
 * present. On the WebAuthn branch the server deliberately emits only
 * `user_op_hash`, so a client cannot sign the wrong artefact for the scheme it
 * was handed. A local type asserting otherwise would hand this file
 * compile-time confidence about the exact field the passkey path does not
 * have, on the step that revokes spend authority.
 *
 * It is a THREE-branch union: the two signing branches discriminated by
 * `signature_scheme`, plus the no-authority short-circuit carrying `revoked`.
 * Narrowing on the discriminant is what makes `signing_payload` /
 * `user_op_hash` reachable at all.
 */
export type RevokePrepare = ApiSchema<'AgentRekeyRevokePrepare'>

/** What this device will sign with, sent so the server can size the UserOp. */
export type RekeySignatureScheme = 'eip712_userop' | 'webauthn_userop'

export type IssuedDelegation = ApiSchema<'AgentRekeyIssuedDelegation'>
export type IssueResult = ApiSchema<'AgentRekeyIssueResponse'>
export type CompleteApiResult = ApiSchema<'AgentRekeyCompleteResponse'>

export type CompleteResult = ApiSchema<'AgentRekeyCompleteResponse'>

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
   * ONE reason remains, and it is the real one: no signer of any kind is
   * reachable here. The second reason — `passkey_unsupported` — was correct
   * only while the backend was signing-scheme-blind (#1870): it prepared the
   * revoke UserOperation without `signWith`, so a WebAuthn signature of
   * several hundred bytes would have been validated against a
   * `verificationGasLimit` estimated for 65, and the failure would have landed
   * AFTER the revoke — #1868's permanent wedge. Refusing up front was the only
   * safe answer to a scheme the server could not be told about.
   *
   * PR #1891 removed that condition. The prepare now takes a
   * `signature_scheme`, sizes the op for the signer that will actually sign
   * it, and reports the resolved scheme back to branch on. A scheme this
   * account cannot produce is a 409 raised in the prepare handler — BEFORE
   * anything is revoked and with nothing written — so the retry is free.
   * Refusing the passkey path here would now block a population the backend
   * serves correctly, which is the whole of #1890.
   */
  const signingBlockedReason = useMemo<'no_signer' | null>(
    () => (signingPath === null ? 'no_signer' : null),
    [signingPath],
  )

  /** The scheme THIS device will produce — a device decision, never the account's shape. */
  const signatureScheme: RekeySignatureScheme =
    signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop'

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

  /**
   * Sign one replacement DELEGATION — the `/issue` payloads, signed at
   * `complete`.
   *
   * This branch is not optional decoration on #1890, it is load-bearing for
   * the #1868 boundary. `complete` runs AFTER the revoke has landed on-chain.
   * Removing the passkey gate while leaving `signTypedData` as the only path
   * would let a passkey owner cross the point of no return and then hit
   * "connect your owner wallet" — a failure introduced by this change, sitting
   * on the far side of the irreversible step, with recovery a manual owner
   * re-grant. Every failure this change can introduce lands before the revoke;
   * that is what this function buys.
   *
   * Mirrors `useDelegationBudget`'s `grant`: the typed-data message IS the
   * delegation, and the kit signs it in one ceremony.
   */
  async function signDelegationPayload(payload: TypedDataPayload): Promise<string> {
    if (signingPath === 'passkey' && signers) {
      const { signDelegationWithPasskey } = await import('@/lib/delegationPasskeySigner')
      return signDelegationWithPasskey(signers, payload.message as unknown as DelegationMessage)
    }
    return signTypedData(payload)
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
      // Tell the backend which signer this device will use (#1870/#1891). The
      // prepared op's gas estimation is shaped by the signature kind and the
      // server cannot know what is reachable here; a scheme this account
      // cannot produce is refused in the prepare handler, before the revoke.
      const prep = await api.post<RevokePrepare>(`/agents/${agentId}/rekey/${rekeyId}/revoke`, {
        signature_scheme: signatureScheme,
      })
      // An agent that never held a budget has nothing on-chain to revoke; the
      // backend walks it straight to `metered` and there is no signature. This
      // is the union's third branch — no `signature_scheme`, so it is
      // discriminated by the server's own marker rather than by absence.
      if ('revoked' in prep) {
        setStage((prep.stage as RekeyStage) ?? 'metered')
        return { ok: true, value: null }
      }
      // Branch on what the SERVER resolved, not on local state. The two are
      // normally equal, but only one of them is the scheme the UserOperation
      // was actually estimated for.
      let signature: string
      if (prep.signature_scheme === 'webauthn_userop') {
        if (!signers) {
          return { ok: false, failure: { kind: 'unknown', message: 'Account signers are still loading.' } }
        }
        // ONE passkey ceremony over the prepared UserOperation — the account
        // signs its own op, so the signature covers exactly the `user_op_hash`
        // the prepare returned. Same mechanism as the budget revoke sibling.
        const { signUserOpWithPasskey } = await import('@/lib/delegationPasskeySigner')
        signature = await signUserOpWithPasskey(signers, prep.user_operation)
      } else {
        signature = await signTypedData(prep.signing_payload as unknown as TypedDataPayload)
      }
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
  }, [agentId, rekeyId, signer, signers, signatureScheme])

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
            // The spec types the payload as an open object; it is relayed to
            // the signer verbatim, exactly as the account will validate it.
            signature: await signDelegationPayload(
              d.signing_payload as unknown as TypedDataPayload,
            ),
          })
        }
        const res = await api.post<CompleteResult>(
          `/agents/${agentId}/rekey/${rekeyId}/complete`,
          { signatures },
        )
        setStage('completed')
        return { ok: true, value: res }
      } catch (err) {
        return { ok: false, failure: classify(err) }
      } finally {
        setBusy(false)
      }
    },
    [agentId, rekeyId, signer, signers, signingPath],
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
