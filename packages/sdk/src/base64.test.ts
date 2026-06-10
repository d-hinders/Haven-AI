/**
 * Tests for the shared runtime-agnostic base64 helpers (#325).
 *
 * Both runtime paths are exercised: the Node path (Buffer present, the
 * default in this test runner) and the Web path (Buffer stubbed away so the
 * TextEncoder/atob/btoa branch runs). Cross-path tests assert the two
 * implementations are byte-identical — that equivalence IS the wire
 * compatibility contract between the SDK and the edge signer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeBase64Json,
  decodeBase64Utf8,
  encodeBase64Json,
  encodeBase64Utf8,
} from './base64.js'

// Strings chosen to break naive btoa(JSON.stringify(...)) implementations:
// multibyte UTF-8, emoji (surrogate pairs), and RTL text.
const UTF8_SAMPLES = [
  'plain ascii',
  'svenska åäö ÅÄÖ',
  'emoji 🤖💸 and astral 𝔘𝔫𝔦𝔠𝔬𝔡𝔢',
  'عربي and 中文 and 한국어',
  '', // empty string round-trips too
]

/** Run `fn` with Buffer hidden so the Web (TextEncoder/atob/btoa) path runs. */
function withoutBuffer<T>(fn: () => T): T {
  vi.stubGlobal('Buffer', undefined)
  try {
    return fn()
  } finally {
    vi.unstubAllGlobals()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('encodeBase64Utf8 / decodeBase64Utf8', () => {
  it('round-trips UTF-8 on the Node (Buffer) path', () => {
    for (const sample of UTF8_SAMPLES) {
      expect(decodeBase64Utf8(encodeBase64Utf8(sample))).toBe(sample)
    }
  })

  it('round-trips UTF-8 on the Web (TextEncoder/atob/btoa) path', () => {
    withoutBuffer(() => {
      for (const sample of UTF8_SAMPLES) {
        expect(decodeBase64Utf8(encodeBase64Utf8(sample))).toBe(sample)
      }
    })
  })

  it('produces byte-identical output on both runtime paths', () => {
    for (const sample of UTF8_SAMPLES) {
      const nodeEncoded = encodeBase64Utf8(sample)
      const webEncoded = withoutBuffer(() => encodeBase64Utf8(sample))
      expect(webEncoded).toBe(nodeEncoded)
    }
  })

  it('decodes output from either path on the other path', () => {
    for (const sample of UTF8_SAMPLES) {
      const nodeEncoded = encodeBase64Utf8(sample)
      expect(withoutBuffer(() => decodeBase64Utf8(nodeEncoded))).toBe(sample)

      const webEncoded = withoutBuffer(() => encodeBase64Utf8(sample))
      expect(decodeBase64Utf8(webEncoded)).toBe(sample)
    }
  })

  it('always emits standard base64 (x402 reference validator compatible)', () => {
    // The x402 reference implementation validates against /^[A-Za-z0-9+/]*={0,2}$/.
    const x402HeaderShape = /^[A-Za-z0-9+/]*={0,2}$/
    for (const sample of UTF8_SAMPLES) {
      expect(encodeBase64Utf8(sample)).toMatch(x402HeaderShape)
      expect(withoutBuffer(() => encodeBase64Utf8(sample))).toMatch(x402HeaderShape)
    }
  })

  it('tolerates URL-safe alphabet and missing padding on decode (both paths)', () => {
    // 'subjects?_d' encodes to 'c3ViamVjdHM/X2Q=' in standard base64 —
    // 'c3ViamVjdHM_X2Q' is the same payload URL-safe and unpadded.
    const standard = encodeBase64Utf8('subjects?_d')
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(urlSafe).not.toBe(standard)

    expect(decodeBase64Utf8(urlSafe)).toBe('subjects?_d')
    expect(withoutBuffer(() => decodeBase64Utf8(urlSafe))).toBe('subjects?_d')
  })
})

describe('encodeBase64Json / decodeBase64Json', () => {
  it('round-trips JSON values with non-ASCII content on both paths', () => {
    const payload = {
      x402Version: 2,
      description: 'köp en låt 🎵',
      nested: { amounts: ['20000', '1'], ok: true },
    }

    expect(decodeBase64Json(encodeBase64Json(payload))).toEqual(payload)
    withoutBuffer(() => {
      expect(decodeBase64Json(encodeBase64Json(payload))).toEqual(payload)
    })
  })

  it('wraps decode failures with the label when one is provided', () => {
    expect(() => decodeBase64Json('!!not-base64-json!!', 'PAYMENT-REQUIRED header')).toThrow(
      'Failed to decode PAYMENT-REQUIRED header',
    )
  })

  it('rethrows the raw error when no label is provided', () => {
    expect(() => decodeBase64Json('!!not-base64-json!!')).toThrow()
    expect(() => decodeBase64Json('!!not-base64-json!!')).not.toThrow('Failed to decode')
  })
})
