'use client'

import { useMemo, useState } from 'react'
import type { Address, Hash } from 'viem'
import type { User } from '@/context/AuthContext'
import { api, ApiRequestError, type ListPasskeysResponse } from '@/lib/api'
import { base64UrlEncode, createPasskey, PasskeyCancelledError, PasskeyUnsupportedError } from '@/lib/passkey'
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
      return 'Creating passkey'
    case 'enrolling':
      return 'Enrolling signer'
    case 'deploying':
      return 'Deploying Safe'
    case 'registering':
      return 'Registering with Haven'
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
      return 'Approve the browser prompt to create your passkey.'
    case 'enrolling':
      return 'Saving your signer metadata to Haven.'
    case 'deploying':
      return 'Haven is asking the relayer to deploy your Safe.'
    case 'registering':
      return 'Linking the Safe to your account.'
    case 'done':
      return 'Your passkey-backed Safe is ready.'
    case 'error':
      return 'You can retry from this browser whenever you are ready.'
    default:
      return 'Face ID / Touch ID will be used as the owner of your Safe.'
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
        userDisplayName: user.email,
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
            <h1 className="text-2xl font-bold tracking-tight mb-2">Use Face ID or Touch ID</h1>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Create a secure passkey to approve actions in your Haven account.
            </p>
          </div>

          <button
            onClick={() => {
              void start()
            }}
            className="w-full py-2.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
          >
            Continue with Face ID / Touch ID
          </button>
        </div>
      )}

      {stage !== 'idle' && (
        <div className="space-y-3">
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
                    ? 'border-indigo-500/40 bg-indigo-500/[0.06]'
                    : isDone
                      ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
                      : 'border-white/[0.05] bg-white/[0.01]'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 ${
                    isActive
                      ? 'bg-indigo-500/20 text-indigo-300'
                      : isDone
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-white/[0.04] text-zinc-600'
                  }`}
                >
                  {isDone ? '✓' : isActive ? <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" /> : index + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`text-xs font-medium ${isActive ? 'text-indigo-200' : isDone ? 'text-emerald-300/80' : 'text-zinc-500'}`}>
                    {item.label}
                  </div>
                  {(isActive || stage === 'error') && (
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      {stage === 'error' ? error : item.hint}
                    </div>
                  )}
                </div>
                {isActive && (
                  <div className="w-3 h-3 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin shrink-0" />
                )}
              </div>
            )
          })}
        </div>
      )}

      {stage === 'error' && (
        <div className="space-y-4">
          <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-4 py-3">
            {error}
          </div>
          <button
            onClick={() => {
              void start()
            }}
            className="w-full py-2.5 rounded-md border border-white/[0.08] bg-white/[0.02] text-zinc-200 text-sm font-medium hover:bg-white/[0.05] transition-colors"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
