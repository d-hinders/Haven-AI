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

export function useDelegationBudget(agentId: string, chainId: number) {
  const [budgets, setBudgets] = useState<DelegationBudget[] | null>(null)
  const [signers, setSigners] = useState<AccountSigners | null>(null)
  const [signersError, setSignersError] = useState(false)
  const [busy, setBusy] = useState(false)
  // The ACCOUNT address scopes the signer lookup (#1079): without it the
  // stored-passkey/hybrid branches are unreachable and `ready` would depend
  // on any globally-connected wallet with no per-account check.
  const signer = useActiveSigner({
    safeAddress: signers ? (signers.account_address as Address) : undefined,
    chainId,
  })

  const reload = useCallback(async () => {
    try {
      const res = await api.get<{ delegations: DelegationBudget[] }>(`/agents/${agentId}/delegations`)
      setBudgets(res.delegations)
    } catch {
      setBudgets(null)
    }
  }, [agentId])

  // The signer set feeds pickSigningPath (#1086): the DEVICE picks which of
  // the account's signers to use — never the account's shape. A failed fetch
  // is RETRYABLE (#1079): it sets an error flag instead of stranding the hook
  // at a permanent null.
  const reloadSigners = useCallback(async () => {
    try {
      setSigners(await api.get<AccountSigners>(`/agents/${agentId}/account-signers`))
      setSignersError(false)
    } catch {
      setSigners(null)
      setSignersError(true)
    }
  }, [agentId])

  useEffect(() => {
    void reload()
    void reloadSigners()
  }, [reload, reloadSigners])

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
    revoke,
    revokeAll,
    busy,
    ready: signingPath !== null,
    reload,
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
