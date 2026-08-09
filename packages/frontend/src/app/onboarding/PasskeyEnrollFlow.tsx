'use client'

/**
 * Passkey → Safe onboarding (the non-delegation path).
 *
 * The heading and intro live on the single onboarding screen that hosts this
 * flow (#1162); this component owns the action, its progress list, and the
 * retry affordance only.
 */

import { useEffect, useMemo, useState } from 'react'
import type { Address, Hash } from 'viem'
import type { User } from '@/context/AuthContext'
import { api, ApiRequestError, type ListPasskeysResponse } from '@/lib/api'
import { base64UrlEncode, createPasskey, getPasskeyAssertion, PasskeyCancelledError, PasskeyUnsupportedError } from '@/lib/passkey'
import { displayName } from '@/lib/user'
import {
  PASSKEY_SCHEMA_VERSION,
  rememberPasskeyCredentialOnDevice,
  setStoredPasskeySigner,
} from '@/lib/signer'
import { Button } from '@/components/ui/Button'
import { PASSKEY_REQUIRED_MESSAGE } from './copy'

const EMPTY_TX_HASH = `0x${'0'.repeat(64)}` as Hash

type Stage =
  | 'idle'
  | 'creating_passkey'
  | 'enrolling'
  | 'deploying'
  | 'registering'
  | 'done'
  | 'error'

interface PasskeyEnrollFlowProps {
  user: User
  selectedChainId: number
  onComplete: (args: { safeAddress: Address; txHash: Hash }) => void
  onError: (message: string) => void
  /** Reports whether creation is in flight, so the host screen can settle. */
  onCreatingChange?: (creating: boolean) => void
}

function getRandomUserId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

function stageLabel(stage: Stage): string {
  switch (stage) {
    case 'creating_passkey':
      return 'Creating your passkey'
    case 'enrolling':
      return 'Saving it to your account'
    case 'deploying':
      return 'Bringing your account online'
    case 'registering':
      return 'Tying it to Haven'
    case 'done':
      return 'Done'
    case 'error':
      return 'Setup failed'
    default:
      return 'Ready'
  }
}

function stageHint(stage: Stage): string {
  switch (stage) {
    case 'creating_passkey':
      return 'Approve the Face ID / Touch ID prompt to create a private key only this device can use.'
    case 'enrolling':
      return 'Saving your sign-in method to Haven so this device can authorise payments later.'
    case 'deploying':
      return 'Creating your on-chain Haven account. This usually takes a few seconds.'
    case 'registering':
      return 'Linking your on-chain account to your Haven profile.'
    case 'done':
      return 'Your Haven account is ready.'
    case 'error':
      return 'You can retry from this browser whenever you are ready.'
    default:
      return 'Face ID / Touch ID will approve payments and changes for this account.'
  }
}

function getPasskeyForChain(
  passkeys: ListPasskeysResponse['passkeys'],
  chainId: number,
): ListPasskeysResponse['passkeys'][number] | null {
  return passkeys.find((passkey) => passkey.chain_id === chainId) ?? null
}

// The user IS signed in when they see these — the session is email/password;
// the passkey is the signing key. So neither message may say "sign in" (#1229).
const CROSS_DEVICE_PASSKEY_MESSAGE =
  'This account already has a passkey for this network. Open Haven in the browser or on the device where it was created to continue.'

const RESUME_FAILED_MESSAGE =
  'This account already has a passkey for this network, but this device could not confirm it. Try again here, or open Haven where the passkey was created.'

export default function PasskeyEnrollFlow({
  user,
  selectedChainId,
  onComplete,
  onError,
  onCreatingChange,
}: PasskeyEnrollFlowProps) {
  const [stage, setStage] = useState<Stage>('idle')
  // A browser without WebAuthn will fail identically on every attempt, and
  // onboarding has no wallet fallback to offer — so it gets the message and no
  // retry, rather than a button that can only fail again.
  const [blocked, setBlocked] = useState(false)

  // 'error' is a settled state — the host screen re-enables the network picker
  // so a retry can pick a different chain.
  useEffect(() => {
    onCreatingChange?.(stage !== 'idle' && stage !== 'error')
  }, [onCreatingChange, stage])

  const stageItems = useMemo(
    () =>
      ([
        'creating_passkey',
        'enrolling',
        'deploying',
        'registering',
      ] as const).map((item) => ({
        id: item,
        label: stageLabel(item),
        hint: stageHint(item),
      })),
    [],
  )

  async function start(): Promise<void> {
    setStage('creating_passkey')
    onError('') // clear any previous failure the host screen is still showing

    try {
      // #1229: RESUME before create. The account may already hold a passkey
      // for this chain (enrolled earlier, local state since cleared). The old
      // flow always created a NEW credential first, collided with the 409,
      // compared the fresh id against the enrolled one — necessarily
      // different, because it was just minted — and concluded "another
      // device" even on the device that holds the working passkey. Ask the
      // authenticator to CONFIRM the enrolled credential instead: success
      // proves possession and the flow continues to the (already idempotent)
      // deploy/register steps.
      const { passkeys: preexisting } = await api.listPasskeys()
      const alreadyEnrolled = getPasskeyForChain(preexisting, selectedChainId)

      let signerAddress = ''
      let credentialId = ''
      let storedPublicKey: { x: `0x${string}`; y: `0x${string}` } | undefined

      if (alreadyEnrolled) {
        try {
          await getPasskeyAssertion({
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentialIds: [alreadyEnrolled.credential_id],
          })
        } catch (err) {
          if (err instanceof PasskeyUnsupportedError) {
            throw err
          }
          // A cancel and a genuinely-absent credential both surface as
          // NotAllowedError — WebAuthn does not let us tell them apart, so
          // one honest message covers both rather than guessing "cancelled".
          throw new Error(RESUME_FAILED_MESSAGE)
        }
        signerAddress = alreadyEnrolled.signer_address
        credentialId = alreadyEnrolled.credential_id
        // The server row's public key is not in the list payload; the stored
        // signer works without it (publicKey is optional in the schema).
      } else {
        const createdPasskey = await createPasskey({
          userId: getRandomUserId(),
          userName: user.email,
          userDisplayName: displayName(user),
        })

        credentialId = createdPasskey.credentialId
        storedPublicKey = createdPasskey.publicKey

        setStage('enrolling')
        try {
          const enrolled = await api.enrollPasskey({
            credential_id: createdPasskey.credentialId,
            public_key_x: createdPasskey.publicKey.x,
            public_key_y: createdPasskey.publicKey.y,
            chain_id: selectedChainId,
            raw_attestation_object: base64UrlEncode(createdPasskey.rawAttestationObject),
          })
          signerAddress = enrolled.signer_address
          credentialId = enrolled.credential_id
        } catch (err) {
          // Race window only, now that the resume path runs first: another
          // tab/device enrolled between our list and our insert.
          if (!(err instanceof ApiRequestError) || err.status !== 409) {
            throw err
          }

          const { passkeys } = await api.listPasskeys()
          const existing = getPasskeyForChain(passkeys, selectedChainId)
          if (!existing) {
            throw err
          }

          if (existing.credential_id !== createdPasskey.credentialId) {
            throw new Error(CROSS_DEVICE_PASSKEY_MESSAGE)
          }

          signerAddress = existing.signer_address
          credentialId = existing.credential_id
          storedPublicKey = createdPasskey.publicKey
        }
      }

      setStage('deploying')
      let safeAddress = (alreadyEnrolled?.safe_address ?? '') as Address
      let txHash = EMPTY_TX_HASH

      try {
        if (!safeAddress) {
          const deployed = await api.deployPasskeySafe({ chain_id: selectedChainId })
          safeAddress = deployed.safe_address as Address
          txHash = deployed.tx_hash as Hash
        }
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.status !== 409) {
          throw err
        }

        const { passkeys } = await api.listPasskeys()
        const existing = getPasskeyForChain(passkeys, selectedChainId)
        if (!existing?.safe_address) {
          throw err
        }

        safeAddress = existing.safe_address as Address
      }

      setStage('registering')
      try {
        await api.post('/user/safes', {
          safe_address: safeAddress,
          chain_id: selectedChainId,
        })
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.status !== 409) {
          throw err
        }
      }

      rememberPasskeyCredentialOnDevice(credentialId)
      setStoredPasskeySigner({
        schemaVersion: PASSKEY_SCHEMA_VERSION,
        address: signerAddress as Address,
        credentialId,
        publicKey: storedPublicKey,
        chainId: selectedChainId,
        safeAddress,
        createdAt: Date.now(),
      })

      setStage('done')
      onComplete({ safeAddress, txHash })
    } catch (err) {
      let message = 'Passkey setup failed. Please try again.'

      if (err instanceof PasskeyCancelledError) {
        message = 'Face ID prompt was cancelled.'
      } else if (err instanceof PasskeyUnsupportedError) {
        message = PASSKEY_REQUIRED_MESSAGE
        setBlocked(true)
      } else if (err instanceof ApiRequestError) {
        message = err.message
      } else if (err instanceof Error && err.message) {
        message = err.message
      }

      setStage('error')
      onError(message)
    }
  }

  return (
    <div className="space-y-5">
      {stage === 'idle' && (
        <Button
          onClick={() => {
            void start()
          }}
          size="lg"
          className="w-full"
        >
          Create account with Face ID / Touch ID
        </Button>
      )}

      {stage !== 'idle' && stage !== 'error' && (
        <div role="status" className="relative space-y-3">
          {/* Mesh-drift backdrop during the wait — calms the moment the
              user is staring at a spinner without information. */}
          <div
            aria-hidden="true"
            className="v2-mesh-drift pointer-events-none absolute -inset-x-4 -inset-y-2 -z-10 opacity-60"
            style={{
              background:
                'radial-gradient(ellipse 60% 50% at 30% 30%, rgba(99,102,241,0.16) 0%, transparent 70%), radial-gradient(ellipse 55% 45% at 75% 70%, rgba(14,165,233,0.13) 0%, transparent 65%)',
            }}
          />
          {stageItems.map((item, index) => {
            const order: Stage[] = ['creating_passkey', 'enrolling', 'deploying', 'registering']
            const currentIndex = order.indexOf(stage)
            const isActive = stage === item.id
            const isDone = currentIndex > index || stage === 'done'

            return (
              <div
                key={item.id}
                className={`flex items-center gap-3 px-3 py-3 rounded-md border transition-colors duration-300 ${
                  isActive
                    ? 'border-[var(--v2-brand)]/35 bg-[var(--v2-brand-soft)]'
                    : isDone
                      ? 'border-[var(--v2-success)]/20 bg-[var(--v2-success-soft)]'
                      : 'border-[var(--v2-border)] bg-white'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium shrink-0 ${
                    isActive
                      ? 'bg-white text-[var(--v2-brand)]'
                      : isDone
                        ? 'bg-white text-[var(--v2-success)]'
                        : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
                  }`}
                >
                  {isDone ? (
                    '✓'
                  ) : isActive ? (
                    <span className="animate-pending-pulse w-2 h-2 rounded-full bg-[var(--v2-brand)]" />
                  ) : (
                    index + 1
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`text-xs font-medium ${isActive ? 'text-[var(--v2-brand)]' : isDone ? 'text-[var(--v2-success)]' : 'text-[var(--v2-ink-3)]'}`}>
                    {item.label}
                  </div>
                  {isActive && (
                    <div className="text-xs text-[var(--v2-ink-3)] mt-0.5 leading-relaxed">
                      {item.hint}
                    </div>
                  )}
                </div>
                {isActive && (
                  <div className="w-3 h-3 border-2 border-[var(--v2-brand)]/30 border-t-[var(--v2-brand)] rounded-full animate-spin shrink-0" />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* The message itself is rendered once, by the host screen, from
          `onError` — this owns the retry only, so the two can't double up. */}
      {stage === 'error' && !blocked && (
        <Button
          onClick={() => {
            void start()
          }}
          variant="ghost"
          size="lg"
          className="w-full"
        >
          Try again
        </Button>
      )}
    </div>
  )
}
