import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreatePasskey = vi.fn()
const mockEnrollPasskey = vi.fn()

vi.mock('@/lib/passkey', () => ({
  createPasskey: (...a: unknown[]) => mockCreatePasskey(...a),
  base64UrlEncode: () => 'b64-attestation',
}))
vi.mock('@/lib/api', () => ({
  api: { enrollPasskey: (...a: unknown[]) => mockEnrollPasskey(...a) },
}))
vi.mock('@/lib/user', () => ({ displayName: () => 'Ada Lovelace' }))

import { provisionPasskeyApprover } from '@/lib/passkey-approver'

const USER = { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' } as never

describe('provisionPasskeyApprover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreatePasskey.mockResolvedValue({
      credentialId: 'cred-123',
      publicKey: { x: '0xaa', y: '0xbb' },
      rawAttestationObject: new Uint8Array([1, 2, 3]).buffer,
    })
    mockEnrollPasskey.mockResolvedValue({
      id: 'pk-1',
      credential_id: 'cred-123',
      signer_address: '0x9999999999999999999999999999999999999999',
      chain_id: 8453,
    })
  })

  it('creates a passkey, enrols it for the chain, and returns the signer address', async () => {
    const result = await provisionPasskeyApprover({ user: USER, chainId: 8453 })

    expect(result).toEqual({ signerAddress: '0x9999999999999999999999999999999999999999' })
    expect(mockCreatePasskey).toHaveBeenCalledWith(
      expect.objectContaining({ userName: 'ada@example.com', userDisplayName: 'Ada Lovelace' }),
    )
    expect(mockEnrollPasskey).toHaveBeenCalledWith(
      expect.objectContaining({
        credential_id: 'cred-123',
        public_key_x: '0xaa',
        public_key_y: '0xbb',
        chain_id: 8453,
        raw_attestation_object: 'b64-attestation',
      }),
    )
  })

  it('propagates a passkey creation failure (e.g. user cancelled)', async () => {
    mockCreatePasskey.mockRejectedValueOnce(new Error('cancelled'))
    await expect(provisionPasskeyApprover({ user: USER, chainId: 8453 })).rejects.toThrow('cancelled')
    expect(mockEnrollPasskey).not.toHaveBeenCalled()
  })
})
