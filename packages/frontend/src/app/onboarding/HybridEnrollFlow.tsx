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
import { classifyAgentUserAgent } from '@/lib/discovery'
import { AgentPasskeyHandoff } from '@/components/onboarding/AgentHandoffNote'
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
  /**
   * #2524: whether the agent hand-off belongs on this step, and which of its
   * two forms.
   *
   *   'wall'     — WebAuthn is not available here. Nothing can be created in
   *                this browser, so the hand-off IS the step: agent line
   *                first, then the human sentence beneath it.
   *   'advisory' — the user agent is a known agent family but WebAuthn works.
   *                The browser can create a passkey; it just must not be this
   *                party creating it. Saying "cannot" would be false and
   *                removing the button would strand a human whose browser
   *                carries an odd UA, so the line sits above a live button.
   *
   * `null` until the effect runs — `PublicKeyCredential` and
   * `navigator.userAgent` are client-only, so deciding during render would
   * make the server and the first client render disagree.
   *
   * Detection is PROACTIVE, not post-failure: an agent that never presses the
   * button never reaches the catch block, and telling it what to do only after
   * it has tried is telling it too late.
   */
  const [handoffKind, setHandoffKind] = useState<'wall' | 'advisory' | null>(null)

  useEffect(() => {
    // Both markers, because they answer different questions and the flow needs
    // both to be true: `PublicKeyCredential` is WebAuthn specifically, and
    // `navigator.credentials` is what `createPasskey` reaches for (it throws
    // PasskeyUnsupportedError without it).
    const canCreatePasskey =
      typeof window.PublicKeyCredential !== 'undefined' && Boolean(navigator.credentials)
    if (!canCreatePasskey) {
      setHandoffKind('wall')
      setBlocked(true)
      return
    }
    if (classifyAgentUserAgent(navigator.userAgent) !== null) setHandoffKind('advisory')
  }, [])

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
        message = 'The passkey prompt was cancelled.'
      } else if (err instanceof PasskeyUnsupportedError) {
        // The wall renders here, not through `onError` (#2524): the human
        // sentence has to sit BENEATH the agent hand-off, and the host
        // screen's alert is above this component. `message` stays empty so
        // the same sentence is not also shown up there.
        message = ''
        setBlocked(true)
        setHandoffKind('wall')
      } else if (err instanceof ApiRequestError) {
        message = err.message
      }
      setStage('idle')
      onError(message)
    }
  }

  const handoff = handoffKind ? (
    <AgentPasskeyHandoff
      path="/onboarding"
      canCreatePasskey={handoffKind === 'advisory'}
      humanMessage={PASSKEY_REQUIRED_MESSAGE}
    />
  ) : null

  // An honest dead end: the hand-off is the whole content, and there is no
  // button here that could only fail the same way (#1162).
  if (blocked) return handoff

  if (stage === 'idle') {
    return (
      <div className="space-y-4">
        {handoff}
        <Button onClick={() => void start()} size="lg" className="w-full">
          Create account with a passkey
        </Button>
      </div>
    )
  }

  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3"
    >
      <div className="h-2 w-2 animate-pulse rounded-full bg-[var(--v2-brand)]" />
      <span className="text-sm text-[var(--v2-ink-2)]">
        {stage === 'creating_passkey' ? 'Waiting for your passkey…' : 'Setting up your account…'}
      </span>
    </div>
  )
}
