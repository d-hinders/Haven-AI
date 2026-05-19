import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeAbiParameters,
  hexToBytes,
  stringToHex,
  type Address,
} from 'viem'

const mockGetPasskeyAssertion = vi.fn()

vi.mock('@/lib/passkey', () => ({
  getPasskeyAssertion: (...args: unknown[]) => mockGetPasskeyAssertion(...args),
}))

import { signSafeHashWithPasskey } from '@/lib/passkey-sign'

const SIGNER_ADDRESS = '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2' as Address
const SAFE_TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`

describe('signSafeHashWithPasskey', () => {
  beforeEach(() => {
    mockGetPasskeyAssertion.mockReset()
  })

  it('encodes a Safe contract signature from a WebAuthn assertion', async () => {
    mockGetPasskeyAssertion.mockResolvedValue({
      credentialId: 'credential-123',
      authenticatorData: '0x11223344',
      clientDataJSON: stringToHex(
        '{"type":"webauthn.get","challenge":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","origin":"https://haven.test","crossOrigin":false}',
      ),
      signatureDER: '0x30080202012302020345',
    })

    const result = await signSafeHashWithPasskey({
      signer: {
        type: 'passkey',
        address: SIGNER_ADDRESS,
        credentialId: 'credential-123',
        publicKey: {
          x: `0x${'11'.repeat(32)}`,
          y: `0x${'22'.repeat(32)}`,
        },
        chainId: 100,
      },
      safeTxHash: SAFE_TX_HASH,
    })

    expect(mockGetPasskeyAssertion).toHaveBeenCalledWith({
      challenge: hexToBytes(SAFE_TX_HASH),
      allowCredentialIds: ['credential-123'],
    })

    const innerSignature = encodeAbiParameters(
      [
        { name: 'authenticatorData', type: 'bytes' },
        { name: 'clientDataFields', type: 'string' },
        { name: 'r', type: 'uint256' },
        { name: 's', type: 'uint256' },
      ],
      [
        '0x11223344',
        '"origin":"https://haven.test","crossOrigin":false',
        0x123n,
        0x345n,
      ],
    )

    const expectedSignature =
      `0x${'0'.repeat(24)}${SIGNER_ADDRESS.slice(2)}` +
      `${'0'.repeat(62)}41` +
      '00' +
      `${(innerSignature.length / 2 - 1).toString(16).padStart(64, '0')}` +
      innerSignature.slice(2)

    expect(result.signature).toBe(expectedSignature)
  })

  it('throws when clientDataJSON does not include a challenge field in the expected shape', async () => {
    mockGetPasskeyAssertion.mockResolvedValue({
      credentialId: 'credential-123',
      authenticatorData: '0x11223344',
      clientDataJSON: stringToHex('{"type":"webauthn.get","origin":"https://haven.test"}'),
      signatureDER: '0x30080202012302020345',
    })

    await expect(
      signSafeHashWithPasskey({
        signer: {
          type: 'passkey',
          address: SIGNER_ADDRESS,
          credentialId: 'credential-123',
          publicKey: {
            x: `0x${'11'.repeat(32)}`,
            y: `0x${'22'.repeat(32)}`,
          },
          chainId: 100,
        },
        safeTxHash: SAFE_TX_HASH,
      }),
    ).rejects.toThrow('challenge not found in clientDataJSON')
  })
})
