'use client'

/**
 * Account signer management for the delegation rail (#888, epic #836).
 *
 * The recovery substrate: enroll a backup passkey (or an EOA owner), remove a
 * passkey — each an ACCOUNT op (addKey/removeKey/transferOwnership) the backend
 * prepares and an EXISTING signer signs (WebAuthn or EOA, per the account's
 * kind). Haven signs nothing. The ≥2-signer rule is enforced on-chain (the
 * #884 CannotRemoveLastSigner finding) AND surfaced by the backend as a clean
 * 409, so the UI never has to guess.
 */

import { useCallback, useEffect, useState } from 'react'
import { toHex, type Address } from 'viem'
import { api } from '@/lib/api'
import { useActiveSigner } from '@/lib/signer'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'
import { createPasskey, base64UrlDecode } from '@/lib/passkey'
import type { AccountSigners } from '@/lib/delegationPasskeySigner'

export type SignerResult = { ok: true } | { ok: false; reason: 'cancelled' | 'blocked' | 'failed'; message?: string }

interface PrepareResponse {
  signature_scheme: 'eip712_userop' | 'webauthn_userop'
  signing_payload?: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }
  user_op_hash?: string
  user_operation: Record<string, unknown>
}

export function useAccountSigners(agentId: string, chainId: number, userEmail: string) {
  const [signers, setSigners] = useState<AccountSigners | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  // Scope the signer lookup to the ACCOUNT (#1079) — without safeAddress the
  // stored-passkey/hybrid branches are unreachable and `ready` would track
  // whatever wallet happens to be globally connected.
  const signer = useActiveSigner({
    safeAddress: signers ? (signers.account_address as Address) : undefined,
    chainId,
  })

  // A failed fetch is retryable via `reload` — it flags the error instead of
  // stranding the account at a permanent null signer set (#1079).
  const reload = useCallback(async () => {
    try {
      setSigners(await api.get<AccountSigners>(`/agents/${agentId}/account-signers`))
      setLoadError(false)
    } catch {
      setSigners(null)
      setLoadError(true)
    }
  }, [agentId])

  useEffect(() => {
    void reload()
  }, [reload])

  const passkeyOnly = !!signers && !signers.owner_address && signers.passkeys.length > 0

  /** Sign the prepared op with the account's kind of signer (never Haven). */
  const signPrepared = useCallback(
    async (prep: PrepareResponse): Promise<string> => {
      if (prep.signature_scheme === 'webauthn_userop') {
        if (!signers) throw new Error('signers not loaded')
        const { signUserOpWithPasskey } = await import('@/lib/delegationPasskeySigner')
        return signUserOpWithPasskey(signers, prep.user_operation)
      }
      if (!signer || signer.type !== 'eoa' || !prep.signing_payload) {
        throw new Error('Connect your account owner wallet')
      }
      const types = { ...prep.signing_payload.types }
      delete (types as Record<string, unknown>).EIP712Domain
      return signer.walletClient.signTypedData({
        account: signer.address,
        domain: prep.signing_payload.domain,
        types,
        primaryType: prep.signing_payload.primaryType,
        message: prep.signing_payload.message,
      } as never)
    },
    [signer, signers],
  )

  const run = useCallback(
    async (body: Record<string, unknown>): Promise<SignerResult> => {
      setBusy(true)
      try {
        const prep = await api.post<PrepareResponse>(`/agents/${agentId}/account-signers/prepare`, body)
        const signature = await signPrepared(prep)
        await api.post(`/agents/${agentId}/account-signers/submit`, {
          ...body,
          signature,
          user_operation: prep.user_operation,
        })
        await reload()
        return { ok: true }
      } catch (err) {
        // Shared predicate (#1079): the WebAuthn path throws ox's
        // SignFailedError, never our PasskeyCancelledError — an instanceof
        // check here classified every dismissed sheet as a failure.
        if (isPasskeyCancellation(err)) return { ok: false, reason: 'cancelled' }
        const status = (err as { status?: number }).status
        const message = err instanceof Error ? err.message : undefined
        if (status === 409) return { ok: false, reason: 'blocked', message }
        return { ok: false, reason: 'failed', message }
      } finally {
        setBusy(false)
      }
    },
    [agentId, reload, signPrepared],
  )

  /** Enroll a backup passkey — a fresh WebAuthn credential on this device. */
  const enrollBackupPasskey = useCallback(async (): Promise<SignerResult> => {
    let created
    try {
      created = await createPasskey({
        userId: crypto.getRandomValues(new Uint8Array(32)),
        userName: userEmail,
        userDisplayName: userEmail,
      })
    } catch (err) {
      if (isPasskeyCancellation(err)) return { ok: false, reason: 'cancelled' }
      return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : undefined }
    }
    return run({
      action: 'add_passkey',
      passkey: {
        key_id: toHex(base64UrlDecode(created.credentialId)),
        x: created.publicKey.x,
        y: created.publicKey.y,
      },
    })
  }, [run, userEmail])

  const enrollOwnerWallet = useCallback(
    (ownerAddress: string): Promise<SignerResult> => run({ action: 'add_owner', owner_address: ownerAddress }),
    [run],
  )

  const removePasskey = useCallback(
    (keyId: string): Promise<SignerResult> => run({ action: 'remove_passkey', passkey: { key_id: keyId } }),
    [run],
  )

  return {
    signers,
    loadError,
    busy,
    // Managing signers requires being able to sign as an EXISTING signer:
    // a passkey account signs with its passkey; an EOA account needs its wallet.
    ready: passkeyOnly || signer?.type === 'eoa',
    enrollBackupPasskey,
    enrollOwnerWallet,
    removePasskey,
    reload,
  }
}
