import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreatePasskey = vi.fn()
const mockPost = vi.fn()

vi.mock('@/lib/passkey', async () => {
  const actual = await vi.importActual<typeof import('@/lib/passkey')>('@/lib/passkey')
  return {
    ...actual,
    createPasskey: (...args: unknown[]) => mockCreatePasskey(...args),
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { post: (...args: unknown[]) => mockPost(...args) },
  }
})

import { PasskeyCancelledError, base64UrlEncode } from '@/lib/passkey'
import HybridEnrollFlow from '@/app/onboarding/HybridEnrollFlow'

const mockUser = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'hybrid@example.com',
  wallet_address: null,
  safe_address: null,
  safes: [],
}

// Raw credential id bytes ↔ the formats the flow must produce.
const RAW_ID = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
const CREATED = {
  credentialId: base64UrlEncode(RAW_ID),
  publicKey: { x: '0x' + '11'.repeat(32), y: '0x' + '22'.repeat(32) },
  rawAttestationObject: new Uint8Array(),
  rawClientDataJSON: new Uint8Array(),
}
const ACCOUNT = '0x' + 'aa'.repeat(20)

function renderFlow(onComplete = vi.fn(), onError = vi.fn()) {
  render(
    <HybridEnrollFlow
      user={mockUser as never}
      selectedChainId={84532}
      onComplete={onComplete}
      onError={onError}
    />,
  )
  return { onComplete, onError }
}

beforeEach(() => {
  mockCreatePasskey.mockReset()
  mockPost.mockReset()
  window.localStorage.clear()
})

describe('HybridEnrollFlow (#886)', () => {
  it('creates the passkey and registers the Hybrid — key_id is hex of the raw credential id', async () => {
    mockCreatePasskey.mockResolvedValue(CREATED)
    mockPost.mockResolvedValue({ account_address: ACCOUNT })
    const { onComplete } = renderFlow()

    fireEvent.click(screen.getByRole('button', { name: /Face ID/ }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ accountAddress: ACCOUNT }))

    expect(mockPost).toHaveBeenCalledWith('/accounts/hybrid', {
      chain_id: 84532,
      passkeys: [{ key_id: '0xdeadbeef', x: CREATED.publicKey.x, y: CREATED.publicKey.y }],
    })
  })

  it('is one ceremony, zero transactions — no deploy call, no Safe registration', async () => {
    mockCreatePasskey.mockResolvedValue(CREATED)
    mockPost.mockResolvedValue({ account_address: ACCOUNT })
    renderFlow()

    fireEvent.click(screen.getByRole('button', { name: /Face ID/ }))
    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    // Exactly ONE api call: the account registration.
    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(mockCreatePasskey).toHaveBeenCalledTimes(1)
  })

  it('maps a cancelled Face ID prompt to friendly copy and resets', async () => {
    mockCreatePasskey.mockRejectedValue(new PasskeyCancelledError('cancelled'))
    const { onComplete, onError } = renderFlow()

    fireEvent.click(screen.getByRole('button', { name: /Face ID/ }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Face ID prompt was cancelled.'))
    expect(onComplete).not.toHaveBeenCalled()
    // Back to idle — the button is clickable again:
    expect(screen.getByRole('button', { name: /Face ID/ })).toBeTruthy()
  })

  it('never shows crypto jargon', () => {
    renderFlow()
    expect(document.body.textContent).not.toMatch(/wallet address|seed phrase required|gas|transaction|deploy|delegation|counterfactual/i)
  })
})
