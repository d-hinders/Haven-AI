'use client'

/**
 * Account signer management for the delegation rail (#888, epic #836).
 *
 * The recovery substrate: enroll a backup passkey (or an EOA owner), remove a
 * passkey or the owner — each an ACCOUNT op (addKey/removeKey/
 * transferOwnership) the backend prepares and an EXISTING signer signs
 * (WebAuthn or EOA — whichever this DEVICE can produce, #1086). Haven signs
 * nothing. Haven's ≥2-signer rule is surfaced as a clean 409 (the chain
 * itself refuses only removing the LAST signer, the #884
 * CannotRemoveLastSigner finding), so the UI never has to guess.
 *
 * Account-scoped (#1089) — calls `/accounts/hybrid/:address/signers/*` (#1081)
 * rather than the agent-scoped twin, so a fresh account with zero agents can
 * still enrol the second signer the #908 mainnet floor requires.
 */

import { useCallback, useEffect, useState } from 'react'
import { toHex, type Address } from 'viem'
import { api } from '@/lib/api'
import { useActiveSigner, rememberPasskeyCredentialOnDevice } from '@/lib/signer'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'
import { signPreparedAccountOp } from '@/lib/hybridAccountOps'
import { createPasskey, base64UrlDecode } from '@/lib/passkey'
import type { AccountSigners } from '@/lib/delegationPasskeySigner'
import { pickSigningPath, passkeyLikelyElsewhere } from './useDelegationBudget'

export type SignerResult = { ok: true } | { ok: false; reason: 'cancelled' | 'blocked' | 'failed'; message?: string }

interface PrepareResponse {
  signature_scheme: 'eip712_userop' | 'webauthn_userop'
  signing_payload?: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }
  user_op_hash?: string
  user_operation: Record<string, unknown>
}

export function useAccountSigners(safeAddress: string, chainId: number, userEmail: string) {
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
      setSigners(
        await api.get<AccountSigners>(`/accounts/hybrid/${safeAddress}/signers?chain_id=${chainId}`),
      )
      setLoadError(false)
    } catch {
      setSigners(null)
      setLoadError(true)
    }
  }, [safeAddress, chainId])

  useEffect(() => {
    void reload()
  }, [reload])

  // Device decision, not account-shape decision (the multi-signer fix): an
  // account with both an owner and passkeys signs with whichever is reachable
  // from here — enrolling a backup wallet must never strand the passkey.
  const signingPath = pickSigningPath(signers, signer?.type === 'eoa')

  /** Sign the prepared op with the account's kind of signer (never Haven). */
  const signPrepared = useCallback(
    (prep: PrepareResponse): Promise<string> => signPreparedAccountOp(prep, signers, signer),
    [signer, signers],
  )

  const run = useCallback(
    async (body: Record<string, unknown>): Promise<SignerResult> => {
      setBusy(true)
      try {
        // Tell the backend which signer this device will use — gas estimation
        // is shaped by the signature kind, and only the device knows what is
        // available.
        const prep = await api.post<PrepareResponse>(
          `/accounts/hybrid/${safeAddress}/signers/prepare?chain_id=${chainId}`,
          {
            ...body,
            signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop',
          },
        )
        const signature = await signPrepared(prep)
        await api.post(`/accounts/hybrid/${safeAddress}/signers/submit?chain_id=${chainId}`, {
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
    [safeAddress, chainId, reload, signPrepared, signingPath],
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
    const result = await run({
      action: 'add_passkey',
      passkey: {
        key_id: toHex(base64UrlDecode(created.credentialId)),
        x: created.publicKey.x,
        y: created.publicKey.y,
      },
    })
    // The credential was just created HERE — record that, or the #1097
    // cross-device hint (and pickSigningPath's on-device preference)
    // misreads a backup enrolled on this device as living elsewhere.
    if (result.ok) rememberPasskeyCredentialOnDevice(created.credentialId)
    return result
  }, [run, userEmail])

  const enrollOwnerWallet = useCallback(
    (ownerAddress: string): Promise<SignerResult> => run({ action: 'add_owner', owner_address: ownerAddress }),
    [run],
  )

  const removePasskey = useCallback(
    (keyId: string): Promise<SignerResult> => run({ action: 'remove_passkey', passkey: { key_id: keyId } }),
    [run],
  )

  // #1087: enrolling a wallet owner is not a one-way door — the account can
  // return to passkey-only. The backend refuses removals that would leave no
  // signer (and applies the #908 mainnet floor).
  const removeOwner = useCallback(
    (): Promise<SignerResult> => run({ action: 'remove_owner' }),
    [run],
  )

  return {
    signers,
    loadError,
    busy,
    // Managing signers requires being able to sign as an EXISTING signer —
    // any signer reachable from this device (passkey here, or the connected
    // owner wallet).
    ready: signingPath !== null,
    // #1097: hint condition — the ceremony may hand off to another device.
    passkeyElsewhere: passkeyLikelyElsewhere(signers),
    enrollBackupPasskey,
    enrollOwnerWallet,
    removePasskey,
    removeOwner,
    reload,
  }
}
