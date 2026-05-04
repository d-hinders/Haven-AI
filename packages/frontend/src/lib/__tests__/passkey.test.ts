import { describe, expect, it } from 'vitest'

import {
  PasskeyUnsupportedError,
  base64UrlDecode,
  base64UrlEncode,
  createPasskey,
  decodeCoseP256PublicKey,
} from '@/lib/passkey'

describe('decodeCoseP256PublicKey', () => {
  it('decodes a valid EC2 P-256 COSE key', () => {
    const x = hexBytes('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff')
    const y = hexBytes('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100')

    expect(decodeCoseP256PublicKey(encodeCoseEc2Key({ x, y }))).toEqual({
      x: '0x11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff',
      y: '0xffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
    })
  })

  it('left-pads coordinates when an encoder strips leading zero bytes', () => {
    const x = hexBytes('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd')
    const y = hexBytes('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20')

    expect(decodeCoseP256PublicKey(encodeCoseEc2Key({ x, y }))).toEqual({
      x: '0x001234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
      y: '0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
    })
  })

  it('rejects non-EC2 keys', () => {
    expect(() =>
      decodeCoseP256PublicKey(
        encodeCborMap([
          [1, encodeUnsigned(1)],
          [3, encodeNegative(-7)],
          [-1, encodeNegative(-2)],
          [-2, encodeBytes(hexBytes('11'.repeat(32)))],
          [-3, encodeBytes(hexBytes('22'.repeat(32)))],
        ]),
      ),
    ).toThrow(/kty=2/)
  })

  it('rejects non-P-256 curves', () => {
    expect(() =>
      decodeCoseP256PublicKey(
        encodeCborMap([
          [1, encodeUnsigned(2)],
          [3, encodeNegative(-7)],
          [-1, encodeUnsigned(2)],
          [-2, encodeBytes(hexBytes('11'.repeat(32)))],
          [-3, encodeBytes(hexBytes('22'.repeat(32)))],
        ]),
      ),
    ).toThrow(/crv=1/)
  })

  it('rejects non-ES256 algorithms', () => {
    expect(() =>
      decodeCoseP256PublicKey(
        encodeCoseEc2Key({
          x: hexBytes('11'.repeat(32)),
          y: hexBytes('22'.repeat(32)),
          alg: -8,
        }),
      ),
    ).toThrow(/alg=-7/)
  })
})

describe('base64Url helpers', () => {
  it.each([0, 1, 16, 32, 45])('round-trips %s-byte inputs', (length) => {
    const input = new Uint8Array(length)

    for (let i = 0; i < input.length; i += 1) {
      input[i] = i
    }

    expect(base64UrlDecode(base64UrlEncode(input))).toEqual(input)
  })
})

describe('createPasskey', () => {
  it('throws PasskeyUnsupportedError when navigator.credentials is unavailable', async () => {
    const originalCredentials = navigator.credentials

    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: undefined,
    })

    await expect(
      createPasskey({
        userId: new Uint8Array(16),
        userName: 'codex@example.com',
        userDisplayName: 'Codex Tester',
      }),
    ).rejects.toBeInstanceOf(PasskeyUnsupportedError)

    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: originalCredentials,
    })
  })
})

function encodeCoseEc2Key(args: {
  x: Uint8Array
  y: Uint8Array
  alg?: number
  crv?: number
}): Uint8Array {
  return encodeCborMap([
    [1, encodeUnsigned(2)],
    [3, encodeNegative(args.alg ?? -7)],
    [-1, encodeUnsigned(args.crv ?? 1)],
    [-2, encodeBytes(args.x)],
    [-3, encodeBytes(args.y)],
  ])
}

function encodeCborMap(entries: Array<[number, Uint8Array]>): Uint8Array {
  return concatBytes(
    encodeMajorLength(5, entries.length),
    ...entries.flatMap(([key, value]) => [encodeInteger(key), value]),
  )
}

function encodeInteger(value: number): Uint8Array {
  return value >= 0 ? encodeUnsigned(value) : encodeNegative(value)
}

function encodeUnsigned(value: number): Uint8Array {
  return encodeMajorLength(0, value)
}

function encodeNegative(value: number): Uint8Array {
  return encodeMajorLength(1, -1 - value)
}

function encodeBytes(value: Uint8Array): Uint8Array {
  return concatBytes(encodeMajorLength(2, value.length), value)
}

function encodeMajorLength(majorType: number, length: number): Uint8Array {
  if (length < 24) {
    return Uint8Array.of((majorType << 5) | length)
  }

  if (length < 256) {
    return Uint8Array.of((majorType << 5) | 24, length)
  }

  throw new Error(`Unsupported test CBOR length: ${length}`)
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const bytes = new Uint8Array(totalLength)
  let offset = 0

  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }

  return bytes
}

function hexBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(normalized.length / 2)

  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16)
  }

  return bytes
}
