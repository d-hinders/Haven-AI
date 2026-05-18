'use client'

import { useMemo, useState } from 'react'
import type { Address, Hash } from 'viem'
import type { User } from '@/context/AuthContext'
import { api, ApiRequestError, type ListPasskeysResponse } from '@/lib/api'
import { base64UrlEncode, createPasskey, PasskeyCancelledError, PasskeyUnsupportedError } from '@/lib/passkey'
import { displayName } from '@/lib/user'
import {
  PASSKEY_SCHEMA_VERSION,
  rememberPasskeyCredentialOnDevice,
  setStoredPasskeySigner,
} from '@/lib/signer'

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

const CROSS_DEVICE_PASSKEY_MESSAGE =
  'You already enrolled a passkey on another device. Sign in there to continue.'

export default function PasskeyEnrollFlow({
  user,
  selectedChainId,
  onComplete,
  onError,
}: PasskeyEnrollFlowProps) {
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState<string | null>(null)

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
    setError(null)

    try {
      const createdPasskey = await createPasskey({
        userId: getRandomUserId(),
        userName: user.email,
        userDisplayName: displayName(user),
      })

      let signerAddress = ''
      let credentialId = createdPasskey.credentialId
      let storedPublicKey: { x: `0x${string}`; y: `0x${string}` } | undefined = createdPasskey.publicKey

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

      setStage('deploying')
      let safeAddress = '' as Address
      let txHash = EMPTY_TX_HASH

      try {
        const deployed = await api.deployPasskeySafe({ chain_id: selectedChainId })
        safeAddress = deployed.safe_address as Address
        txHash = deployed.tx_hash as Hash
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

      rememberPasskeyCredentialOnDevice(createdPasskey.credentialId)
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
        message = 'This browser does not support passkeys. Connect a wallet instead.'
      } else if (err instanceof ApiRequestError) {
        message = err.message
      } else if (err instanceof Error && err.message) {
        message = err.message
      }

      setStage('error')
      setError(message)
      onError(message)
    }
  }

  return (
    <div className="space-y-5">
      {stage === 'idle' && (
        <div className="space-y-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">Use Face ID or Touch ID</h1>
            <p className="text-sm text-[var(--v2-ink-2)] leading-relaxed">
              Create a secure passkey to approve actions in your Haven account.
            </p>
          </div>

          <button
            onClick={() => {
              void start()
            }}
            className="w-full py-2.5 rounded-md bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-all duration-200 shadow-[var(--v2-shadow-button)]"
          >
            Continue with Face ID / Touch ID
          </button>
        </div>
      )}

      {stage !== 'idle' && (
        <div className="relative space-y-3">
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
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
              Setting up your Haven account
            </h1>
            <p className="text-sm text-[var(--v2-ink-2)] leading-relaxed">
              We&apos;re creating your passkey and bringing your account online. Stay on this tab — it
              takes a few seconds.
            </p>
          </div>

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
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 ${
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
                  {(isActive || stage === 'error') && (
                    <div className="text-[11px] text-[var(--v2-ink-3)] mt-0.5 leading-relaxed">
                      {stage === 'error' ? error : item.hint}
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

      {stage === 'error' && (
        <div className="space-y-4">
          <div className="rounded-md border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
            {error}
          </div>
          <button
            onClick={() => {
              void start()
            }}
            className="w-full py-2.5 rounded-md border border-[var(--v2-border-strong)] bg-white text-[var(--v2-ink)] text-sm font-medium hover:bg-[var(--v2-surface)] transition-colors"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
