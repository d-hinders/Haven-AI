import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreatePasskey = vi.fn()
const mockEnrollPasskey = vi.fn()
const mockDeployPasskeySafe = vi.fn()
const mockListPasskeys = vi.fn()
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
import { PasskeyCancelledError } from '@/lib/passkey'
import PasskeyEnrollFlow from '@/app/onboarding/PasskeyEnrollFlow'

const mockUser = {
  id: 'user-1',
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

    fireEvent.click(screen.getByRole('button', { name: 'Use Face ID / Touch ID' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({
      safeAddress: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
      txHash: `0x${'ab'.repeat(32)}`,
    }))

    expect(mockCreatePasskey).toHaveBeenCalledTimes(1)
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
      name: 'gnosis',
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

    fireEvent.click(screen.getByRole('button', { name: 'Use Face ID / Touch ID' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Use Face ID / Touch ID' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    expect(mockListPasskeys).toHaveBeenCalled()
    expect(mockDeployPasskeySafe).toHaveBeenCalledWith({ chain_id: 100 })
  })

  it('fails fast when the existing passkey belongs to another device', async () => {
    const onComplete = vi.fn()
    const onError = vi.fn()
    mockEnrollPasskey.mockRejectedValue(new ApiRequestError('A passkey is already registered for this chain', 409))
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

    fireEvent.click(screen.getByRole('button', { name: 'Use Face ID / Touch ID' }))

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'You already enrolled a passkey on another device. Sign in there to continue.',
      ),
    )
    expect(onComplete).not.toHaveBeenCalled()
    expect(mockDeployPasskeySafe).not.toHaveBeenCalled()
    expect(
      localStorage.getItem(
        passkeyStorageKey('0x07058311f995c89F4DbE17Db61fa1A3CDe638975', 100),
      ),
    ).toBeNull()
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

    fireEvent.click(screen.getByRole('button', { name: 'Use Face ID / Touch ID' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Use Face ID / Touch ID' }))

    await waitFor(() => {
      const stored = localStorage.getItem(
        passkeyStorageKey('0x07058311f995c89F4DbE17Db61fa1A3CDe638975', 100),
      )
      expect(stored).toContain('"schemaVersion":1')
      expect(stored).toContain('"credentialId":"credential-123"')
    })
  })
})
