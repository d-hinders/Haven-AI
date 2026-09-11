import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  CURRENT_KEY_VERSION,
  PLAINTEXT_KEY_VERSION,
  SECRETS_KEY_ENV,
  SecretsKeyInvalidError,
  SecretsKeyMissingError,
  decryptSecrets,
  encryptSecrets,
  plaintextSecrets,
  secretsKeyConfigured,
} from '../secrets.js'

const KEY = randomBytes(32).toString('base64')
const withKey = { [SECRETS_KEY_ENV]: KEY } as NodeJS.ProcessEnv
const noKey = {} as NodeJS.ProcessEnv
const SECRETS = { accessToken: 'at-1', refreshToken: 'rt-1', scope: 'bookkeeping' }

describe('provider secrets at rest (#2860)', () => {
  it('round-trips through encrypt/decrypt and records the current key version', () => {
    const { ciphertext, keyVersion } = encryptSecrets(SECRETS, withKey)
    expect(keyVersion).toBe(CURRENT_KEY_VERSION)
    expect(decryptSecrets(ciphertext, keyVersion, withKey)).toEqual(SECRETS)
  })

  it('never stores the plaintext: the token strings do not appear in the blob', () => {
    // The assertion that makes "encrypted" a measurement rather than a name.
    const { ciphertext } = encryptSecrets(SECRETS, withKey)
    const asText = ciphertext.toString('latin1')
    expect(asText).not.toContain('at-1')
    expect(asText).not.toContain('rt-1')
    expect(asText).not.toContain('accessToken')
  })

  it('uses a fresh IV every time: the same input encrypts to different bytes', () => {
    // GCM is broken by IV reuse under one key. Two encryptions of identical
    // input must differ in the first 12 bytes; if they ever match, the IV is
    // being derived rather than drawn.
    const a = encryptSecrets(SECRETS, withKey).ciphertext
    const b = encryptSecrets(SECRETS, withKey).ciphertext
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false)
    expect(a.equals(b)).toBe(false)
  })

  it('FAILS CLOSED: encrypting without a key throws, and nothing is returned', () => {
    expect(() => encryptSecrets(SECRETS, noKey)).toThrow(SecretsKeyMissingError)
    expect(secretsKeyConfigured(noKey)).toBe(false)
    expect(secretsKeyConfigured(withKey)).toBe(true)
  })

  it('reads a version-0 (plaintext) row WITHOUT a key — the asymmetry is the point', () => {
    // A row the migration copied as-is must decrypt on a replica that has
    // no key yet, or "no key configured" becomes "the feed is down".
    const { ciphertext, keyVersion } = plaintextSecrets(SECRETS)
    expect(keyVersion).toBe(PLAINTEXT_KEY_VERSION)
    expect(decryptSecrets(ciphertext, keyVersion, noKey)).toEqual(SECRETS)
  })

  it('a version-0 row and a version-1 row decrypt to structurally identical objects', () => {
    const v0 = decryptSecrets(plaintextSecrets(SECRETS).ciphertext, PLAINTEXT_KEY_VERSION, withKey)
    const { ciphertext } = encryptSecrets(SECRETS, withKey)
    const v1 = decryptSecrets(ciphertext, CURRENT_KEY_VERSION, withKey)
    expect(v0).toEqual(v1)
  })

  it('a tampered blob is refused, not decrypted to garbage', () => {
    const { ciphertext, keyVersion } = encryptSecrets(SECRETS, withKey)
    const tampered = Buffer.from(ciphertext)
    tampered[tampered.length - 1] ^= 0x01 // flip one ciphertext bit
    expect(() => decryptSecrets(tampered, keyVersion, withKey)).toThrow()
  })

  it('a wrong key is refused', () => {
    const { ciphertext, keyVersion } = encryptSecrets(SECRETS, withKey)
    const other = { [SECRETS_KEY_ENV]: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv
    expect(() => decryptSecrets(ciphertext, keyVersion, other)).toThrow()
  })

  it('a truncated blob is refused before the cipher is even constructed', () => {
    expect(() => decryptSecrets(Buffer.alloc(5), CURRENT_KEY_VERSION, withKey)).toThrow(/too short/)
  })

  it('a wrong-length key is a config error, not a weaker cipher', () => {
    const short = { [SECRETS_KEY_ENV]: randomBytes(16).toString('base64') } as NodeJS.ProcessEnv
    expect(() => encryptSecrets(SECRETS, short)).toThrow(SecretsKeyInvalidError)
    expect(() => secretsKeyConfigured(short)).toThrow(SecretsKeyInvalidError)
  })

  it('an unknown key version is refused rather than guessed at', () => {
    const { ciphertext } = encryptSecrets(SECRETS, withKey)
    expect(() => decryptSecrets(ciphertext, 7, withKey)).toThrow(/Unknown secrets key version 7/)
  })
})
