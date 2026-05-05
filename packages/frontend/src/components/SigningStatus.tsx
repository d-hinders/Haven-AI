'use client'

import type { HavenUserSigner } from '@/lib/signer'

interface SigningStatusProps {
  signer: HavenUserSigner | null
  stage: 'idle' | 'signing' | 'executing' | 'confirmed' | 'error'
  error?: string
}

export function SigningStatus({ signer, stage, error }: SigningStatusProps) {
  if (stage === 'idle') return null

  let text = ''

  if (stage === 'signing') {
    text =
      signer?.type === 'passkey'
        ? 'Waiting for Face ID or Touch ID...'
        : 'Confirm the transaction in your wallet...'
  } else if (stage === 'executing') {
    text =
      signer?.type === 'passkey'
        ? 'Submitting via Haven relayer...'
        : 'Submitting transaction...'
  } else if (stage === 'confirmed') {
    text = 'Confirmed.'
  } else if (stage === 'error') {
    text = error ?? ''
  }

  if (!text) return null

  const tone =
    stage === 'error'
      ? 'text-red-400'
      : stage === 'confirmed'
        ? 'text-emerald-400'
        : 'text-zinc-300'

  return <p className={`text-sm ${tone}`}>{text}</p>
}
