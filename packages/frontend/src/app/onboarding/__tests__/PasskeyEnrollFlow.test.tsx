import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreatePasskey = vi.fn()
const mockGetPasskeyAssertion = vi.fn()
const mockEnrollPasskey = vi.fn()
const mockDeployPasskeySafe = vi.fn()
const mockListPasskeys = vi.fn()
const mockPost = vi.fn()

vi.mock('@/lib/passkey', async () => {
  const actual = await vi.importActual<typeof import('@/lib/passkey')>('@/lib/passkey')
  return {
    ...actual,
    createPasskey: (...args: unknown[]) => mockCreatePasskey(...args),
    getPasskeyAssertion: (...args: unknown[]) => mockGetPasskeyAssertion(...args),
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      enrollPasskey: (...args: unknown[]) => mockEnrollPasskey(...args),
      deployPasskeySafe: (...args: unknown[]) => mockDeployPasskeySafe(...args),
      listPasskeys: (...args: unknown[]) => mockListPasskeys(...args),
      post: (...args: unknown[]) => mockPost(...args),
    },
  }
})

import { ApiRequestError } from '@/lib/api'
import { passkeyStorageKey } from '@/lib/signer'
import { PasskeyCancelledError, PasskeyUnsupportedError } from '@/lib/passkey'
import { PASSKEY_REQUIRED_MESSAGE } from '@/app/onboarding/copy'
import PasskeyEnrollFlow from '@/app/onboarding/PasskeyEnrollFlow'

const mockUser = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'passkey@example.com',
  wallet_address: null,
  safe_address: null,
  safes: [],
}

const createdPasskey = {
  credentialId: 'credential-123',
  publicKey: {
    x: `0x${'11'.repeat(32)}` as `0x${string}`,
    y: `0x${'22'.repeat(32)}` as `0x${string}`,
  },
  rawAttestationObject: Uint8Array.from([1, 2, 3]).buffer,
  rawClientDataJSON: Uint8Array.from([4, 5, 6]).buffer,
}

describe('PasskeyEnrollFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreatePasskey.mockResolvedValue(createdPasskey)
    mockEnrollPasskey.mockResolvedValue({
      id: 'passkey-1',
      credential_id: 'credential-123',
      signer_address: '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
      chain_id: 100,
    })
    mockDeployPasskeySafe.mockResolvedValue({
      safe_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
      tx_hash: `0x${'ab'.repeat(32)}`,
      chain_id: 100,
    })
    mockListPasskeys.mockResolvedValue({ passkeys: [] })
    mockGetPasskeyAssertion.mockResolvedValue({
      credentialId: 'credential-123',
    })
    mockPost.mockResolvedValue({
      id: 'safe-1',
      safe_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
      chain_id: 100,
      name: 'gnosis',
      is_default: true,
      created_at: '2026-05-04T00:00:00.000Z',
    })
  })

  it('creates, enrolls, deploys, registers, and completes the passkey flow', async () => {
    const onComplete = vi.fn()
    const onError = vi.fn()

    render(
      <PasskeyEnrollFlow
        user={mockUser}
        selectedChainId={100}
        onComplete={onComplete}
        onError={onError}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create account with Face ID / Touch ID' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({
      safeAddress: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
      txHash: `0x${'ab'.repeat(32)}`,
    }))

    expect(mockCreatePasskey).toHaveBeenCalledTimes(1)
    expect(mockCreatePasskey).toHaveBeenCalledWith(expect.objectContaining({
      userName: 'passkey@example.com',
      userDisplayName: 'Ada Lovelace',
    }))
    expect(mockEnrollPasskey).toHaveBeenCalledWith({
      credential_id: 'credential-123',
      public_key_x: createdPasskey.publicKey.x,
      public_key_y: createdPasskey.publicKey.y,
      chain_id: 100,
      raw_attestation_object: 'AQID',
    })
    expect(mockDeployPasskeySafe).toHaveBeenCalledWith({ chain_id: 100 })
    expect(mockPost).toHaveBeenCalledWith('/user/safes', {
      safe_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
      chain_id: 100,
    })

    expect(mockCreatePasskey.mock.invocationCallOrder[0]).toBeLessThan(mockEnrollPasskey.mock.invocationCallOrder[0])
    expect(mockEnrollPasskey.mock.invocationCallOrder[0]).toBeLessThan(mockDeployPasskeySafe.mock.invocationCallOrder[0])
    expect(mockDeployPasskeySafe.mock.invocationCallOrder[0]).toBeLessThan(mockPost.mock.invocationCallOrder[0])
  })

  it('reports passkey cancellation without calling the API', async () => {
    const onComplete = vi.fn()
    const onError = vi.fn()
    mockCreatePasskey.mockRejectedValue(new PasskeyCancelledError())

    render(
      <PasskeyEnrollFlow
        user={mockUser}
        selectedChainId={100}
        onComplete={onComplete}
        onError={onError}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create account with Face ID / Touch ID' }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Face ID prompt was cancelled.'))
    expect(mockEnrollPasskey).not.toHaveBeenCalled()
    expect(mockDeployPasskeySafe).not.toHaveBeenCalled()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('recovers from enroll conflicts by reusing the existing passkey row', async () => {
    const onComplete = vi.fn()
    mockEnrollPasskey.mockRejectedValue(new ApiRequestError('A passkey is already registered for this chain', 409))
    mockListPasskeys.mockResolvedValue({
      passkeys: [
        {
          id: 'passkey-1',
          credential_id: 'credential-123',
          signer_address: '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
          chain_id: 100,
          safe_address: null,
          created_at: '2026-05-04T00:00:00.000Z',
        },
      ],
    })

    render(
      <PasskeyEnrollFlow
        user={mockUser}
        selectedChainId={100}
        onComplete={onComplete}
        onError={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create account with Face ID / Touch ID' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    expect(mockListPasskeys).toHaveBeenCalled()
    expect(mockDeployPasskeySafe).toHaveBeenCalledWith({ chain_id: 100 })
  })

  it('RESUMES with the enrolled passkey instead of creating a new one (#1229)', async () => {
    // The exact scenario hit live: the account already has a passkey for the
    // chain and local state is gone. The flow must ask the authenticator to
    // CONFIRM the enrolled credential — never mint a fresh one, whose id can
    // only mismatch.
    const onComplete = vi.fn()
    mockListPasskeys.mockResolvedValue({
      passkeys: [
        {
          id: 'passkey-1',
          credential_id: 'credential-123',
          signer_address: '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
          chain_id: 100,
          safe_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
          created_at: '2026-05-04T00:00:00.000Z',
        },
      ],
    })

    render(
      <PasskeyEnrollFlow
        user={mockUser}
        selectedChainId={100}
        onComplete={onComplete}
        onError={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create account with Face ID / Touch ID' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({
      safeAddress: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
      txHash: `0x${'0'.repeat(64)}`,
    }))
    expect(mockCreatePasskey).not.toHaveBeenCalled()
    expect(mockEnrollPasskey).not.toHaveBeenCalled()
    expect(mockGetPasskeyAssertion).toHaveBeenCalledWith(
      expect.objectContaining({ allowCredentialIds: ['credential-123'] }),
    )
  })

  it('reports honestly when the enrolled passkey cannot be confirmed on this device (#1229)', async () => {
    const onComplete = vi.fn()
    const onError = vi.fn()
    mockGetPasskeyAssertion.mockRejectedValue(new PasskeyCancelledError('no credential here'))
    mockListPasskeys.mockResolvedValue({
      passkeys: [
        {
          id: 'passkey-1',
          credential_id: 'credential-other-device',
          signer_address: '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
          chain_id: 100,
          safe_address: null,
          created_at: '2026-05-04T00:00:00.000Z',
        },
      ],
    })

    render(
      <PasskeyEnrollFlow
        user={mockUser}
        selectedChainId={100}
        onComplete={onComplete}
        onError={onError}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create account with Face ID / Touch ID' }))

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'This account already has a passkey for this network, but this device could not confirm it. Try again here, or open Haven where the passkey was created.',
      ),
    )
    expect(mockCreatePasskey).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
    expect(mockDeployPasskeySafe).not.toHaveBeenCalled()
    expect(
      localStorage.getItem(
        passkeyStorageKey('0x07058311f995c89F4DbE17Db61fa1A3CDe638975', 100),
      ),
    ).toBeNull()
  })

  it('handles the enroll race window with the corrected cross-device copy (#1229)', async () => {
    // Resume ran against an empty list, then another tab/device enrolled
    // before our insert landed: 409, and the re-listed credential is not
    // ours. The message must not say "sign in" — the user IS signed in.
    const onComplete = vi.fn()
    const onError = vi.fn()
    mockEnrollPasskey.mockRejectedValue(new ApiRequestError('A passkey is already registered for this chain', 409))
    mockListPasskeys
      .mockResolvedValueOnce({ passkeys: [] })
      .mockResolvedValueOnce({
        passkeys: [
          {
            id: 'passkey-1',
            credential_id: 'credential-other-device',
            signer_address: '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
            chain_id: 100,
            safe_address: null,
            created_at: '2026-05-04T00:00:00.000Z',
          },
        ],
      })

    render(
      <PasskeyEnrollFlow
        user={mockUser}
        selectedChainId={100}
        onComplete={onComplete}
        onError={onError}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create account with Face ID / Touch ID' }))

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'This account already has a passkey for this network. Open Haven in the browser or on the device where it was created to continue.',
      ),
    )
    expect(onComplete).not.toHaveBeenCalled()
    expect(mockDeployPasskeySafe).not.toHaveBeenCalled()
  })

  it('recovers from deploy conflicts by reusing the existing safe address', async () => {
    const onComplete = vi.fn()
    mockDeployPasskeySafe.mockRejectedValue(new ApiRequestError('A Safe is already deployed for this passkey', 409))
    mockListPasskeys.mockResolvedValue({
      passkeys: [
        {
          id: 'passkey-1',
          credential_id: 'credential-123',
          signer_address: '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
          chain_id: 100,
          safe_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
          created_at: '2026-05-04T00:00:00.000Z',
        },
      ],
    })

    render(
      <PasskeyEnrollFlow
        user={mockUser}
        selectedChainId={100}
        onComplete={onComplete}
        onError={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create account with Face ID / Touch ID' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({
      safeAddress: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
      txHash: `0x${'0'.repeat(64)}`,
    }))
  })

  it('writes the expected passkey entry to localStorage after completion', async () => {
    render(
      <PasskeyEnrollFlow
        user={mockUser}
        selectedChainId={100}
        onComplete={vi.fn()}
        onError={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create account with Face ID / Touch ID' }))

    await waitFor(() => {
      const stored = localStorage.getItem(
        passkeyStorageKey('0x07058311f995c89F4DbE17Db61fa1A3CDe638975', 100),
      )
      expect(stored).toContain('"schemaVersion":1')
      expect(stored).toContain('"credentialId":"credential-123"')
    })
  })

  it('offers no retry when the browser cannot create a passkey (#1162)', async () => {
    const onError = vi.fn()
    mockCreatePasskey.mockRejectedValue(new PasskeyUnsupportedError())

    render(
      <PasskeyEnrollFlow
        user={mockUser}
        selectedChainId={100}
        onComplete={vi.fn()}
        onError={onError}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create account with Face ID / Touch ID' }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith(PASSKEY_REQUIRED_MESSAGE))
    // An honest dead end: no "Try again" that could only fail the same way,
    // and no wallet fallback anywhere on the screen.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(document.body.textContent).not.toMatch(/connect a wallet/i)
  })
})
