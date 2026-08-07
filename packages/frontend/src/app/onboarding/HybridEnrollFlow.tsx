'use client'

/**
 * Passkey → Hybrid DeleGator onboarding (#886, epic #836).
 *
 * The delegation-rail signup: create a passkey, register the account with its
 * P256 coordinates (POST /accounts/hybrid, #885 persists the signer set), and
 * land on the dashboard. The account is COUNTERFACTUAL — no deployment
 * transaction here; the first budget grant relayer-deploys it (#860). That is
 * the whole flow: one Face ID prompt, zero transactions, zero gas.
 *
 * The user never sees an address ceremony, a wallet, or a seed phrase — the
 * copy stays in outcome language (copy-guidelines).
 *
 * The heading and intro live on the single onboarding screen that hosts this
 * flow (#1162); this component owns the action and its progress only.
 */

import { useEffect, useState } from 'react'
import { toHex } from 'viem'
import { api, ApiRequestError } from '@/lib/api'
import {
  base64UrlDecode,
  createPasskey,
  PasskeyCancelledError,
  PasskeyUnsupportedError,
} from '@/lib/passkey'
import { rememberPasskeyCredentialOnDevice } from '@/lib/signer'
import type { User } from '@/context/AuthContext'
import { Button } from '@/components/ui/Button'
import { PASSKEY_REQUIRED_MESSAGE } from './copy'

type Stage = 'idle' | 'creating_passkey' | 'creating_account' | 'done'

interface HybridEnrollFlowProps {
  user: User
  selectedChainId: number
  onComplete: (args: { accountAddress: `0x${string}` }) => void
  onError: (message: string) => void
  /** Reports whether creation is in flight, so the host screen can settle. */
  onCreatingChange?: (creating: boolean) => void
}

function displayName(user: User): string {
  return user.name?.trim() || user.email
}

function getRandomUserId(): Uint8Array {
  const id = new Uint8Array(32)
  crypto.getRandomValues(id)
  return id
}

export default function HybridEnrollFlow({
  user,
  selectedChainId,
  onComplete,
  onError,
  onCreatingChange,
}: HybridEnrollFlowProps) {
  const [stage, setStage] = useState<Stage>('idle')
  // A browser without WebAuthn fails identically on every attempt, and
  // onboarding has no wallet fallback to offer — so it gets the message and no
  // action, rather than a button that can only fail again.
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    onCreatingChange?.(stage !== 'idle')
  }, [onCreatingChange, stage])

  async function start(): Promise<void> {
    setStage('creating_passkey')
    onError('')

    try {
      const created = await createPasskey({
        userId: getRandomUserId(),
        userName: user.email,
        userDisplayName: displayName(user),
      })

      setStage('creating_account')
      // key_id = hex of the raw credential id — the SAME string the account's
      // address is derived from and that the signer (#887) converts back to
      // base64url for navigator lookups. One format, stored once (#885).
      const keyId = toHex(base64UrlDecode(created.credentialId))
      // A fresh credential means a fresh deterministic address, so the
      // register cannot collide; a 409 (exact same passkey set re-registered)
      // surfaces as a normal error with the route's message.
      const account = await api.post<{ account_address: `0x${string}` }>('/accounts/hybrid', {
        chain_id: selectedChainId,
        passkeys: [{ key_id: keyId, x: created.publicKey.x, y: created.publicKey.y }],
      })
      const accountAddress = account.account_address

      rememberPasskeyCredentialOnDevice(created.credentialId)
      setStage('done')
      onComplete({ accountAddress })
    } catch (err) {
      let message = 'Account setup failed. Please try again.'
      if (err instanceof PasskeyCancelledError) {
        message = 'Face ID prompt was cancelled.'
      } else if (err instanceof PasskeyUnsupportedError) {
        message = PASSKEY_REQUIRED_MESSAGE
        setBlocked(true)
      } else if (err instanceof ApiRequestError) {
        message = err.message
      }
      setStage('idle')
      onError(message)
    }
  }

  if (blocked) return null

  if (stage === 'idle') {
    return (
      <Button onClick={() => void start()} size="lg" className="w-full">
        Create account with Face ID / Touch ID
      </Button>
    )
  }

  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3"
    >
      <div className="h-2 w-2 animate-pulse rounded-full bg-[var(--v2-brand)]" />
      <span className="text-sm text-[var(--v2-ink-2)]">
        {stage === 'creating_passkey' ? 'Waiting for Face ID…' : 'Setting up your account…'}
      </span>
    </div>
  )
}
