import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGet, mockPost, mockSignUserOp, mockSigner, mockOnDevice } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockSignUserOp: vi.fn(),
  mockSigner: vi.fn(),
  mockOnDevice: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: { get: mockGet, post: mockPost } }))
vi.mock('@/lib/signer', () => ({
  useActiveSigner: () => mockSigner(),
  hasPasskeyCredentialOnDevice: (id: string) => mockOnDevice(id),
  credentialIdFromKeyId: (k: string) => k,
}))
vi.mock('@/lib/delegationPasskeySigner', () => ({ signUserOpWithPasskey: mockSignUserOp }))

const { useAccountSigners } = await import('@/hooks/useAccountSigners')

const SAFE_ADDRESS = '0x' + 'aa'.repeat(20)
const SIGNERS = {
  account_address: SAFE_ADDRESS,
  chain_id: 84532,
  owner_address: null,
  passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
}

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockSignUserOp.mockReset()
  mockSigner.mockReset()
  mockSigner.mockReturnValue(null)
  mockOnDevice.mockReset()
  mockOnDevice.mockReturnValue(false)
  mockGet.mockResolvedValue(SIGNERS)
})

// #1089: a zero-agent account needs its own path to enrol a backup signer —
// the #1081 backend routes are account-scoped, so this hook must be too.
describe('useAccountSigners is account-scoped (#1089)', () => {
  it('loads the signer set from the account-scoped route, not the agent-scoped one', async () => {
    renderHook(() => useAccountSigners(SAFE_ADDRESS, 84532, 'x@y.z'))
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith(`/accounts/hybrid/${SAFE_ADDRESS}/signers?chain_id=84532`),
    )
  })

  it('surfaces a retryable error instead of hiding a failed fetch forever', async () => {
    mockGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useAccountSigners(SAFE_ADDRESS, 84532, 'x@y.z'))
    await waitFor(() => expect(result.current.loadError).toBe(true))
    expect(result.current.signers).toBeNull()
  })

  it('prepares and submits a signer change against the account, never an agent', async () => {
    mockPost.mockImplementation((url: string) => {
      if (url.includes('/prepare')) {
        return Promise.resolve({ signature_scheme: 'webauthn_userop', user_operation: { nonce: '1n' } })
      }
      return Promise.resolve({ updated: true })
    })
    mockSignUserOp.mockResolvedValue('0x' + 'ab'.repeat(200))

    const { result } = renderHook(() => useAccountSigners(SAFE_ADDRESS, 84532, 'x@y.z'))
    await waitFor(() => expect(result.current.ready).toBe(true))

    await act(async () => {
      const res = await result.current.removePasskey(SIGNERS.passkeys[0].key_id)
      expect(res.ok).toBe(true)
    })

    expect(mockPost).toHaveBeenCalledWith(
      `/accounts/hybrid/${SAFE_ADDRESS}/signers/prepare?chain_id=84532`,
      expect.objectContaining({ action: 'remove_passkey' }),
    )
    expect(mockPost).toHaveBeenCalledWith(
      `/accounts/hybrid/${SAFE_ADDRESS}/signers/submit?chain_id=84532`,
      expect.objectContaining({ action: 'remove_passkey', signature: '0x' + 'ab'.repeat(200) }),
    )
    expect(mockPost.mock.calls.every(([url]) => !String(url).startsWith('/agents/'))).toBe(true)
  })
})
