'use client'

/**
 * Delegation-rail budget lifecycle for the dashboard (#833, epic #821).
 *
 * The owner-facing counterpart of the delegation lifecycle API (#828): grant a
 * budget with ONE signature, list budgets with status, revoke with ONE
 * signature. An EOA owner signs the EIP-712 typed data the backend returns
 * VERBATIM — never a reconstructed payload, never a bare hash (the #829/#832
 * lesson; the account validates exactly that typed data). A PASSKEY-owned
 * account signs through the kit's WebAuthn path instead (#887): delegations
 * via account.signDelegation, treasury ops via account.signUserOperation —
 * the exact encoding the #884 spike proved on-chain. Haven signs nothing.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import { useActiveSigner, hasPasskeyCredentialOnDevice, credentialIdFromKeyId } from '@/lib/signer'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'
import type { AccountSigners, DelegationMessage } from '@/lib/delegationPasskeySigner'

/**
 * Which signer to use for THIS device, given the account's signer set (the
 * multi-signer fix): a Hybrid account accepts ANY of its enrolled signers
 * on-chain, so "the account has an EOA owner" must never disable the passkey
 * path — that stranded every passkey user who enrolled a wallet as backup.
 * Preference: a passkey enrolled on this device → the connected wallet WHEN
 * it is the set's named owner → any passkey (the authenticator can find
 * credentials our device markers missed). Null only when the account has no
 * reachable signer from here.
 *
 * #2068: the EOA rung takes the connected ADDRESS, not a boolean — "a wallet
 * is connected" never satisfied "the owner is connected". An unrelated
 * connected wallet used to be picked here for a mixed account, and its
 * signature then failed at verification; a signer offered but failing at
 * signature time is worse than absent, so a non-owner wallet now falls
 * through to the passkey rung (or to null for an owner-only set).
 */
export function pickSigningPath(
  signers: AccountSigners | null,
  connectedEoaAddress: string | null | undefined,
): 'passkey' | 'eoa' | null {
  if (!signers) return null
  const hasPasskeys = signers.passkeys.length > 0
  const onDevice =
    hasPasskeys &&
    signers.passkeys.some((p) => hasPasskeyCredentialOnDevice(credentialIdFromKeyId(p.key_id)))
  if (onDevice) return 'passkey'
  if (
    signers.owner_address &&
    connectedEoaAddress &&
    signers.owner_address.toLowerCase() === connectedEoaAddress.toLowerCase()
  ) {
    return 'eoa'
  }
  if (hasPasskeys) return 'passkey'
  return null
}

/**
 * True when the account has passkeys but none is marked on THIS device
 * (#1097): signing still works — the optimistic fallback hands the ceremony
 * to the browser, which offers its cross-device (QR) flow — but the user
 * deserves a heads-up that the sheet may point at another device. This is a
 * HINT condition, never a gate: removing the fallback would strand every
 * legitimate cross-device signer.
 */
export function passkeyLikelyElsewhere(signers: AccountSigners | null): boolean {
  if (!signers || signers.passkeys.length === 0) return false
  return !signers.passkeys.some((p) => hasPasskeyCredentialOnDevice(credentialIdFromKeyId(p.key_id)))
}

export interface DelegationBudget {
  id: string
  token_address: string
  recipient_address: string | null
  delegation_hash: string
  version: number
  status: 'pending' | 'active' | 'replaced' | 'revoked'
  budget_atomic: string
  period_seconds: number
  expires_at: number
}

interface BuildResponse {
  delegation_hash: string
  version: number
  signing_payload: TypedDataPayload
}

interface RevokePrepare {
  signature_scheme?: 'eip712_userop' | 'webauthn_userop'
  signing_payload?: TypedDataPayload
  user_op_hash?: string
  user_operation: unknown
}

interface RevokeAllPrepare extends RevokePrepare {
  delegation_hashes: string[]
}

interface TypedDataPayload {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

export interface GrantInput {
  tokenAddress: Address
  recipientAddress?: Address | null
  budgetAtomic: string
  periodSeconds: number
}

/**
 * `too_many` (#1437) is distinct from `failed` on purpose: the backend refuses
 * an oversized batch by NAMING per-budget revocation as the remedy, and a
 * caller that flattens it into the generic failure strands the user on a
 * screen that repeats a refusal without ever saying what to do instead.
 */
export type BudgetResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'failed' | 'too_many' }

/**
 * The edit-in-place result (#3166). Distinct from `BudgetResult` because the
 * composition has states the single grant does not:
 *
 * - `refused` — the backend refused the BUILD step by name (revoked agent,
 *   re-key in flight, off-rail account). `detail` is the backend's own
 *   sentence; the old budget is live and untouched.
 * - `revoke_unfinished` — the new grant is LIVE but the old one is not yet
 *   revoked on-chain (the stop signature was cancelled or the submit failed).
 *   `newDelegationHash` lets the caller point at the live budget; the owner
 *   finishes the stop from the budget card's own Stop button.
 * - `oldDelegationRevoked` is false in the one success-shaped race where the
 *   old grant was already revoked before the flow asked for the stop
 *   signature — the goal is met, so this still reports `ok: true`.
 */
export type EditBudgetResult =
  | { ok: true; newDelegationHash: string; oldDelegationRevoked: boolean }
  | { ok: false; reason: 'cancelled' | 'failed' | 'refused' | 'revoke_unfinished'; detail?: string; newDelegationHash?: string }

async function signTyped(
  signer: NonNullable<ReturnType<typeof useActiveSigner>>,
  payload: TypedDataPayload,
): Promise<`0x${string}`> {
  if (signer.type !== 'eoa') {
    // Owner EIP-712 signing over the account payload needs a wallet client;
    // passkey-owner budget signing lands with #836's recovery/WebAuthn work.
    throw new Error('Connect your account owner wallet to set or stop a budget.')
  }
  // ethers/wallet derives EIP712Domain itself; strip it if present.
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

export function useDelegationBudget(
  agentId: string,
  chainId: number,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [budgets, setBudgets] = useState<DelegationBudget[] | null>(null)
  const [signers, setSigners] = useState<AccountSigners | null>(null)
  const [signersError, setSignersError] = useState(false)
  const [budgetsError, setBudgetsError] = useState(false)
  const [busy, setBusy] = useState(false)
  // The ACCOUNT address scopes the signer lookup (#1079): without it the
  // stored-passkey/hybrid branches are unreachable and `ready` would depend
  // on any globally-connected wallet with no per-account check.
  const signer = useActiveSigner({
    accountAddress: signers ? (signers.account_address as Address) : undefined,
    chainId,
  })

  // A failed budget fetch is RETRYABLE, exactly like the signer set below
  // (#2473): it used to collapse into `budgets === null`, which the card
  // reads as "still loading" and renders as nothing at all — so an API
  // failure looked identical to a first paint, and the page's "Add budget"
  // button scrolled to an empty div with no error anywhere.
  //
  // #2732: the `silent` variant (visible-only polling) must change no visible
  // state on a failed tick — `setBudgetsError(true)` flips the card to its
  // error branch, and one swallowed 500 mid-demo would wipe the budget rows
  // the presenter is pointing at. Success still refreshes the rows and
  // clears a stale error flag.
  const reload = useCallback(
    async (silent = false) => {
      if (!enabled) return
      try {
        const res = await api.get<{ delegations: DelegationBudget[] }>(`/agents/${agentId}/delegations`)
        // `?? []` — an absent key must degrade, not crash the route (#3093).
        setBudgets(res.delegations ?? [])
        setBudgetsError(false)
      } catch {
        if (silent) return
        setBudgets(null)
        setBudgetsError(true)
      }
    },
    [agentId, enabled],
  )

  // The signer set feeds pickSigningPath (#1086): the DEVICE picks which of
  // the account's signers to use — never the account's shape. A failed fetch
  // is RETRYABLE (#1079): it sets an error flag instead of stranding the hook
  // at a permanent null.
  const reloadSigners = useCallback(async () => {
    if (!enabled) return
    try {
      const res = await api.get<AccountSigners>(`/agents/${agentId}/account-signers`)
      // `passkeys ?? []` — `pickSigningPath` reads `.length` during render;
      // an answer without the array must degrade, not crash the route (#3093).
      setSigners({ ...res, passkeys: res.passkeys ?? [] })
      setSignersError(false)
    } catch {
      setSigners(null)
      setSignersError(true)
    }
  }, [agentId, enabled])

  useEffect(() => {
    if (!enabled) {
      setBudgets(null)
      setBudgetsError(false)
      setSigners(null)
      setSignersError(false)
      setBusy(false)
      return
    }
    void reload()
    void reloadSigners()
  }, [enabled, reload, reloadSigners])

  // #2732 visible-only polling — budgets only. The signer set is a DEVICE
  // fact, not payment state; polling it every 10s would churn the signing
  // path under an active grant/revoke ceremony. Only `reload` is silent;
  // grant/revoke/revokeAll keep calling `reload()` non-silently after they
  // mutate, so their error surfaces are unchanged.
  useVisiblePolling(() => {
    void reload(true)
  })

  // The signing path is a DEVICE decision, not an account-shape decision:
  // an account with both an owner and passkeys signs with whichever is
  // reachable here (passkey preferred).
  const signingPath = pickSigningPath(signers, signer?.type === 'eoa' ? signer.address : null)

  const grant = useCallback(
    async (input: GrantInput): Promise<BudgetResult> => {
      setBusy(true)
      try {
        const built = await api.post<BuildResponse>(`/agents/${agentId}/delegations/build`, {
          token_address: input.tokenAddress,
          recipient_address: input.recipientAddress ?? null,
          budget_atomic: input.budgetAtomic,
          period_seconds: input.periodSeconds,
        })
        let signature: string
        if (signingPath === 'passkey' && signers) {
          // ONE passkey ceremony — the kit signs the delegation itself; the
          // typed-data message IS the delegation (#828's payload).
          const { signDelegationWithPasskey } = await import('@/lib/delegationPasskeySigner')
          signature = await signDelegationWithPasskey(
            signers,
            built.signing_payload.message as unknown as DelegationMessage,
          )
        } else {
          if (!signer) return { ok: false, reason: 'failed' }
          signature = await signTyped(signer, built.signing_payload)
        }
        await api.post(`/agents/${agentId}/delegations/${built.delegation_hash}/activate`, { signature })
        await reload()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
      } finally {
        setBusy(false)
      }
    },
    [agentId, signingPath, reload, signer, signers],
  )

  // ── Edit budget limits in place (#3166) ──────────────────────────────────
  // REPLACE = grant(new) + revoke(old) — the composition the lifecycle API's
  // header comment defines. The DELEGATE KEY AND LOCAL SIGNER ARE NEVER
  // TOUCHED: both signatures below are OWNER signatures made client-side, and
  // no rotate/rekey endpoint is ever called. Ordering is activate-then-revoke,
  // deliberately: Haven cannot revoke on its own (the revoke UserOp needs an
  // owner signature), and revoking first would leave the agent with NO budget
  // if the new grant is abandoned — the issue's own criterion forbids that.
  // Once the owner signs the new delegation, activation retires the old grant
  // in Haven's mirror atomically (`activatePendingDelegationInSlot`); the
  // follow-up revoke kills it on-chain. Between the two signatures the two
  // grants briefly coexist on-chain (combined exposure = their sum, each
  // caveat-enforced) — that window is stated in the UI copy.
  //
  // Failure shapes, all leaving the old budget live and untouched:
  // - build refused (revoked agent, rekey in flight, off-rail account): the
  //   backend's named 409 travels as `refused`.
  // - new-grant signature cancelled or failed: nothing was granted, nothing
  //   was revoked (`cancelled` / `failed`).
  // - activation raced a revoke-all: the 409 "no longer pending" surfaces as
  //   `failed` with the old state untouched (the grant did not land).
  // - the old budget was ALREADY revoked by the time the stop signature is
  //   asked for (the same revoke-all race, other side): the goal — old grant
  //   dead — is already met, so the flow reports success.
  const editBudget = useCallback(
    async (
      oldDelegationHash: string,
      input: GrantInput,
      opts: { expiresAt?: number } = {},
    ): Promise<EditBudgetResult> => {
      setBusy(true)
      try {
        let built: BuildResponse
        try {
          built = await api.post<BuildResponse>(`/agents/${agentId}/delegations/build`, {
            token_address: input.tokenAddress,
            recipient_address: input.recipientAddress ?? null,
            budget_atomic: input.budgetAtomic,
            period_seconds: input.periodSeconds,
            ...(opts.expiresAt !== undefined ? { expires_at: opts.expiresAt } : {}),
          })
        } catch (err) {
          // The build refusals are named 409s the owner can act on — pass the
          // backend's own sentence through instead of a generic failure.
          if (err instanceof Error && err.message.trim()) {
            return { ok: false, reason: 'refused', detail: err.message }
          }
          throw err
        }
        let grantSignature: string
        if (signingPath === 'passkey' && signers) {
          // ONE passkey ceremony — the kit signs the delegation itself; the
          // typed-data message IS the delegation (#828's payload).
          const { signDelegationWithPasskey } = await import('@/lib/delegationPasskeySigner')
          grantSignature = await signDelegationWithPasskey(
            signers,
            built.signing_payload.message as unknown as DelegationMessage,
          )
        } else {
          if (!signer) return { ok: false, reason: 'failed' }
          grantSignature = await signTyped(signer, built.signing_payload)
        }
        try {
          await api.post(`/agents/${agentId}/delegations/${built.delegation_hash}/activate`, {
            signature: grantSignature,
          })
        } catch (err) {
          // Nothing was granted — the old budget is exactly what it was.
          return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
        }
        // The new grant is live and the old one is retired in the mirror.
        // Kill it on-chain with ONE more owner signature.
        let prep: RevokePrepare
        try {
          prep = await api.post<RevokePrepare>(
            `/agents/${agentId}/delegations/${oldDelegationHash}/revoke`,
            { signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop' },
          )
        } catch (err) {
          // "Already revoked" means the goal is met (a concurrent revoke-all
          // or the reconciliation heal got there first) — not a failure.
          if (err instanceof Error && /already revoked/i.test(err.message)) {
            await reload()
            return { ok: true, newDelegationHash: built.delegation_hash, oldDelegationRevoked: false }
          }
          // The new grant is LIVE; only the on-chain stop of the old one is
          // unfinished. Report the partial state honestly so the UI can tell
          // the owner to finish it from the budget card's Stop button.
          return { ok: false, reason: 'revoke_unfinished', newDelegationHash: built.delegation_hash }
        }
        let revokeSignature: string
        try {
          if (prep.signature_scheme === 'webauthn_userop') {
            if (!signers) {
              return { ok: false, reason: 'revoke_unfinished', newDelegationHash: built.delegation_hash }
            }
            // ONE passkey ceremony — the account signs its own UserOperation.
            const { signUserOpWithPasskey } = await import('@/lib/delegationPasskeySigner')
            revokeSignature = await signUserOpWithPasskey(
              signers,
              prep.user_operation as Record<string, unknown>,
            )
          } else {
            if (!signer || !prep.signing_payload) {
              return { ok: false, reason: 'revoke_unfinished', newDelegationHash: built.delegation_hash }
            }
            revokeSignature = await signTyped(signer, prep.signing_payload)
          }
        } catch {
          // A cancelled or failed STOP signature is NOT the generic outcome:
          // the new grant is already live, so the partial state — not
          // "nothing changed" — is what the owner must be told.
          return { ok: false, reason: 'revoke_unfinished', newDelegationHash: built.delegation_hash }
        }
        try {
          await api.post(`/agents/${agentId}/delegations/${oldDelegationHash}/revoke/submit`, {
            signature: revokeSignature,
            user_operation: prep.user_operation,
          })
        } catch {
          // Same partial-state shape: new grant live, old grant still to stop.
          return { ok: false, reason: 'revoke_unfinished', newDelegationHash: built.delegation_hash }
        }
        await reload()
        return { ok: true, newDelegationHash: built.delegation_hash, oldDelegationRevoked: true }
      } catch (err) {
        return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
      } finally {
        setBusy(false)
      }
    },
    [agentId, signingPath, reload, signer, signers],
  )

  const revoke = useCallback(
    async (delegationHash: string): Promise<BudgetResult> => {
      setBusy(true)
      try {
        // Tell the backend which signer this device will use — the prepared
        // op's gas estimation is shaped by the signature kind, and the server
        // cannot know what is available here.
        const prep = await api.post<RevokePrepare>(`/agents/${agentId}/delegations/${delegationHash}/revoke`, {
          signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop',
        })
        let signature: string
        if (prep.signature_scheme === 'webauthn_userop') {
          if (!signers) return { ok: false, reason: 'failed' }
          // ONE passkey ceremony — the account signs its own UserOperation.
          const { signUserOpWithPasskey } = await import('@/lib/delegationPasskeySigner')
          signature = await signUserOpWithPasskey(
            signers,
            prep.user_operation as Record<string, unknown>,
          )
        } else {
          if (!signer || !prep.signing_payload) return { ok: false, reason: 'failed' }
          signature = await signTyped(signer, prep.signing_payload)
        }
        await api.post(`/agents/${agentId}/delegations/${delegationHash}/revoke/submit`, {
          signature,
          user_operation: prep.user_operation,
        })
        await reload()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
      } finally {
        setBusy(false)
      }
    },
    [agentId, reload, signer, signers, signingPath],
  )

  // #1402/#1400: ONE signature kills every pending/active budget. Mirrors
  // `revoke` exactly; the 409 'Nothing to revoke' is SUCCESS here — it means
  // step 1 of the remove flow is already satisfied (never granted, or a
  // prior partial remove already killed the budgets), so a retry can finish
  // the filing steps.
  const revokeAll = useCallback(async (): Promise<BudgetResult> => {
    setBusy(true)
    try {
      let prep: RevokeAllPrepare
      try {
        prep = await api.post<RevokeAllPrepare>(`/agents/${agentId}/delegations/revoke-all`, {
          signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop',
        })
      } catch (err) {
        if (err instanceof Error && /nothing to revoke/i.test(err.message)) {
          return { ok: true }
        }
        // #1437: the batch/reconcile refusals are recoverable and name their
        // own remedy — surface them as such instead of "the budget could not
        // be stopped", which tells the user nothing they can act on.
        if (err instanceof Error && /too many delegations/i.test(err.message)) {
          return { ok: false, reason: 'too_many' }
        }
        throw err
      }
      let signature: string
      if (prep.signature_scheme === 'webauthn_userop') {
        if (!signers) return { ok: false, reason: 'failed' }
        const { signUserOpWithPasskey } = await import('@/lib/delegationPasskeySigner')
        signature = await signUserOpWithPasskey(
          signers,
          prep.user_operation as Record<string, unknown>,
        )
      } else {
        if (!signer || !prep.signing_payload) return { ok: false, reason: 'failed' }
        signature = await signTyped(signer, prep.signing_payload)
      }
      await api.post(`/agents/${agentId}/delegations/revoke-all/submit`, {
        signature,
        user_operation: prep.user_operation,
        delegation_hashes: prep.delegation_hashes,
      })
      await reload()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
    } finally {
      setBusy(false)
    }
  }, [agentId, reload, signer, signers, signingPath])

  // Ready: some signer for this account is reachable from THIS device — a
  // passkey enrolled here, or the connected owner wallet.
  return {
    budgets,
    grant,
    editBudget,
    revoke,
    revokeAll,
    busy,
    ready: signingPath !== null,
    reload,
    budgetsError,
    signersError,
    reloadSigners,
  }
}

function cancelled(err: unknown): boolean {
  // The passkey path (ox SignFailedError wrapping a NotAllowedError
  // DOMException) is covered by the shared predicate — the #1076 regression.
  // The EOA wallet path additionally says "User rejected the request".
  if (isPasskeyCancellation(err)) return true
  const m = err instanceof Error ? err.message.toLowerCase() : ''
  return m.includes('rejected')
}
